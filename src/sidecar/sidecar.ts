import { isAbsolute } from 'node:path';
import { FLOWS, TRANSPORTS } from '../api/capabilities.js';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { VanguardError } from '../core/errors.js';
import { isSafeTaskId } from '../core/state-path.js';
import { coerceFlowDoc, flowDocError, FlowError, FLOW_FILE_RE } from '../flows/repo.js';
import type { RepoFlowInfo } from '../flows/repo.js';
import type { FlowDoc } from '../flows/types.js';
import type { RunEvent } from '../pipeline/events.js';
import type { Capabilities } from '../api/capabilities.js';
import type { CreatedTask } from '../tasks/create.js';

/** A caller mistake in a request (bad params, unknown method) — classified `kind: "bad-request"`. */
export class BadRequestError extends VanguardError {}

/** Typed projection of a run request — a subset of RunOptions plus the issue ref and transport. */
// CreateRunParams lives in src/wire.ts (the shared desktop contract — S7).
export type { CreateRunParams } from '../wire.js';
import type { CreateRunParams } from '../wire.js';
import type { BoardTask } from '../wire.js';

/**
 * What the sidecar forwards back to the client — the run's PR outcome. A structural subset of the
 * runner's RunIssueResult (which the production deps return directly); the sidecar never reads `task`.
 */
// CreateRunResult lives in src/wire.ts (S7).
export type { CreateRunResult } from '../wire.js';
import type { CreateRunResult } from '../wire.js';

export interface SidecarDeps {
  capabilities: () => Capabilities;
  createRun: (params: CreateRunParams, onEvent: (e: RunEvent) => void) => Promise<CreateRunResult>;
  createTask: (params: CreateTaskParams) => Promise<CreatedTask>;
  listFlows: (params: ListFlowsParams) => Promise<{ flows: RepoFlowInfo[] }>;
  listProviders: (params: ListProvidersParams) => Promise<{ providers: RepoProviderInfo[] }>;
  readFlow: (params: ReadFlowParams) => Promise<{ doc: FlowDoc; source: string }>;
  writeFlow: (params: WriteFlowParams) => Promise<{ source: string }>;
  deleteFlow: (params: DeleteFlowParams) => Promise<Record<string, never>>;
  listTasks: (params: ListTasksParams) => Promise<{ tasks: BoardTask[]; capped: boolean }>;
  fetchSpec: (params: FetchSpecParams) => Promise<{ spec: string }>;
  listRepoFiles: (params: ListRepoFilesParams) => Promise<{ files: string[]; capped: boolean }>;
  readRepoFile: (params: ReadRepoFileParams) => Promise<{ path: string; content: string; truncated: boolean }>;
  /** Run-record read path: the desktop forwards `list_runs`/`read_run` here (one reader — #472). */
  listRuns: (params: ListRunsParams) => Promise<RunSummary[]>;
  readRun: (params: ReadRunParams) => Promise<RunDetail>;
}

/** Repo-scoped flow-file methods (S5). All ride the query pipe, Bound::Timed. */
export interface ListFlowsParams {
  repoPath: string;
}
/** Repo-scoped custom-provider listing (S6). Query pipe, Bound::Timed. */
export interface ListProvidersParams {
  repoPath: string;
}
/**
 * One configured custom provider on the wire: healthy (name, no error) or broken (error set;
 * index -1 = the whole-file pseudo-entry). `error` absent ⇔ runnable. No baseUrl/keyEnv here —
 * nothing in the UI consumes them (Settings edits app.json directly).
 */
// RepoProviderInfo lives in src/wire.ts (S7).
export type { RepoProviderInfo } from '../wire.js';
import type { RepoProviderInfo } from '../wire.js';
export interface ReadFlowParams {
  repoPath: string;
  file: string;
}
export interface WriteFlowParams {
  repoPath: string;
  file: string;
  doc: FlowDoc;
}
/** Delete one flow file (S8). Idempotent — ENOENT is success. */
export interface DeleteFlowParams {
  repoPath: string;
  file: string;
}
/** Board read path (S9). Source/team/label come from app.json, read core-side from repoPath. */
export interface ListTasksParams {
  repoPath: string;
}
export interface FetchSpecParams {
  repoPath: string;
  taskId: string;
}
/** Composer `@`-mention autocomplete (Editor UX 7/7): the repo's tracked files. Query pipe, Timed. */
export interface ListRepoFilesParams {
  repoPath: string;
}
/** Read one tracked file for mention inlining (Editor UX 7/7). `path` is repo-relative. Timed. */
export interface ReadRepoFileParams {
  repoPath: string;
  path: string;
}
/**
 * Repo-scoped run listing. Query pipe, Bound::Timed. `repoPath` is a repo-shaped root: the project
 * itself, or (desktop CI import) the cache dir whose `.vanguard/runs` is the downloaded artifact.
 */
