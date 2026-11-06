// GENERATED from src/wire.ts — do not edit; run pnpm gen:wire
/**
 * The wire contract shared between core and the desktop app (Subsystem 7).
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — this file must be safe in the Tauri webview.
 * - Syntax ceiling: interfaces, type aliases, literal unions, `const` literals only — nothing the
 *   desktop's OLDER TypeScript cannot parse (the drift guard proves byte-equality, not
 *   compilability; the ceiling is what keeps this compiling on both sides).
 * - `pnpm gen:wire` copies this file verbatim (plus a header) to apps/desktop/src/wire.ts; the
 *   drift test byte-compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
 *
 * Rust never inspects these payloads (sidecar traffic passes through as opaque JSON), so this file
 * IS the contract for everything TS↔TS. The TS↔Rust shapes (serde structs in src-tauri) are a
 * different boundary and stay hand-mirrored — see the note above `Project`.
 */

/** Reasoning-effort tiers accepted across stages, flows, and the CLI. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Structured run events emitted by the pipeline runner when a caller passes `onEvent`. Stage names
 * are plain strings (matching StageOutcome.name). The desktop additionally sees a Rust-minted
 * `run-accepted` variant that core never emits — declared desktop-side, not here.
 */
export type RunEvent =
  | { type: 'run-start'; taskId: string; flow: string; provider: string; stages: string[] }
  | { type: 'stage-start'; name: string; index: number; of: number }
  | { type: 'stage-end'; name: string; index: number; of: number; outcome: string }
  | { type: 'cost'; usdSpent: number }
  | { type: 'warning'; message: string }
  | { type: 'run-end'; prUrl?: string; secretBlocked?: boolean }
  | { type: 'run-error'; message: string }
  | { type: 'run-cancelled' };

/** A selectable flow: its stable key and a human label for the UI. */
export interface FlowInfo {
  name: string;
  label: string;
}

/** What the run builder + flow editor render from — providers, flows, the stage palette, transports, defaults. */
export interface Capabilities {
  providers: string[];
  flows: FlowInfo[];
  /** STAGE_LIBRARY keys — the flow editor's stage palette. Static per session. */
  stages: string[];
  transports: string[];
  defaults: { provider: string; maxTurns: number; maxCostUsd: number; baseBranch: string };
}

/** The task transports vanguard reads/publishes through. */
export const TRANSPORTS = ['github', 'gitlab', 'linear'] as const;

/** Params for the sidecar `createRun` method. */
export interface CreateRunParams {
  issueRef: string;
  /** Absolute path to the target project repo — required (the sidecar child has no project cwd). */
  repoPath: string;
  flow?: string;
  provider?: string;
  transport?: string;
  maxTurns?: number;
  baseBranch?: string;
}

/** Result of the sidecar `createRun` method. */
export interface CreateRunResult {
  prUrl?: string;
  secretBlocked?: boolean;
}

/** Per-stage routing/budget overrides expressible in HCL (snake_case keys map to these camelCase fields). */
export interface StageOverrides {
  model?: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  provider?: string;
  resumePrevious?: boolean;
}

/** One `stage {}` block: a name (library key), an optional `ref` (Layer-2 escape hatch), and overrides. */
export interface StageDecl {
  name: string;
  /** `"relpath#export"` resolved under `<repoPath>/.vanguard/`. Present ⇒ record comes from TS, not the library. */
  ref?: string;
  overrides: StageOverrides;
  /** Freeform pass-through block; never interpreted. */
  meta?: Record<string, unknown>;
}

/** One `loop {}` block. Parsed/emitted in S2; execution deferred. */
export interface LoopDecl {
  stages: string[];
  until: string;
  max: number;
}

/** A whole flow file: exactly one `flow "<name>" {}` block. */
export interface FlowDoc {
  name: string;
  label: string;
  stages: StageDecl[];
  loops: LoopDecl[];
  meta?: Record<string, unknown>;
}

/** One discovered flow file. `name` present ⇔ parsed (openable); `error` present ⇔ not runnable. */
export interface RepoFlowInfo {
  file: string;
  name?: string;
  label?: string;
  error?: string;
}

/**
 * One configured custom provider on the wire (S6): healthy (name, no error) or broken (`error`
 * set; index -1 = the whole-file pseudo-entry). `error` absent ⇔ runnable.
 */
export interface RepoProviderInfo {
  index: number;
  name?: string;
  error?: string;
}

