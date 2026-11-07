// The one implementation of the on-disk run-record format: naming, writing, listing and reading.
// Both readers that used to re-derive this format now forward here — src/hub/runs.ts (thin
// re-export shim) and the Tauri desktop app (apps/desktop/src-tauri/src/runs.rs), which forwards
// `list_runs`/`read_run` over the sidecar query pipe the way `list_tasks` already does.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { writeFile, appendFile, unlink, readdir, lstat, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { BadRequestError } from '../sidecar/sidecar.js';
import type { RunResult } from './types.js';
import { stageMetric } from './run-metric.js';
import { exportRunTrace } from './otlp-sink.js';
import { assertStatePath, ensureStateDir, isSafeTaskId } from './state-path.js';
import { injectedSecretValues, redactForPublish, scanForInjectedSecrets, scanForSecrets } from './secret-scan.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { VisualProofResult } from '../pipeline/visual-proof.js';
import type { DecisionProbeResult } from './decision-probe.js';
import type { Proof, RunDetail, RunRecord, RunSummary, StageDetail, VisualProof } from '../wire.js';

export type { AgentUsage, Proof, RunDetail, RunRecord, RunSummary, StageDetail, VisualProof, VisualProofArtifact } from '../wire.js';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * `<runsRoot>` is the directory directly containing per-task subdirectories: `.vanguard/runs` for a
 * repo's own history, or `.vanguard/remote-runs/<origin>` for an imported CI run's records.
 */
export function runsRoot(repoPath: string, origin?: number): string {
  return origin === undefined
    ? join(repoPath, '.vanguard', 'runs')
    : join(repoPath, '.vanguard', 'remote-runs', String(origin));
}

/** Filesystem-safe form of an ISO timestamp, shared by every record filename. */
export function sanitizeTimestamp(ts: string): string {
  return ts.replace(/[^0-9A-Za-z]/g, '-');
}

export function isRunRecordFile(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.proof.json') && !name.endsWith('.visual-proof.json');
}

/**
 * Read a file's text but refuse a symlinked leaf or anything that is not a regular file: a repo
 * under inspection could plant a `.diff`/`.transcript.log`/`.proof.json` pointing at an arbitrary
 * file and have its contents shown in the UI. The lstat gives the clear error; opening with
 * O_NOFOLLOW (where the platform has it) and checking the opened handle closes the swap-in race.
 * Guards the leaf symlink only (mirrors the Rust implementation's caveat).
 */
export async function readTextNoSymlink(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error('refusing to read a symlinked file');
  }
  if (!info.isFile()) throw new Error('refusing to read a non-regular file');
  // O_NONBLOCK: a FIFO swapped in after the lstat would otherwise block a threadpool thread on open.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('refusing to read a non-regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** 32-bit FNV-1a over a string; used only to fold file name+mtime into a stable fingerprint. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cheap, order-independent change-detector for a runs tree: folds each record file's name + mtime
 * together without reading contents. Missing/empty tree -> 0.
 */
