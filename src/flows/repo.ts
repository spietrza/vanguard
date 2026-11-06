import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir } from '../core/state-path.js';
import { FLOWS } from '../api/capabilities.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import { emitFlowDoc } from './emit-doc.js';
import { STAGE_LIBRARY } from './library.js';
import { lowerFlow } from './lower.js';
import type { CustomProviderEntry } from '../agents/registry.js';
import type { FlowDoc, LoopDecl, StageDecl, StageOverrides } from './types.js';

/**
 * Repo flow discovery + resolution over `<repoPath>/.vanguard/flows/*.hcl` (S5). The parser is
 * imported LAZILY inside each function — @cdktf/hcl2json gunzips and instantiates its WASM at
 * module load, and neither the CLI (a run with no `--flow`) nor sidecar startup may pay that
 * (S5 Constraint 5; guarded by lazy-imports.test.ts).
 *
 * A user-fixable flow-file problem throws FlowError; the sidecar deps map it to a `bad-request`
 * envelope. Fs faults propagate untouched (→ `internal`).
 */
export class FlowError extends Error {}

/** One discovered flow file. `name` present ⇔ the file parsed (openable); `error` present ⇔ not runnable. */
export interface RepoFlowInfo {
  file: string;
  name?: string;
  label?: string;
  error?: string;
}

/** Filename rule: separators are excluded entirely, so `..` can never form a path segment. */
export const FLOW_FILE_RE = /^[a-z0-9][a-z0-9._-]*\.hcl$/;
/** Flow-name grammar — the filename rule minus the extension (write canonicalizes file = name.hcl). */
// The one repo-name grammar lives in src/wire.ts (S7).
export { FLOW_NAME_RE } from '../wire.js';
import { FLOW_NAME_RE } from '../wire.js';

const flowsDir = (repoPath: string): string => join(repoPath, '.vanguard', 'flows');

/**
 * The ONE semantic validity predicate — list, write, and the run fail-fast all apply it, so a flow
 * never lists as healthy yet fails at save or run. Pure: no I/O, no lowering, no dynamic import.
 */
export function flowDocError(doc: FlowDoc): string | undefined {
  if (!FLOW_NAME_RE.test(doc.name)) return `flow name "${doc.name}" must be lowercase [a-z0-9._-] starting with a letter or digit`;
  if (doc.stages.length === 0) return 'a flow needs at least one stage';
  for (const stage of doc.stages) {
    // Object.hasOwn, same as the FLOWS checks: STAGE_LIBRARY inherits Object.prototype, so a plain
    // lookup would accept a stage named "toString" here and lower it into a corrupt record later.
    if (stage.ref === undefined && !Object.hasOwn(STAGE_LIBRARY, stage.name)) {
      return `unknown stage "${stage.name}": not in the stage library and no ref given`;
    }
  }
  return undefined;
}

interface ScanEntry {
  file: string;
  doc?: FlowDoc;
  error?: string;
}