/**
 * One composer attachment forwarded with a doc-chat completion (Editor UX 7/7). Additive on the
 * wire — a caller that sends none is byte-identical to the pre-attachment protocol.
 *
 * `kind: 'image'` → a pasted/dropped image persisted under `.vanguard/drafts/<id>-assets/`; `path`
 * is its absolute path and `mediaType` its IANA type (e.g. `image/png`). `__complete` reads the
 * file and forwards it to the agent SDK as an image content block.
 *
 * `kind: 'file'` → a dropped text file or an `@`-mention; `path` is the fence label (the dropped
 * filename or the `@path`) and `content` its already-read, host-capped UTF-8 text, inlined into the
 * prompt as a fenced block. `mediaType`/`content` are per-kind and both optional on the wire.
 */
export interface CompleteAttachment {
  kind: 'image' | 'file';
  path: string;
  mediaType?: string;
  content?: string;
}

/** One doc-chat completion request (the JSON `vanguard __complete` reads on stdin). */
export interface CompleteRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  baseUrl?: string;
  /** Pasted images + inlined text files/mentions (Editor UX 7/7). Absent ⇒ text-only completion. */
  attachments?: CompleteAttachment[];
  /** TRUSTED image-containment root, stamped by the Rust sidecar over anything the renderer sent
   * (like baseUrl): every image attachment path must canonicalize under it. Absent ⇒ image
   * attachments are refused. */
  assetRoot?: string;
}

/** Ceiling on ONE image attachment file (Editor UX 7/7 review r1) — matches the Anthropic API's
 * per-image limit; refused before the model is hit. */
export const MAX_IMAGE_BYTES = 5_000_000;

/** Ceiling on the AGGREGATE bytes of all image attachments in one send (Editor UX 7/7 review r3):
 * bounds the whole prompt, not just each image, so N images can't balloon a single turn. */
export const MAX_IMAGE_TOTAL_BYTES = 15_000_000;

/** Ceiling on ONE inlined attachment/mention file (Editor UX 7/7) — the drag-drop/mention 64KB cap. */
export const MAX_ATTACHMENT_BYTES = 64_000;

/** Ceiling on TOTAL inlined attachment/mention content per send (Editor UX 7/7). Error above. */
export const MAX_INLINE_TOTAL_BYTES = 256_000;

/** The single JSON line `vanguard __complete` writes to stdout. */
export interface CompleteResponse {
  text?: string;
  error?: { message: string };
}

/** A created task: the ref `vanguard run` accepts, and the URL to show the human. */
export interface CreatedTask {
  id: string;
  url: string;
}

/**
 * Body size ceiling for created tasks. Enforced BEFORE any request: hitting a real provider limit
 * surfaces as a bare E2BIG from the OS, which tells the user nothing.
 */
export const MAX_BODY_BYTES = 60_000;

/** Title byte ceiling for created tasks (a pathological `# ...` is one doc away). */
export const MAX_TITLE_BYTES = 500;

/** The ONE repo-configured-name grammar (flows AND custom providers — S5/S6). */
export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Grammar for a custom provider's `keyEnv` (an environment variable NAME, never a key). */
export const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The allowed keys of a `customProviders` entry (unknown keys are a validation error). */
export const CUSTOM_PROVIDER_KEYS = ['name', 'baseUrl', 'keyEnv', 'model'] as const;

/**
 * A VALID `customProviders` entry (Subsystem 6) — the shape the core loader accepts and the
 * Settings form edits. `AppConfig.customProviders` stays `unknown` on purpose: the file is
 * hand-editable, so entries reach both producers invalid and with unknown keys, and only the
 * loader (and `customProviderRowError`, its editor mirror) may call one well-formed.
 */
export interface CustomProviderSpec {
  name: string;
  /** Absolute http:/https: URL — becomes ANTHROPIC_BASE_URL verbatim. */
  baseUrl: string;
  /** Host env var NAME holding the key (read at dispatch, never stored). */
  keyEnv: string;
  /** Forced default model (zai pattern) for endpoints that don't serve the CLI's Claude default. */
  model?: string;
}

/**
 * The built-in provider names, in registry-table order. A LITERAL, not derived: PROVIDER_NAMES is
 * `Object.keys(PROVIDERS)` inside registry.ts, which imports node-only provider classes — this
 * file must stay webview-safe. registry.test.ts pins `WIRE_PROVIDER_NAMES` equal (incl. order).
 */
export const WIRE_PROVIDER_NAMES = ['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian'] as const;