export async function fingerprint(root: string): Promise<number> {
  let taskDirs;
  try {
    taskDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let fp = 0;
  for (const task of taskDirs) {
    if (!task.isDirectory()) continue;
    const taskPath = join(root, task.name);
    let files;
    try {
      files = await readdir(taskPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      let mtimeMs = 0;
      try {
        const info = await stat(join(taskPath, file.name));
        mtimeMs = info.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      fp = (fp + fnv1a(`${file.name}:${mtimeMs}`)) >>> 0;
    }
  }
  return fp;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Matches the `sanitizeTimestamp()` shape of an ISO timestamp, e.g. `2026-10-17T17-57-10-100Z`. */
const SANITIZED_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** Parse a `sanitizeTimestamp()`-shaped prefix back into epoch ms, or undefined if it doesn't match. */
function parseSanitizedTimestampMs(sanitized: string): number | undefined {
  const m = SANITIZED_TIMESTAMP_RE.exec(sanitized);
  if (m === null) return undefined;
  const [, date, hh, mm, ss, mmm] = m;
  const ms = Date.parse(`${date}T${hh}:${mm}:${ss}.${mmm}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** How far back a proof/visual-proof file may sit from the stage timestamp it's matched to as a fallback. */
const PROOF_FALLBACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pick the sibling `*<suffix>` file (by name, from a task dir listing) closest to and not later than
 * `stageMs`, within `PROOF_FALLBACK_WINDOW_MS`. Covers runs persisted before one timestamp was shared
 * across the proof writers and the stage writer: the proof file is stamped a few seconds earlier than
 * the stage records and never matches them exactly.
 */
function findClosestProofFile(fileNames: readonly string[], suffix: string, stageMs: number): string | undefined {
  let best: { name: string; ms: number } | undefined;
  for (const name of fileNames) {
    if (!name.endsWith(suffix)) continue;
    const ms = parseSanitizedTimestampMs(name.slice(0, -suffix.length));
    if (ms === undefined || ms > stageMs || stageMs - ms > PROOF_FALLBACK_WINDOW_MS) continue;
    if (best === undefined || ms > best.ms) best = { name, ms };
  }
  return best?.name;
}

/** Best-effort parse of a run record file; returns undefined on any read or JSON error. */
async function tryReadRecord(path: string): Promise<RunRecord | undefined> {
  try {
    const contents = await readTextNoSymlink(path);
    return JSON.parse(contents) as RunRecord;
  } catch {
    return undefined;
  }
}

async function parseRunSummaries(root: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];

  let taskDirs;
  try {
    taskDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summaries;
    throw error;
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const taskPath = join(root, taskEntry.name);
    const groups = new Map<string, RunRecord[]>();
    const files = await readdir(taskPath, { withFileTypes: true });
    for (const file of files) {
      if (!isRunRecordFile(file.name)) continue;
      const record = await tryReadRecord(join(taskPath, file.name));
      if (record === undefined) continue;
      const group = groups.get(record.timestamp);
      if (group === undefined) {
        groups.set(record.timestamp, [record]);
      } else {
        group.push(record);
      }
    }
    for (const [timestamp, records] of groups) {
      const first = records[0];
      if (first === undefined) continue;
      const stages = records.map((r) => r.stage ?? 'run').sort();
      const totalCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const anyFailed = records.some((r) => !r.completed);
      const prUrl = records.find((r) => r.prUrl !== undefined)?.prUrl;
      summaries.push({
        taskId: first.taskId,
        timestamp,
        stages,
        totalCostUsd,
        anyFailed,
        ...(prUrl !== undefined ? { prUrl } : {}),
      });
    }
  }

  summaries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return summaries;
}

/**
 * Parsed run summaries per runs root, reused while the tree is unchanged: a fresh parse re-reads and
 * JSON-parses every run record, and a caller (e.g. the dashboard) polling every few seconds should not
 * pay that cost when nothing changed. Keyed by root; the tree fingerprint invalidates an entry when a
 * record is added, removed, or rewritten.
 */
const listCache = new Map<string, { fingerprint: number; summaries: RunSummary[] }>();

/**
 * List and group run summaries under `root` (fingerprint-cached). Missing root -> []. Each task
 * subdirectory's record files are read, parsed, and grouped by `record.timestamp` (unparseable files
 * are skipped).
 */
export async function listRuns(root: string): Promise<RunSummary[]> {
  const fp = await fingerprint(root);
  const cached = listCache.get(root);
  if (cached !== undefined && cached.fingerprint === fp) {
    return cached.summaries;
  }
  // Only cache a successful parse. Caching a transient error's empty result would pin a dashboard at
  // 0 runs until the tree fingerprint next shifts; let a failure self-heal on the next call instead.
  const summaries = await parseRunSummaries(root);
  listCache.set(root, { fingerprint: fp, summaries });
  return summaries;
}

/**
 * Read the full detail (stages + proof) for one task's run at one timestamp. taskId is validated
 * against path traversal before any filesystem access.
 */
export async function readRun(root: string, taskId: string, timestamp: string): Promise<RunDetail> {
  if (!isSafeTaskId(taskId)) {
    throw new BadRequestError('invalid task id');
  }
  const taskDir = join(root, taskId);
  if ((await lstat(taskDir)).isSymbolicLink()) {
    throw new BadRequestError('refusing to read a symlinked task directory');
  }
  const stages: StageDetail[] = [];

  const files = await readdir(taskDir, { withFileTypes: true });
  for (const file of files) {
    if (!isRunRecordFile(file.name)) continue;
    const path = join(taskDir, file.name);
    const record = await tryReadRecord(path);
    if (record === undefined) continue;
    if (record.timestamp !== timestamp) continue;
    const base = path.endsWith('.json') ? path.slice(0, -'.json'.length) : path;
    const diff = await readTextNoSymlink(`${base}.diff`).catch(() => undefined);
    const transcript = await readTextNoSymlink(`${base}.transcript.log`).catch(() => undefined);
    stages.push({
      record,
      ...(diff !== undefined ? { diff } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    });
  }

  stages.sort((a, b) => {
    const sa = a.record.stage;
    const sb = b.record.stage;
    if (sa === sb) return 0;
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const fileNames = files.map((f) => f.name);
  const stageMs = Date.parse(timestamp);

  /** Read `<ts><suffix>`, or — if absent — the closest sibling `*<suffix>` file (see findClosestProofFile). */
  const readProofFile = async <T>(suffix: string): Promise<T | undefined> => {
    const exactPath = join(taskDir, `${sanitizeTimestamp(timestamp)}${suffix}`);
    try {
      return JSON.parse(await readTextNoSymlink(exactPath)) as T;
    } catch {
      // fall through to the closest-preceding fallback below
    }
    if (Number.isNaN(stageMs)) return undefined;
    const fallbackName = findClosestProofFile(fileNames, suffix, stageMs);
    if (fallbackName === undefined) return undefined;
    try {
      return JSON.parse(await readTextNoSymlink(join(taskDir, fallbackName))) as T;
    } catch {
      return undefined;
    }
  };

  const proof = await readProofFile<Proof>('.proof.json');
  const visualProof = await readProofFile<VisualProof>('.visual-proof.json');

  return {
    taskId,
    timestamp,
    stages,
    ...(proof !== undefined ? { proof } : {}),
    ...(visualProof !== undefined ? { visualProof } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteStagesOptions {
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Flow and provider names of the run, recorded on the exported trace (see otlp-sink). */
  flow?: string;
  provider?: string;
  /**
   * Leave the `.diff`, `.bundle` and `.transcript.log` off disk and stub `finalText`; only the JSON
   * record (marked `diffOmitted: 'secret-blocked'`) and the metric line are written for every stage.
   * Set for secret-blocked runs (and for a revise round whose diff could not be captured): the
   * payloads hold the very secret the scan caught, and the run record may be uploaded as a CI
   * artifact (`upload-run-records`). Independently of this flag, a stage diff that `scanForSecrets`
   * flags is withheld with `diffOmitted: 'secret-scan'`.
   */
  omitDiff?: boolean;
}

/** A handle for one run: owns its timestamp, so every record it writes shares one prefix. */
export interface RunWriter {
  /** Persist one record per pipeline stage under the writer's timestamp, then mirror the run as one
   * OTLP trace when an exporter is configured (opt-in, best-effort — see otlp-sink). */
  writeStages(outcomes: ReadonlyArray<{ name: string; result: RunResult; model?: string }>, opts?: WriteStagesOptions): Promise<void>;
  /** Persist a verification proof to `<ts>.proof.json` and append a `{ evt: 'verify', ... }` metric line. */
  writeProof(result: VerificationResult): Promise<string>;
  /** Persist a visual proof to `<ts>.visual-proof.json` and append a `{ evt: 'visual_proof', ... }` metric line. */
  writeVisualProof(result: VisualProofResult): Promise<string>;
}

/** Options of {@link beginRun}. */
export interface BeginRunOptions {
  /** Env var names of credentials the static injected-secret list cannot know (a custom provider's `keyEnv`). */
  secretEnvVars?: readonly string[];
}

interface WriteRecordOptions {
  /** Exact values of the credentials injected into this run's sandbox, removed from every free-text field. */
  secretValues: readonly string[];
  label?: string;
  prUrl?: string;
  requestedModel?: string;
  omitDiff?: boolean;
}

/**
 * Persist a run's metadata to `.vanguard/runs/<taskId>/<ts>[-label].json` and append one compact
 * metric line to `.vanguard/runs/metrics.jsonl`, so an AFK fleet leaves a cost/usage/exit trace. Free
 * text in the record (`finalText`, the sibling `.transcript.log`) is masked by redactForPublish; the (potentially
 * large) diff goes to a sibling `.diff` file plus a `.bundle` of the worktree HEAD, both skipped under
 * `omitDiff`. Every path is checked with assertStatePath first: a repo-committed symlink under
 * `.vanguard` must not redirect these writes out of the checkout. Returns the written JSON path.
 */
async function writeRecord(repoPath: string, taskId: string, timestamp: string, result: RunResult, opts: WriteRecordOptions): Promise<string> {
  const root = runsRoot(repoPath);
  const taskDir = await ensureStateDir(repoPath, join(root, taskId));

  const { diff, transcript, ...meta } = result;
  // Why the diff (and bundle) are withheld, recorded on run.json so the hub and a human can tell
  // "withheld" from "no diff" or "bundle creation failed":
  //  - 'secret-blocked': the caller's publish gate fired (opts.omitDiff).
  //  - 'secret-scan': a stage's diff is the worktree at the end of THAT stage, while the gate scans the
  //    final diff only — a secret the implementer wrote and the simplifier removed passes the gate yet
  //    sits in the implementer's record, so every stage diff meets the same scans first: the patterns
  //    (which exempt test paths, isTestPath) and the exact-value check on injected credentials.
  const diffOmitted: 'secret-blocked' | 'secret-scan' | undefined = opts.omitDiff
    ? 'secret-blocked'
    : diff !== undefined && diff !== '' && (scanForSecrets(diff).length > 0 || scanForInjectedSecrets(diff, opts.secretValues).length > 0)
      ? 'secret-scan'
      : undefined;
  // Free text is masked before it reaches disk (the record may leave the job as a CI artifact): injected
  // credentials by exact value, then token shapes. When the diff is withheld, so is the text: the
  // closing message tends to quote the change and the pattern pass is lossy (a fragment past a token's
  // char class survives).
  const record = {
    ...meta,
    finalText: diffOmitted !== undefined ? `[withheld: ${diffOmitted}]` : redactForPublish(result.finalText, opts.secretValues),
    timestamp,
    ...(opts.label !== undefined ? { stage: opts.label } : {}),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
    ...(diffOmitted !== undefined ? { diffOmitted } : {}),
  };
  const suffix = opts.label !== undefined ? `-${opts.label}` : '';
  const base = join(taskDir, `${sanitizeTimestamp(timestamp)}${suffix}`);
  const file = `${base}.json`;
  await assertStatePath(repoPath, file);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  if (diffOmitted === 'secret-scan') {
    // Visible in the job log too, so a scan false positive on a green run does not vanish silently.
    console.error(`vanguard: run record ${taskId}${suffix}: diff, bundle and transcript withheld (secret-scan)`);
  }
  if (diffOmitted === undefined) {
    // The transcript is raw agent output: tool results can echo env or config (a `cat` of the Codex
    // auth.json lands JSON-escaped, out of the patterns' reach), so mask injected values and known
    // token shapes (lossy is fine for a log). When the diff is withheld the transcript is skipped entirely:
    // the tool call that wrote the secret is in there verbatim, and skipping beats pattern-only masking.
    if (transcript) {
      await assertStatePath(repoPath, `${base}.transcript.log`);
      await writeFile(`${base}.transcript.log`, redactForPublish(transcript, opts.secretValues));
    }
    // Written faithful, not masked: this is what the hub's diff viewer and a human reconstructing the
    // run read, and redactTokens would mangle ordinary code (`password: process.env.X` → `[REDACTED]`).
    if (diff) {
      await assertStatePath(repoPath, `${base}.diff`);
      await writeFile(`${base}.diff`, diff);
    }
    const bundlePath = `${base}.bundle`;
    await assertStatePath(repoPath, bundlePath);
    try {
      await execa('git', hostGitArgs(['-C', result.worktreePath, 'bundle', 'create', bundlePath, 'HEAD']));
    } catch {
      // best-effort: remove any partial file git may have opened before it failed
      await unlink(bundlePath).catch(() => undefined);
    }
  }

  const metric = {
    evt: 'run_complete',
    ts: timestamp,
    ...stageMetric(result, opts.label, opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : undefined),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
  };
  await appendMetric(repoPath, metric);
  return file;
}

/** Append one line to `.vanguard/runs/metrics.jsonl`, refusing a symlinked leaf or parent. */
async function appendMetric(repoPath: string, metric: object): Promise<void> {
  const path = join(runsRoot(repoPath), 'metrics.jsonl');
  await assertStatePath(repoPath, path);
  await appendFile(path, `${JSON.stringify(metric)}\n`);
}

/**
 * Begin one run: a `RunWriter` handle that owns `taskId`'s timestamp, so proof.json, visual-proof.json
 * and every stage record share one prefix and the hub/desktop readers can match a run's proof to its
 * stage records by name. `timestamp` is only for deterministic tests — production callers pass
 * `undefined`. The injected credential values are snapshotted once here, for every record of the run.
 */
export function beginRun(
  repoPath: string,
  taskId: string,
  timestamp: string = new Date().toISOString(),
  runOpts: BeginRunOptions = {},
): RunWriter {
  const root = runsRoot(repoPath);
  const secretValues = injectedSecretValues(process.env, runOpts.secretEnvVars ?? []);

  return {
    async writeStages(outcomes, opts = {}): Promise<void> {
      for (const outcome of outcomes) {
        await writeRecord(repoPath, taskId, timestamp, outcome.result, {
          secretValues,
          label: outcome.name,
          ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
          ...(outcome.model !== undefined ? { requestedModel: outcome.model } : {}),
          ...(opts.omitDiff ? { omitDiff: opts.omitDiff } : {}),
        });
      }
      const first = outcomes[0];
      if (first === undefined) return;
      const { omitDiff: _omitDiff, ...trace } = opts;
      await exportRunTrace({
        taskId,
        timestamp,
        stages: outcomes.map((o) => stageMetric(o.result, o.name, o.model !== undefined ? { requestedModel: o.model } : undefined)),
        ...trace,
      });
    },

    async writeProof(result: VerificationResult): Promise<string> {
      const taskDir = await ensureStateDir(repoPath, join(root, taskId));
      const base = join(taskDir, sanitizeTimestamp(timestamp));
      const file = `${base}.proof.json`;
      await assertStatePath(repoPath, file);
      // outputTail is verbatim command output (last ~40 lines): masked like every other free text in the record.
      await writeFile(file, `${JSON.stringify({ ...result, outputTail: redactForPublish(result.outputTail, secretValues) }, null, 2)}\n`);

      const metric = { evt: 'verify', ts: timestamp, taskId, passed: result.passed, exitCode: result.exitCode, sha256: result.sha256 };
      await appendMetric(repoPath, metric);
      return file;
    },

    async writeVisualProof(result: VisualProofResult): Promise<string> {
      const taskDir = await ensureStateDir(repoPath, join(root, taskId));
      const base = join(taskDir, sanitizeTimestamp(timestamp));
      const file = `${base}.visual-proof.json`;
      await assertStatePath(repoPath, file);
      // Masked like proof.json (sha256 is over the full output there). On the did-not-run path
      // (exitCode -1) visual-proof.ts hashes `outputTail` itself, so the hash is recomputed over the
      // masked text to keep the stored proof verifiable.
      const outputTail = redactForPublish(result.outputTail, secretValues);
      const stored = {
        ...result,
        outputTail,
        ...(result.exitCode === -1 && outputTail !== result.outputTail ? { sha256: createHash('sha256').update(outputTail).digest('hex') } : {}),
      };
      await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

      const metric = {
        evt: 'visual_proof',
        ts: timestamp,
        taskId,
        passed: result.passed,
        exitCode: result.exitCode,
        sha256: stored.sha256,
        artifacts: result.artifacts.length,
      };
      await appendMetric(repoPath, metric);
      return file;
    },
  };
}

// ---------------------------------------------------------------------------
// Deprecated compatibility surface — one release, for the pre-RunWriter exports of src/index.ts
// ---------------------------------------------------------------------------

/** @deprecated Options of {@link persistRunRecord}; `beginRun().writeStages()` covers these. */
export interface PersistOptions {
  /** ISO timestamp; defaults to now. Injected for deterministic tests. */
  timestamp?: string;
  /** Stage name, when persisting a single stage of a multi-stage run. */
  label?: string;
  /** The PR opened for this run, if any. */
  prUrl?: string;
  /** Model the stage was configured with (StageOutcome.model); recorded next to the served `model`. */
  requestedModel?: string;
  /** See {@link WriteStagesOptions.omitDiff}. */
  omitDiff?: boolean;
}

/**
 * @deprecated Use `beginRun(repoPath, taskId).writeStages([...])` — a writer owns the run's timestamp,
 * so its proof files share the stage records' prefix. Kept for one release of compatibility.
 */
export async function persistRunRecord(localRepoPath: string, result: RunResult, opts: PersistOptions = {}): Promise<string> {
  return writeRecord(localRepoPath, result.taskId, opts.timestamp ?? new Date().toISOString(), result, {
    secretValues: injectedSecretValues(),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.prUrl !== undefined ? { prUrl: opts.prUrl } : {}),
    ...(opts.requestedModel !== undefined ? { requestedModel: opts.requestedModel } : {}),
    ...(opts.omitDiff !== undefined ? { omitDiff: opts.omitDiff } : {}),
  });
}

/**
 * @deprecated Use `beginRun(repoPath, taskId).writeStages(outcomes, opts)`. Kept for one release of
 * compatibility; takes the run's taskId from the first outcome, as the old writer did.
 */
export async function persistStageOutcomes(
  localRepoPath: string,
  outcomes: ReadonlyArray<{ name: string; result: RunResult; model?: string }>,
  opts: WriteStagesOptions & { timestamp?: string } = {},
): Promise<void> {
  const first = outcomes[0];
  if (first === undefined) return;
  const { timestamp, ...rest } = opts;
  await beginRun(localRepoPath, first.result.taskId, timestamp).writeStages(outcomes, rest);
}

/**
 * Append one `{ evt: 'decision_probe', ts, taskId, ... }` line to metrics.jsonl — the log-only
 * difficulty probe, joined to the stage outcomes by taskId in `vanguard stats`. Independent of
 * `beginRun`: the probe runs (and may fail) before a run's timestamp is otherwise needed.
 */
export async function persistDecisionProbe(
  localRepoPath: string,
  taskId: string,
  probe: DecisionProbeResult,
  opts: { timestamp?: string } = {},
): Promise<void> {
  await ensureStateDir(localRepoPath, runsRoot(localRepoPath));
  const metric = { evt: 'decision_probe', ts: opts.timestamp ?? new Date().toISOString(), taskId, ...probe };
  await appendMetric(localRepoPath, metric);
}