/** Read + parse every conforming `*.hcl` in the flows dir. Broken files become error entries, never throws. */
async function scanFlows(repoPath: string): Promise<ScanEntry[]> {
  let files: string[];
  try {
    files = await readdir(flowsDir(repoPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const hcl = files.filter((f) => f.endsWith('.hcl')).sort();
  if (hcl.length === 0) return [];
  // Import the parser only once there is something to parse — an empty/flow-less dir must not
  // pay the WASM instantiation (review #336 round 2).
  const { parseFlowHcl } = await import('./parse.js');
  const out: ScanEntry[] = [];
  for (const file of hcl) {
    if (!FLOW_FILE_RE.test(file)) {
      out.push({ file, error: 'file name must be lowercase [a-z0-9._-] ending in .hcl' });
      continue;
    }
    try {
      out.push({ file, doc: await parseFlowHcl(await readFile(join(flowsDir(repoPath), file), 'utf8')) });
    } catch (err) {
      out.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Discovery for the editor rail + run-builder dropdown (sidecar `listFlows`). */
export async function listRepoFlows(repoPath: string): Promise<RepoFlowInfo[]> {
  const entries = await scanFlows(repoPath);
  // Duplicate detection counts VALID declarations only — the same rule findDeclaring and
  // writeRepoFlow apply, so a broken twin surfaces its own validity error instead of turning the
  // healthy file into a "duplicate".
  const declared = new Map<string, number>();
  for (const e of entries) {
    if (e.doc !== undefined && flowDocError(e.doc) === undefined) {
      declared.set(e.doc.name, (declared.get(e.doc.name) ?? 0) + 1);
    }
  }
  return entries.map((e) => {
    if (e.doc === undefined) return { file: e.file, error: e.error ?? 'unreadable' };
    const { name, label } = e.doc;
    const error =
      flowDocError(e.doc) ??
      ((declared.get(name) ?? 0) > 1
        ? `duplicate flow "${name}": another file declares it too`
        : Object.hasOwn(FLOWS, name)
          ? `flow "${name}" shadows a built-in flow`
          : undefined);
    return { file: e.file, name, label, ...(error !== undefined ? { error } : {}) };
  });
}

/**
 * The single valid file declaring `name`, if any. Files that fail to parse or validate are ignored
 * (a broken scratch file must not brick unrelated flows); two VALID declarations throw — shared by
 * resolution and the fail-fast so the fail-fast cannot pass a run the runner will kill later.
 */
async function findDeclaring(name: string, repoPath: string): Promise<{ file: string; doc: FlowDoc } | undefined> {
  const entries = await scanFlows(repoPath);
  const matches = entries.filter(
    (e): e is Required<Pick<ScanEntry, 'file' | 'doc'>> =>
      e.doc !== undefined && e.doc.name === name && flowDocError(e.doc) === undefined,
  );
  if (matches.length > 1) {
    throw new FlowError(`flow "${name}" is declared in both ${matches[0]!.file} and ${matches[1]!.file}`);
  }
  return matches[0];
}

/** Resolve a repo flow to runnable stages, or undefined when no valid file declares the name. */
export async function resolveRepoFlow(
  name: string,
  repoPath: string,
  customProviders?: readonly CustomProviderEntry[],
): Promise<PipelineStage[] | undefined> {
  const match = await findDeclaring(name, repoPath);
  if (match === undefined) return undefined;
  return lowerFlow(match.doc, { repoPath, ...(customProviders !== undefined ? { customProviders } : {}) });
}

/** The unknown-flow error, listing built-ins + the repo's valid flow names. */
export async function unknownFlowError(name: string, repoPath: string): Promise<FlowError> {
  const entries = await scanFlows(repoPath);
  const repoNames = [
    ...new Set(
      entries
        .filter((e) => e.doc !== undefined && flowDocError(e.doc) === undefined)
        .map((e) => (e.doc as FlowDoc).name),
    ),
  ].filter((n) => !Object.hasOwn(FLOWS, n));
  const all = [...Object.keys(FLOWS), ...repoNames];
  return new FlowError(`unknown flow "${name}" — choose one of: ${all.join(', ')}`);
}

/**
 * Pure fail-fast for the sidecar createRun dep (S5 D6): built-in via Object.hasOwn (a plain lookup
 * would pass 'toString' and burn a sandbox), else a valid declaring file must exist. Never lowers,
 * never imports ref TS — repo code must not execute on the untimed run pipe before the run proper.
 */
export async function assertFlowResolvable(name: string, repoPath: string): Promise<void> {
  if (Object.hasOwn(FLOWS, name)) return;
  if ((await findDeclaring(name, repoPath)) === undefined) throw await unknownFlowError(name, repoPath);
}

/** Read one flow file: raw bytes + parsed doc. Returns the doc even when semantically invalid — the editor is how a broken flow gets fixed. */
export async function readRepoFlow(repoPath: string, file: string): Promise<{ doc: FlowDoc; source: string }> {
  let source: string;
  try {
    source = await readFile(join(flowsDir(repoPath), file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FlowError(`no such flow file: ${file}`);
    throw err;
  }
  const { parseFlowHcl } = await import('./parse.js');
  try {
    return { doc: await parseFlowHcl(source), source };
  } catch (err) {
    throw new FlowError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Emit + atomically write one flow file, returning the canonical source. Semantic/shape validation
 * happened at the protocol boundary (sidecar validators); this owns what needs fs: the
 * sibling-duplicate check, first-save mkdir, the re-parse guard (a file readFlow cannot read back
 * must never be written), and the temp-file contract (dot-prefixed ⇒ invisible to discovery;
 * truncate-on-retry; best-effort unlink on error).
 *
 * KNOWN GAP (client-guarded only): the sibling check matches parseable NAMES — a basename
 * collision with an UNPARSEABLE file is invisible here, and the atomic rename overwrites it.
 * The editor's taken-name set (file basenames included) is the guard; a future non-UI caller of
 * writeFlow reintroduces that data-loss path unless it checks basenames too (review #345).
 */
export async function writeRepoFlow(repoPath: string, file: string, doc: FlowDoc): Promise<{ source: string }> {
  // Valid declarations only, matching findDeclaring: an invalid scratch file that happens to claim
  // the name must not block saving a valid flow (broken siblings never brick, in either direction).
  const entries = await scanFlows(repoPath);
  const other = entries.find(
    (e) => e.file !== file && e.doc !== undefined && e.doc.name === doc.name && flowDocError(e.doc) === undefined,
  );
  if (other !== undefined) throw new FlowError(`flow "${doc.name}" is already declared in ${other.file}`);
  let source: string;
  try {
    source = emitFlowDoc(doc);
    const { parseFlowHcl } = await import('./parse.js');
    await parseFlowHcl(source);
  } catch (err) {
    throw new FlowError(err instanceof Error ? err.message : String(err));
  }
  // A repo-committed symlink under `.vanguard` must not redirect the write out of the checkout.
  const dir = await ensureStateDir(repoPath, flowsDir(repoPath));
  const tmp = join(dir, `.${file}.tmp`);
  await assertStatePath(repoPath, tmp);
  await assertStatePath(repoPath, join(dir, file));
  try {
    await writeFile(tmp, source, 'utf8');
    await rename(tmp, join(dir, file));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { source };
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DOC_KEYS = new Set(['name', 'label', 'stages', 'loops', 'meta']);
const STAGE_KEYS = new Set(['name', 'ref', 'overrides', 'meta']);
const OVERRIDE_KEYS = new Set(['model', 'effort', 'maxTurns', 'provider', 'resumePrevious']);
const LOOP_KEYS = new Set(['stages', 'until', 'max']);

/**
 * Shape-check a renderer-supplied doc into a clean FlowDoc. The write path receives a JS object,
 * not HCL — parse's typo protection never ran — so unknown keys anywhere outside `meta` are
 * REJECTED, not stripped: emitFlowDoc emits a fixed key set, and a silently dropped `timeoutMs`
 * would survive the re-parse guard and change runtime behaviour (the format's never-silent-drop
 * rule, S2 Scope §4). Override values are held to the same rules as parse's applyOverride.
 */
export function coerceFlowDoc(raw: unknown): FlowDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FlowError('doc must be an object');
  const doc = raw as Record<string, unknown>;
  rejectUnknown(doc, DOC_KEYS, 'doc');
  if (typeof doc.name !== 'string' || doc.name.trim() === '') throw new FlowError('doc.name must be a non-blank string');
  if (typeof doc.label !== 'string' || doc.label.trim() === '') throw new FlowError('doc.label must be a non-blank string');
  if (!Array.isArray(doc.stages)) throw new FlowError('doc.stages must be an array');
  if (!Array.isArray(doc.loops)) throw new FlowError('doc.loops must be an array');
  const meta = coerceMeta(doc.meta, 'doc');
  return {
    name: doc.name,
    label: doc.label,
    stages: doc.stages.map(coerceStage),
    loops: doc.loops.map(coerceLoop),
    ...(meta !== undefined ? { meta } : {}),
  };
}

function coerceStage(raw: unknown, i: number): StageDecl {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FlowError(`stage[${i}] must be an object`);
  const stage = raw as Record<string, unknown>;
  rejectUnknown(stage, STAGE_KEYS, `stage[${i}]`);
  if (typeof stage.name !== 'string' || stage.name.trim() === '') throw new FlowError(`stage[${i}].name must be a non-blank string`);
  if (stage.ref !== undefined && typeof stage.ref !== 'string') throw new FlowError(`stage[${i}].ref must be a string`);
  const meta = coerceMeta(stage.meta, `stage[${i}]`);
  return {
    name: stage.name,
    ...(typeof stage.ref === 'string' ? { ref: stage.ref } : {}),
    overrides: coerceOverrides(stage.overrides, stage.name),
    ...(meta !== undefined ? { meta } : {}),
  };
}

function coerceOverrides(raw: unknown, stage: string): StageOverrides {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FlowError(`stage "${stage}" overrides must be an object`);
  const o = raw as Record<string, unknown>;
  rejectUnknown(o, OVERRIDE_KEYS, `stage "${stage}" overrides`);
  if (o.model !== undefined && typeof o.model !== 'string') throw new FlowError(`stage "${stage}" model must be a string`);
  if (o.provider !== undefined && typeof o.provider !== 'string') throw new FlowError(`stage "${stage}" provider must be a string`);
  if (o.effort !== undefined && !EFFORTS.has(o.effort as string)) throw new FlowError(`stage "${stage}" effort must be low|medium|high|xhigh|max`);
  if (o.maxTurns !== undefined && (typeof o.maxTurns !== 'number' || !Number.isInteger(o.maxTurns) || o.maxTurns <= 0)) {
    throw new FlowError(`stage "${stage}" maxTurns must be a positive integer`);
  }
  if (o.resumePrevious !== undefined && typeof o.resumePrevious !== 'boolean') {
    throw new FlowError(`stage "${stage}" resumePrevious must be a boolean`);
  }
  return o as StageOverrides;
}

function coerceLoop(raw: unknown, i: number): LoopDecl {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FlowError(`loop[${i}] must be an object`);
  const loop = raw as Record<string, unknown>;
  rejectUnknown(loop, LOOP_KEYS, `loop[${i}]`);
  if (!Array.isArray(loop.stages) || !loop.stages.every((s) => typeof s === 'string')) {
    throw new FlowError(`loop[${i}].stages must be a list of strings`);
  }
  if (typeof loop.until !== 'string') throw new FlowError(`loop[${i}].until must be a string`);
  if (typeof loop.max !== 'number' || !Number.isInteger(loop.max) || loop.max <= 0) {
    throw new FlowError(`loop[${i}].max must be a positive integer`);
  }
  return { stages: loop.stages as string[], until: loop.until, max: loop.max };
}

function coerceMeta(raw: unknown, where: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FlowError(`${where}.meta must be an object`);
  return raw as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new FlowError(`unknown key "${key}" in ${where}`);
  }
}

/**
 * Delete one flow file (S8). Idempotent: ENOENT is SUCCESS — "already gone" is the state the
 * caller asked for, and the query pipe's Timed watchdog may retry a killed exchange (a scary
 * error on the second attempt would be a lie). Anything else (EACCES, EISDIR) throws FlowError.
 */
export async function deleteRepoFlow(repoPath: string, file: string): Promise<void> {
  if (!FLOW_FILE_RE.test(file)) {
    throw new FlowError(`invalid flow file name "${file}" — expected <name>.hcl`);
  }
  await assertStatePath(repoPath, join(flowsDir(repoPath), file));
  try {
    await unlink(join(flowsDir(repoPath), file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new FlowError(err instanceof Error ? err.message : String(err));
  }
}