/** Adversary-finding severity/kind vocabularies; core's zod schema derives its enums from these. */
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const FINDING_KINDS = ['security', 'perf', 'correctness', 'style'] as const;

/** One board card (S9): id resolvable to (source, ref) for spec fetch and run-record matching. */
export interface BoardTask {
  id: string;
  title: string;
  column: 'queued' | 'claimed' | 'running' | 'verify-failed' | 'review' | 'done';
  /** The chip: first label else provider state (github/gitlab); the workflow state (Linear). */
  state: string;
  /** Waiting for the factory: carries a trigger label and is still `queued`. Absent when false. */
  waiting?: boolean;
}

/** One adversary-stage finding (the `<findings>` block item shape). */
export interface Finding {
  severity: (typeof FINDING_SEVERITIES)[number];
  kind: (typeof FINDING_KINDS)[number];
  title: string;
  evidence: string;
}

/**
 * Persisted run-record shapes (src/core/run-store.ts and src-tauri/src/runs.rs both produce these; this
 * file pins the hub's TS side so desktop drift fails CI — the Rust side stays a hand-mirror).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

export interface RunRecord {
  taskId: string;
  completed: boolean;
  exitReason: string;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  cacheEfficiency?: number;
  durationMs?: number;
  model?: string;
  timestamp: string;
  stage?: string;
  prUrl?: string;
  /** Why no `.diff` / `.bundle` / transcript sit next to this record (see core run-store.ts). */
  diffOmitted?: 'secret-blocked' | 'secret-scan';
}

export interface Proof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
}

export interface VisualProofArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface VisualProof {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;
  outputTail: string;
  artifacts: VisualProofArtifact[];
}

export interface RunSummary {
  taskId: string;
  timestamp: string;
  stages: string[];
  totalCostUsd: number;
  anyFailed: boolean;
  prUrl?: string;
}

export interface StageDetail {
  record: RunRecord;
  diff?: string;
  transcript?: string;
}

export interface RunDetail {
  taskId: string;
  timestamp: string;
  stages: StageDetail[];
  proof?: Proof;
  visualProof?: VisualProof;
}

/** A CI run, as returned by `gh run list` (src/hub/remote.ts) / Tauri's `list_remote_runs`. */
export interface RemoteRun {
  id: number;
  status: string;
  conclusion: string;
  title: string;
  branch: string;
  workflow: string;
  createdAt: string;
  event: string;
  url: string;
  /** The run's record artifact is already in the local cache (opens without `gh`). */
  cached: boolean;
}

/** A CI run's downloaded `vanguard-runs` artifact imported by `import_remote_run` / `importRemoteRun`. */
export interface RemoteImport {
  runId: number;
  taskIds: string[];
  runs: RunSummary[];
  cachedAt: string;
}

/**
 * Where one run's records live, resolved to a root by whichever backend answers `read_run` —
 * Tauri's own per-run cache dir (`src-tauri/src/remote.rs`), the hub's
 * `<project>/.vanguard/remote-runs/<runId>` (`src/hub/runs.ts`). The UI never sees either root: it
 * only carries this discriminant (see `RunRef`).
 */
export type RunSource = { kind: 'local' } | { kind: 'ci'; runId: number };

/** Identifies one run record to open: which source tree, and which task/timestamp within it. */
export interface RunRef {
  source: RunSource;
  taskId: string;
  timestamp: string;
}

/**
 * Hand-mirrors of RUST serde structs in src-tauri (the persisted/aggregated shapes) — a TS seam
 * cannot pin these to Rust, so they live here only because the `Commands` catalogue below needs a
 * result type for every command; keep them in sync with src-tauri by hand.
 */
export interface Project {
  path: string;
  name: string;
  runCount: number;
  taskCount: number;
  totalCostUsd: number;
  failedCount: number;
  lastRun?: string | null;
  runningCount: number;
  runsLast24h: number;
  color?: string | null;
}

export interface ActiveRun {
  taskId: string;
  sessionFile: string;
  lastActivityMs: number;
}

export interface TranscriptEntry {
  role: 'assistant' | 'tool';
  text: string;
}