export interface ListRunsParams {
  repoPath: string;
}
export interface ReadRunParams {
  repoPath: string;
  taskId: string;
  timestamp: string;
}
export type { RunSummary, RunDetail } from '../wire.js';
import type { RunDetail, RunSummary } from '../wire.js';

/**
 * A task to create on the configured transport. `source`/`label`/`team` come from AppConfig, read on
 * the TRUSTED side (Rust) — the renderer does not get to choose which tracker gets written to.
 */
export interface CreateTaskParams {
  source: string;
  repoPath: string;
  title: string;
  body: string;
  labels?: string[];
  /** Linear only: which team the issue lands in. */
  team?: string;
}

interface Request {
  id?: string;
  method?: string;
  params?: unknown;
}

/**
 * Validate a createTask request at the protocol boundary. This one creates something in an external
 * system and CANNOT be undone from inside the app, so every caller mistake must fail here — loudly,
 * before anything is written — rather than half-way through a transport.
 */
function validateCreateTask(params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.source !== 'string' || !TRANSPORTS.includes(p.source as (typeof TRANSPORTS)[number])) {
    throw new BadRequestError(`source must be one of: ${TRANSPORTS.join(', ')}`);
  }
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '') {
    throw new BadRequestError('repoPath is required');
  }
  if (typeof p.title !== 'string' || p.title.trim() === '') {
    throw new BadRequestError('title is required');
  }
  if (typeof p.body !== 'string') {
    throw new BadRequestError('body must be a string');
  }
  if (p.source === 'linear' && (typeof p.team !== 'string' || p.team.trim() === '')) {
    // Without a team Linear would either fail deep in the API or land the issue in the caller's default
    // team — creating real work in the wrong place, with no undo.
    throw new BadRequestError('a Linear team key is required to create a task (set it in Settings)');
  }
}

/**
 * Validate a createRun request at the protocol boundary, before dispatch. Throws BadRequestError
 * for any caller mistake so it is classified `bad-request` rather than surfacing as `internal` deep
 * in the runner. Provider and flow are shape-checked only — repo customs/flows are legal values this
 * sync validator cannot see; both resolve as first statements of the createRun dep (bad-request).
 */
function validateCreateRun(params: unknown): void {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.issueRef !== 'string' || p.issueRef.trim() === '') {
    throw new BadRequestError('issueRef is required and must be a non-blank string');
  }
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '') {
    throw new BadRequestError('repoPath is required and must be a non-blank string');
  }
  // Only the string shape is checked here (like flow below): repo customProviders are legal values
  // and this validator is synchronous. Resolvability is a first statement of the createRun dep
  // (resolveRunChoice — before beginRun, before any sandbox cost), still kind `bad-request`.
  if (p.provider !== undefined && (typeof p.provider !== 'string' || p.provider.trim() === '')) {
    throw new BadRequestError(`provider must be a non-blank string, got ${String(p.provider)}`);
  }
  if (p.transport !== undefined && !(TRANSPORTS as readonly unknown[]).includes(p.transport)) {
    throw new BadRequestError(`unknown transport "${String(p.transport)}" — choose one of: ${TRANSPORTS.join(', ')}`);
  }
  // Only the string shape is checked here: repo `.vanguard/flows/*.hcl` flows are legal values and
  // this validator is synchronous. Resolvability is the createRun dep's first statement
  // (assertFlowResolvable — before beginRun, before any sandbox cost), still kind `bad-request`.
  if (p.flow !== undefined && (typeof p.flow !== 'string' || p.flow.trim() === '')) {
    throw new BadRequestError(`flow must be a non-blank string, got ${String(p.flow)}`);
  }
  if (p.maxTurns !== undefined && (typeof p.maxTurns !== 'number' || !Number.isInteger(p.maxTurns) || p.maxTurns <= 0)) {
    throw new BadRequestError(`maxTurns must be a positive integer, got ${String(p.maxTurns)}`);
  }
  if (p.baseBranch !== undefined && typeof p.baseBranch !== 'string') {
    throw new BadRequestError(`baseBranch must be a string, got ${Array.isArray(p.baseBranch) ? 'array' : p.baseBranch === null ? 'null' : typeof p.baseBranch}`);
  }
  if (typeof p.baseBranch === 'string') {
    try {
      assertSafeBaseBranch(p.baseBranch);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }
}

/**
 * The flow-file methods read/write disk relative to repoPath, and the sidecar child inherits the
 * APP's cwd (it is spawned with no project cwd) — a relative repoPath would silently target some
 * other tree, so all three methods require an absolute one.
 */