export interface SessionRead {
  entries: TranscriptEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Live spend estimate in USD (priced per-message off each message's model; unknown models add
   * nothing, so it's a lower bound — show as "~$"). */
  estCostUsd: number;
}

/** Every field is nullable, not just optional: Rust's emit-all serde writes `null` for an absent
 * `Option`, and a hand-edited `app.json` may spell a default that way too. */
export interface AppConfig {
  source?: string | null;
  label?: string | null;
  team?: string | null;
  color?: string | null;
  provider?: string | null;
  reviewProvider?: string | null;
  verifyCmd?: string | null;
  concurrency?: number | null;
  budgetUsd?: number | null;
  runCommand?: string | null;
  /** Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; key is env-only. */
  chatModel?: string | null;
  chatBaseUrl?: string | null;
  /** Opaque JSON preserved by Rust and the hub, including invalid entries and unknown keys — see
   * `CustomProviderSpec` for the shape a valid entry has. */
  customProviders?: unknown;
}

/** Hub-only (src/hub/browse.ts) — one subdirectory offered by `browse_dirs`, standing in for the
 * native folder dialog Tauri doesn't have in a browser. */
export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasVanguard: boolean;
}

/** Hub-only (src/hub/browse.ts) — one `browse_dirs` page: the listed directory plus its children. */
export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/** A Fleet-screen spawned process (TAURI_ONLY — Fleet is disabled in hub mode). */
export interface SpawnInfo {
  pid: number;
  cwd: string;
  command: string;
}

/**
 * Allowlisted fields for `api_complete`'s `req` (S3/Editor UX 7/7). Deliberately NOT
 * `Omit<CompleteRequest, 'baseUrl' | 'assetRoot'>`: every field here is one the renderer is
 * permitted to send across the webview boundary. A new `CompleteRequest` field must be added HERE
 * to cross that boundary — a denylist (Omit) would auto-expose it instead (review #342).
 */
export interface CompleteCallArgs {
  system?: CompleteRequest['system'];
  messages: CompleteRequest['messages'];
  model: string;
  attachments?: CompleteRequest['attachments'];
}

/**
 * Shared command catalogue for the Tauri, hub and mock adapters. Adapter integration is separate:
 * the existing invoke wrappers and dispatchers do not yet enforce these argument/result types.
 * The parity test checks registered Rust commands and hub dispatch cases against this catalogue.
 */
export interface Commands {
  list_runs: { args: { repoPath: string }; result: RunSummary[] };
  read_run: { args: { repoPath: string; taskId: string; timestamp: string; source: RunSource }; result: RunDetail };
  list_projects: { args: undefined; result: Project[] };
  add_project: { args: { path: string }; result: Project[] };
  remove_project: { args: { path: string }; result: Project[] };
  list_active: { args: { repoPath: string }; result: ActiveRun[] };
  read_session: { args: { sessionFile: string }; result: SessionRead };
  read_app_config: { args: { repoPath: string }; result: AppConfig };
  read_app_config_strict: { args: { repoPath: string }; result: AppConfig };
  write_app_config: { args: { repoPath: string; config: AppConfig }; result: void };
  list_drafts: { args: { repoPath: string }; result: string[] };
  read_draft: { args: { repoPath: string; id: string }; result: string };
  write_draft: { args: { repoPath: string; id: string; content: string }; result: void };
  delete_draft: { args: { repoPath: string; id: string }; result: void };
  write_draft_asset: { args: { repoPath: string; id: string; name: string; bytes: number[] }; result: string };
  clear_draft_assets: { args: { repoPath: string; id: string }; result: void };
  list_remote_runs: { args: { repoPath: string }; result: RemoteRun[] };
  /** Both backends implement this: Tauri downloads+caches under the app config dir, the hub under
   * the project's `.vanguard/remote-runs/<id>` — each resolves `source: { kind: 'ci', runId }` for
   * a later `read_run` to its own root. A cache hit skips `gh run download` on both sides. */
  import_remote_run: { args: { repoPath: string; runId: number }; result: RemoteImport };
  list_tasks: { args: { repoPath: string }; result: { tasks: BoardTask[]; capped: boolean } };
  fetch_spec: { args: { repoPath: string; taskId: string }; result: { spec: string } };
  watch_project: { args: { repoPath: string }; result: void };
  unwatch_project: { args: { repoPath: string }; result: void };
  api_capabilities: { args: undefined; result: Capabilities };
  api_create_run: { args: { params: CreateRunParams }; result: CreateRunResult };
  api_active_run: { args: undefined; result: { runId: string; repoPath: string } | null };
  api_run_backlog: { args: { runId: string }; result: unknown[] };
  api_cancel: { args: undefined; result: void };
  api_create_task: { args: { repoPath: string; title: string; body: string }; result: CreatedTask };
  api_list_flows: { args: { repoPath: string }; result: { flows: RepoFlowInfo[] } };
  api_list_providers: { args: { repoPath: string }; result: { providers: RepoProviderInfo[] } };
  api_read_flow: { args: { repoPath: string; file: string }; result: { doc: FlowDoc; source: string } };
  api_write_flow: { args: { repoPath: string; file: string; doc: FlowDoc }; result: { source: string } };
  api_delete_flow: { args: { repoPath: string; file: string }; result: void };
  api_list_repo_files: { args: { repoPath: string }; result: { files: string[]; capped: boolean } };
  api_read_repo_file: { args: { repoPath: string; path: string }; result: { path: string; content: string; truncated: boolean } };
  api_repo_ok: { args: { repoPath: string }; result: boolean };
  api_complete: { args: { repoPath: string; req: CompleteCallArgs; callId?: string }; result: CompleteResponse };
  api_cancel_complete: { args: { callId: string }; result: void };
  /** HUB_ONLY: no native folder dialog in a browser (src/hub/browse.ts stands in for one). */
  browse_dirs: { args: { path?: string }; result: DirListing };
  /** HUB_ONLY: clone a repository under the browse root and register it. */
  clone_project: { args: { url: string; parentDir: string; name?: string }; result: Project };
  /** TAURI_ONLY: the Fleet screen's shell-spawn surface — disabled in hub mode (remote code
   * execution on a reachable server). */
  spawn_run: { args: { cwd: string; command: string }; result: number };
  /** TAURI_ONLY (see spawn_run). */
  kill_run: { args: { pid: number }; result: void };
  /** TAURI_ONLY (see spawn_run). */
  list_spawns: { args: undefined; result: SpawnInfo[] };
}

/** Commands the hub does not implement for real: absent from `src/hub/rpc.ts`'s dispatch cases (the
 * Fleet shell-spawn surface is rejected generically instead of dispatched). */
export const TAURI_ONLY = ['spawn_run', 'kill_run', 'list_spawns'] as const satisfies readonly (keyof Commands)[];

/** Commands with no `#[tauri::command]` in `src-tauri/src/lib.rs` — browser-only stand-ins for
 * native capability the webview doesn't need (no folder-picker dialog). */
export const HUB_ONLY = ['browse_dirs', 'clone_project'] as const satisfies readonly (keyof Commands)[];

/** Every command name, for the lib.rs parity test and friends. TYPE-CHECKED (not just asserted)
 * against `Commands`: the `satisfies` below rejects a typo or a name not in `Commands`, and
 * `_Exhaustive` rejects a missing one — adding a command to `Commands` without adding it here is a
 * compile error. */
export const COMMAND_NAMES = [
  'list_runs',
  'read_run',
  'list_projects',
  'add_project',
  'remove_project',
  'list_active',
  'read_session',
  'read_app_config',
  'read_app_config_strict',
  'write_app_config',
  'list_drafts',
  'read_draft',
  'write_draft',
  'delete_draft',
  'write_draft_asset',
  'clear_draft_assets',
  'list_remote_runs',
  'import_remote_run',
  'list_tasks',
  'fetch_spec',
  'watch_project',
  'unwatch_project',
  'api_capabilities',
  'api_create_run',
  'api_active_run',
  'api_run_backlog',
  'api_cancel',
  'api_create_task',
  'api_list_flows',
  'api_list_providers',
  'api_read_flow',
  'api_write_flow',
  'api_delete_flow',
  'api_list_repo_files',
  'api_read_repo_file',
  'api_repo_ok',
  'api_complete',
  'api_cancel_complete',
  'browse_dirs',
  'clone_project',
  'spawn_run',
  'kill_run',
  'list_spawns',
] as const satisfies readonly (keyof Commands)[];
type _Exhaustive = keyof Commands extends (typeof COMMAND_NAMES)[number]
  ? true
  : ['missing from COMMAND_NAMES', Exclude<keyof Commands, (typeof COMMAND_NAMES)[number]>];
const _exhaustive: _Exhaustive = true;
void _exhaustive;

/** Named realtime channels the wire carries (`src/hub/rpc.ts`'s `publish`, Rust's `emit_event`).
 * The desktop additionally sees a Rust-minted `run-accepted` `api:event` variant core never emits —
 * that is a desktop extension of `RunEvent`, declared desktop-side (see typedRunReducer.ts), not here. */
export interface Events {
  'api:event': { runId: string; event: RunEvent };
  'vanguard:changed': string;
  /** Hub-only clone progress. */
  'vanguard:clone-progress': { line: string };
}