function requireAbsoluteRepoPath(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p.repoPath !== 'string' || p.repoPath.trim() === '' || !isAbsolute(p.repoPath)) {
    throw new BadRequestError('repoPath is required and must be an absolute path');
  }
  return p;
}

function requireFlowFile(p: Record<string, unknown>): void {
  if (typeof p.file !== 'string' || !FLOW_FILE_RE.test(p.file)) {
    throw new BadRequestError('file must be a lowercase [a-z0-9._-] basename ending in .hcl');
  }
}

function validateListFlows(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

function validateListProviders(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

function validateReadFlow(params: unknown): void {
  requireFlowFile(requireAbsoluteRepoPath(params));
}

function validateDeleteFlow(params: unknown): void {
  requireFlowFile(requireAbsoluteRepoPath(params));
}

function validateListTasks(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

function validateFetchSpec(params: unknown): void {
  const p = requireAbsoluteRepoPath(params);
  if (typeof p.taskId !== 'string' || p.taskId.trim() === '') {
    throw new BadRequestError('taskId is required and must be a non-blank string');
  }
}

function validateListRepoFiles(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

function validateReadRepoFile(params: unknown): void {
  const p = requireAbsoluteRepoPath(params);
  if (typeof p.path !== 'string' || p.path.trim() === '') {
    throw new BadRequestError('path is required and must be a non-blank string');
  }
}

function validateListRuns(params: unknown): void {
  requireAbsoluteRepoPath(params);
}

function validateReadRun(params: unknown): void {
  const p = requireAbsoluteRepoPath(params);
  if (typeof p.taskId !== 'string' || !isSafeTaskId(p.taskId)) {
    throw new BadRequestError('taskId is required and must name a single direct child of the runs root');
  }
  if (typeof p.timestamp !== 'string' || p.timestamp.trim() === '') {
    throw new BadRequestError('timestamp is required and must be a non-blank string');
  }
}

/**
 * Validate a writeFlow request and return the coerced doc. Everything pure happens here, before
 * dispatch: shape + unknown-key rejection (the renderer sends a JS object, so parse's typo
 * protection never ran — a silently dropped field would survive the re-parse guard), the semantic
 * validity predicate, the canonical-filename rule, and the built-in collision. The
 * sibling-duplicate check needs fs and lives in the dep.
 */
function validateWriteFlow(params: unknown): FlowDoc {
  const p = requireAbsoluteRepoPath(params);
  requireFlowFile(p);
  let doc: FlowDoc;
  try {
    doc = coerceFlowDoc(p.doc);
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err));
  }
  const problem = flowDocError(doc);
  if (problem !== undefined) throw new BadRequestError(problem);
  if (p.file !== `${doc.name}.hcl`) {
    throw new BadRequestError(`file name doesn't match flow name "${doc.name}" — rename the file to ${doc.name}.hcl to edit it in the app`);
  }
  if (Object.hasOwn(FLOWS, doc.name)) {
    throw new BadRequestError(`flow "${doc.name}" collides with a built-in flow — pick another name`);
  }
  return doc;
}

/** One table row: validate-then-call for a single core method. `validate` throws (BadRequestError)
 * or returns the params `call` should use — the writeFlow row uses this to thread the coerced doc
 * through without a second, method-specific unwrap at each call site. */
interface CoreMethodDef {
  validate: (params: unknown) => unknown;
  call: (deps: SidecarDeps, params: unknown, onEvent?: (e: RunEvent) => void) => Promise<unknown>;
}

/** Adapts a void-returning validator (throws on bad input, otherwise has nothing to add) into a
 * `CoreMethodDef['validate']` that passes the params through unchanged. */
function passthrough(validate: (params: unknown) => void): (params: unknown) => unknown {
  return (params) => {
    validate(params);
    return params;
  };
}

/**
 * Every core method's validate-then-call pairing, keyed by its sidecar wire name. `runSidecar` and
 * `dispatchRpc` (`src/hub/rpc.ts`) both ride this table via `invokeCoreMethod` — adding a method here
 * (plus its `api_*` name mapping in rpc.ts) is the only step needed to expose it on both transports.
 */
export const CORE_METHODS: Record<string, CoreMethodDef> = {
  capabilities: {
    validate: () => undefined,
    call: async (deps) => deps.capabilities(),
  },
  createTask: {
    validate: passthrough(validateCreateTask),
    call: async (deps, params) => deps.createTask(params as CreateTaskParams),
  },
  createRun: {
    validate: passthrough(validateCreateRun),
    call: async (deps, params, onEvent) => deps.createRun(params as CreateRunParams, onEvent ?? (() => {})),
  },
  listFlows: {
    validate: passthrough(validateListFlows),
    call: async (deps, params) => deps.listFlows(params as ListFlowsParams),
  },
  listProviders: {
    validate: passthrough(validateListProviders),
    call: async (deps, params) => deps.listProviders(params as ListProvidersParams),
  },
  readFlow: {
    validate: passthrough(validateReadFlow),
    call: async (deps, params) => deps.readFlow(params as ReadFlowParams),
  },
  deleteFlow: {
    validate: passthrough(validateDeleteFlow),
    call: async (deps, params) => deps.deleteFlow(params as DeleteFlowParams),
  },
  listTasks: {
    validate: passthrough(validateListTasks),
    call: async (deps, params) => deps.listTasks(params as ListTasksParams),
  },
  fetchSpec: {
    validate: passthrough(validateFetchSpec),
    call: async (deps, params) => deps.fetchSpec(params as FetchSpecParams),
  },
  listRepoFiles: {
    validate: passthrough(validateListRepoFiles),
    call: async (deps, params) => deps.listRepoFiles(params as ListRepoFilesParams),
  },
  readRepoFile: {
    validate: passthrough(validateReadRepoFile),
    call: async (deps, params) => deps.readRepoFile(params as ReadRepoFileParams),
  },
  listRuns: {
    validate: passthrough(validateListRuns),
    call: async (deps, params) => deps.listRuns(params as ListRunsParams),
  },
  readRun: {
    validate: passthrough(validateReadRun),
    call: async (deps, params) => deps.readRun(params as ReadRunParams),
  },
  writeFlow: {
    validate: (params) => {
      const doc = validateWriteFlow(params);
      // Pass the coerced doc, not the raw one — the clean rebuild is what gets emitted.
      return { ...(params as Record<string, unknown>), doc };
    },
    call: async (deps, params) => deps.writeFlow(params as WriteFlowParams),
  },
};

/** Is `name` a row in `CORE_METHODS`? */
export function isCoreMethod(name: string): boolean {
  return Object.hasOwn(CORE_METHODS, name);
}

/** Validate one core method's params by its wire name, without calling it — what `dispatchRpc`'s
 * `api_create_run` case uses to run `createRun`'s validator while still calling `ctx.runSession.createRun`
 * directly, instead of calling through a one-off `SidecarDeps` built just to override `createRun`. */
export function validateCoreMethod(method: string, params: unknown): unknown {
  if (!isCoreMethod(method)) {
    throw new BadRequestError(`unknown method: ${method}`);
  }
  return CORE_METHODS[method]!.validate(params);
}

/**
 * Validate then call one core method by its wire name — the single place `runSidecar` and
 * `dispatchRpc` dispatch through, so there is exactly one validate-then-call pairing per method.
 * `onEvent` is only read by `createRun`; every other method ignores it.
 */
export async function invokeCoreMethod(
  deps: SidecarDeps,
  method: string,
  params: unknown,
  onEvent?: (e: RunEvent) => void,
): Promise<unknown> {
  const validated = validateCoreMethod(method, params);
  return CORE_METHODS[method]!.call(deps, validated, onEvent);
}

/** Classify a thrown value the way both `runSidecar` and `dispatchRpc` report it on the wire:
 * BadRequestError (incl. UnknownCommandError)/FlowError/VanguardError are caller-correctable
 * (`bad-request`); anything else is a real fault (`internal`). */
export function classifyCoreError(err: unknown): { message: string; kind: 'bad-request' | 'internal' } {
  const kind = err instanceof VanguardError || err instanceof FlowError ? 'bad-request' : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  return { message, kind };
}

/**
 * Stdio JSON loop. Reads one request per line, writes correlated event/result/error lines.
 * DI on `deps` so the createRun event stream is testable without a real sandbox.
 */
export async function runSidecar(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  deps: SidecarDeps,
): Promise<void> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line === '') continue;
    let req: Request;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BadRequestError('request must be an object');
      }
      req = parsed as Request;
    } catch {
      write(JSON.stringify({ error: { message: 'invalid JSON', kind: 'bad-request' } }));
      continue;
    }
    const id = req.id;
    try {
      if (typeof req.method !== 'string') {
        throw new BadRequestError('method must be a string');
      }
      const method = req.method;
      const onEvent = method === 'createRun' ? (e: RunEvent) => write(JSON.stringify({ id, event: e })) : undefined;
      const result = await invokeCoreMethod(deps, method, req.params, onEvent);
      write(JSON.stringify({ id, result }));
    } catch (err) {
      const { message, kind } = classifyCoreError(err);
      write(JSON.stringify({ id, error: { message, kind } }));
    }
  }
}
