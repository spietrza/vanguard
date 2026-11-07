import { cp, lstat, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from '../worktree/manager.js';
import { SkillRegistry } from '../context/skill-registry.js';
import { renderPrompt } from '../context/prompt-engine.js';
import { hasTerminationSignal } from '../structured/extract.js';
import { captureSession, hostSessionFile, isSafeSessionId, restoreSession, sessionPath } from '../agents/session-store.js';
import { agentFamily, cacheEfficiency } from '../agents/provider.js';
import { stageMetric } from './run-metric.js';
import { assertStatePath, ensureStateDir } from './state-path.js';
import { createLogger } from './logger.js';
import { installSignalCleanup, trackSandbox, untrackSandbox } from './cleanup.js';
import { acquireSandboxSlot, releaseSandboxSlot } from './concurrency.js';
import { SandboxError, WorkflowGuardError, WorktreeError } from './errors.js';
import { DEFAULT_BASE_BRANCH, assertSafeBaseBranch, redactGitError, resolveRemoteBaseRef } from './base-branch.js';
import type { RunOptions, RunResult, ExitReason, ReasoningEffort } from './types.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider, AgentUsage } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

const WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TURNS = 6;
// Skip on copy-back: .git (a linked worktree's .git is a file pointer; copying it corrupts the
// worktree), node_modules (gitignored, huge, and its .bin symlinks make fs.cp throw EINVAL),
// .claude/skills (plugin-installed symlinks pointing to absolute paths inside the sandbox —
// copying them yields dangling symlinks that cause Bun's fs.cp to throw ENOENT via stat),
// .cursor/rules (injected .mdc skill rules — load-bearing exclusion, these must not land in PRs),
// and .vanguard/skills (skill bodies copied in as pointer targets for codex/cursor providers).
const COPY_BACK_SKIP =
  /(^|[\\/])(\.git|node_modules)([\\/]|$)|(^|[\\/])\.claude[\\/]skills([\\/]|$)|(^|[\\/])\.cursor[\\/]rules([\\/]|$)|(^|[\\/])\.vanguard[\\/]skills([\\/]|$)/;
// Hard security boundary (see CLAUDE.md): an agent must never be able to write a workflow file
// that gets committed and pushed — that is the exact escalation path in the disclosed
// claude-code-action prompt-injection class (a malicious workflow runs with repo secrets on the
// next GitHub event). Local actions under .github/actions/ count too, since `uses: ./.github/actions/x` runs
// them with the workflow's secrets; an action kept elsewhere needs the repository's own review. GitLab CI config counts too: a merge request pipeline reads .gitlab-ci.yml, and
// the .gitlab/ YAML it conventionally includes, from the source branch, so an agent-written copy would
// run with the project's CI variables. For GitLab this is defence in depth, not a boundary:
// `include: local:` can name any path, so CI YAML kept elsewhere needs the project's own gate. Other
// .gitlab/ files (MR templates, CODEOWNERS) are not executed and still sync back. Kept as its own
// regex (not folded into COPY_BACK_SKIP) so drops can be logged loudly instead of silently, like the
// other noisy-but-expected skips above.
// Case-insensitive, so `job.YML` or a `.GitLab` directory on a case-insensitive filesystem cannot slip
// past; over-matching only drops a file that no pipeline reads. `s` lets `.*` cross a newline in a file name.
// The diff guard (assertNoWorkflowChanges) tests the same pattern against every path git reports as changed.
const WORKFLOW_PATH = /(^|[\\/])\.github[\\/]workflows([\\/]|$)|(^|[\\/])\.github[\\/]actions([\\/]|$)|(^|[\\/])\.gitlab-ci\.yml$|(^|[\\/])\.gitlab[\\/].*\.ya?ml$/is;
// A `.github` or `.gitlab` entry that is not a real directory (a symlink or a file, and in a diff any changed
// path, since git lists no directories) could stand in for the directory and point at CI files kept elsewhere.
// Copy-back also drops any symlink inside those directories, which could do the same for a subdirectory.
const CI_DIR_NAME = /(^|[\\/])\.git(hub|lab)$/i;
const IN_CI_DIR = /(^|[\\/])\.git(hub|lab)[\\/]/i;

/**
 * Which commit a task starts from. `'base'`: origin's copy of `baseBranch` when it is ahead of the
 * local one (see resolveRemoteBaseRef; the local copy when it is kept). `'reuse'`: an existing run
 * branch keeps its own history, and the local `baseBranch` is only the baseline a fresh branch is cut
 * from and new commits are measured against. `{ prHead }`: that branch as it is on origin (revise-pr),
 * guarded by `headRefOid` — the PR's own head SHA — so a same-named but different branch (the
 * same-named-branch case for a fork PR; see the comment in resolveStartRef) is never used as the start.
 */
export type TaskStart = 'base' | 'reuse' | { prHead: string; headRefOid: string };

export interface PrepareOptions {
  taskId: string;
  localRepoPath: string;
  /** The branch the task is for: the cut point of a 'base'/'reuse' start, and what the PR/MR targets. */
  baseBranch: string;
  /** Which commit the task starts from. Resolved once, here, and recorded as RunContext.startRef. */
  start: TaskStart;
  /** 'base' only: keep a local base that is ahead of/diverged from origin (default: outside CI only). See resolveRemoteBaseRef. */
  keepLocalIfAhead?: boolean;
  /** Override the run branch prefix (white-label mode: e.g. `feat/`). Default VANGUARD_BRANCH_PREFIX. */
  branchPrefix?: string;
  /** Override the run branch/path id (white-label mode: bare issue number). Default taskId. */
  branchId?: string;
  skills?: string[];
  /** Provider name (AgentProvider.name) used to select the skill injection target format. */
  agentName?: string;
  /** Provider name for the review stage; when different from agentName, skills are injected for both families. */
  reviewAgentName?: string;
  /** Provider name of the implementer fallback; its family gets skills too, or the rescued stage runs without them. */
  fallbackAgentName?: string;
  sandbox: IsolatedSandboxProvider;
  logger?: VanguardLogger;
}

export interface RunContext {
  taskId: string;
  sandbox: IsolatedSandboxProvider;
  worktreePath: string;
  branch: string;
  home: string;
  localRepoPath: string;
  /** The branch the task is for (PrepareOptions.baseBranch): the pre-push rebase fetches it and the PR/MR targets it. */
  baseBranch: string;
  /** The commit the task started from, as a SHA. The worktree cut, the closing-keyword scan and the pre-push rebase all measure from it. */
  startRef: string;
  wm: WorktreeManager;
  log: VanguardLogger;
  /** CI config files the agent added or edited in the sandbox, which copy-back dropped. The PR/MR description or revision summary lists them. */
  droppedCiPaths?: Set<string>;
}

export interface StageInput {
  promptTemplate: string;
  agent: AgentProvider;
  /** Stage name, used to scope structured lifecycle logs. */
  stageName?: string;
  variables?: Record<string, string>;
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
  forkSession?: boolean;
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  model?: string;
  signal?: AbortSignal;
  /**
   * When false, skip syncing sandbox files back to the worktree (read-only stage: no diff). Default true.
   * Intentionally not exposed on the single-stage `run()`/`RunOptions` wrapper: that path always copies
   * back. The asymmetry is deliberate — do NOT add copyBack to RunOptions.
   */
  copyBack?: boolean;
  /** Effective per-stage budget cap in USD (for metric logging only). */
  stageCapUsd?: number;
  /** Remaining global budget before this stage (for metric logging only). */
  remainingBudgetUsd?: number;
}

export interface RunDeps {
  worktrees?: WorktreeManager;
  /**
   * Skills to inject, or a resolver called with the new worktree's path, so repo skills can be read
   * from the tree the run starts from rather than from the host checkout.
   */
  skills?: SkillRegistry | ((worktreePath: string) => Promise<SkillRegistry>);
}

async function resolveHome(sandbox: IsolatedSandboxProvider): Promise<string> {
  const res = await sandbox.exec('printf %s "$HOME"');
  const home = res.stdout.trim();
  if (home === '') throw new SandboxError('Could not resolve $HOME in the sandbox');
  return home;
}

/** `git rev-parse` of `ref` as a commit SHA, or '' when it names no commit (or no such ref). */
async function revParseCommit(cwd: string, ref: string): Promise<string> {
  return (await execa('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, reject: false })).stdout.trim();
}

/**
 * Resolve PrepareOptions.start to the SHA the task starts from. Decided once, here, so the worktree
 * cut, the closing-keyword scan and the pre-push rebase cannot disagree, and no caller lands on a
 * default base by leaving it out. A SHA, not a ref: a concurrent run's fetch cannot move it and a
 * same-named tag cannot shadow it. Returns undefined only for a 'reuse' start whose base names no
 * commit here: the base is then unused when an existing run branch is picked up (prepareContext
 * measures from that branch instead), and a fresh cut fails in WorktreeManager.create as it always did.
 */
async function resolveStartRef(opts: PrepareOptions, log: VanguardLogger): Promise<string | undefined> {
  const { localRepoPath: cwd, baseBranch, start } = opts;
  // ctx.baseBranch feeds a fetch and the PR/MR target later; validate it here, whatever the start kind.
  assertSafeBaseBranch(baseBranch);
  let ref: string;
  let what: string;
  if (start === 'base') {
    ref = await resolveRemoteBaseRef(cwd, baseBranch, { logger: log, ...(opts.keepLocalIfAhead !== undefined ? { keepLocalIfAhead: opts.keepLocalIfAhead } : {}) });
    what = baseBranch;
  } else if (start === 'reuse') {
    // The base as this clone has it, never fetched: a reused branch keeps its own history. The local
    // branch first (the full ref, so a same-named tag cannot shadow it), then the tracking ref a
    // single-branch clone may hold instead, then whatever git makes of the bare name.
    for (const candidate of [`refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`, baseBranch]) {
      const sha = await revParseCommit(cwd, candidate);
      if (sha !== '') return sha;
    }
    return undefined;
  } else {
    // The PR head as it is on origin, so a revision continues the PR, not the base. Same-repo PRs
    // only (callers must have refused a cross-repository PR already — see the isCrossRepository guard
    // in revise-pr.ts): a fork PR's head is not on origin, so a same-named origin branch, or nothing, is
    // fetched instead. The head ref name is author-controlled: --end-of-options keeps a "-"-led name
    // from parsing as a git option, and the full refs/heads/ source keeps a "+"-led name (legal in git)
    // from reading as a force refspec.
    // No credential prompt from a daemon and a bounded wait, as in resolveRemoteBaseRef; the failure is
    // reported masked, never as raw git stderr.
    const fetch = await execa('git', ['fetch', '--end-of-options', 'origin', `refs/heads/${start.prHead}`], { cwd, reject: false, env: { GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 });
    if (fetch.exitCode !== 0) throw new WorktreeError(`Cannot fetch origin/${start.prHead} for ${opts.taskId}: ${redactGitError(fetch)}`);
    const sha = await revParseCommit(cwd, 'FETCH_HEAD');
    if (sha === '') throw new WorktreeError(`Cannot resolve the start commit for ${opts.taskId}: origin/${start.prHead} (FETCH_HEAD) is not a commit in ${cwd}`);
    // Belt-and-braces against the same-named-branch substitution above: even same-repo, FETCH_HEAD must
    // be exactly the PR's own head SHA, not a stale or diverged copy of the ref by that name.
    if (sha !== start.headRefOid) {
      throw new WorktreeError(`Cannot start ${opts.taskId} from origin/${start.prHead}: fetched ${sha}, expected PR head ${start.headRefOid}`);
    }
    return sha;
  }
  const sha = await revParseCommit(cwd, ref);
  if (sha === '') throw new WorktreeError(`Cannot resolve the start commit for ${opts.taskId}: ${what} (${ref}) is not a commit in ${cwd}`);
  return sha;
}

/** Provision worktree + sandbox + skills for one task. Caller owns disposeContext(). */
export async function prepareContext(opts: PrepareOptions, deps: RunDeps = {}): Promise<RunContext> {
  const log = opts.logger ?? createLogger();
  const wm = deps.worktrees ?? new WorktreeManager(opts.localRepoPath);
  let startRef = await resolveStartRef(opts, log);
  const wt = await wm.create(opts.taskId, startRef ?? opts.baseBranch, {
    ...(opts.start === 'reuse' ? { reuse: true } : {}),
    ...(opts.branchPrefix !== undefined ? { branchPrefix: opts.branchPrefix } : {}),
    ...(opts.branchId !== undefined ? { branchId: opts.branchId } : {}),
  });
  if (startRef === undefined) {
    // A reused branch in a clone that does not carry the base at all: the branch's own tip is the only
    // baseline there is (new commits are measured from it; nothing older is on the base either way).
    startRef = await revParseCommit(wt.path, 'HEAD');
    if (startRef === '') throw new WorktreeError(`Cannot resolve the start commit for ${opts.taskId}: ${opts.baseBranch} is not a commit in ${opts.localRepoPath} and ${wt.branch} has no head`);
    log.warn({ taskId: opts.taskId, baseBranch: opts.baseBranch, startRef }, `reuse: ${opts.baseBranch} is not a commit here — measuring from the tip of ${wt.branch}`);
  }
  // Acquire a host concurrency slot before booting the sandbox, so a fan-out can't start more
  // sandboxes than the host can hold (blocks until a slot frees).
  await acquireSandboxSlot(opts.sandbox);
  installSignalCleanup();
  try {
    await opts.sandbox.start();
    // The sandbox is live now: track it so a SIGINT/SIGTERM destroys it.
    trackSandbox(opts.sandbox);
    const home = await resolveHome(opts.sandbox);
    await opts.sandbox.copyIn(wt.path, WORKDIR);
    await seedSandboxGit(opts.sandbox);
    const skills = typeof deps.skills === 'function' ? await deps.skills(wt.path) : (deps.skills ?? new SkillRegistry({}));
    await skills.injectAll(opts.sandbox, home, opts.agentName, opts.reviewAgentName, opts.fallbackAgentName);
    const ctx: RunContext = {
      taskId: opts.taskId,
      sandbox: opts.sandbox,
      worktreePath: wt.path,
      branch: wt.branch,
      home,
      localRepoPath: opts.localRepoPath,
      baseBranch: opts.baseBranch,
      startRef,
      wm,
      log,
    };
    // The one place the start commit is announced: everything downstream reads ctx.startRef.
    ctx.log.info({ taskId: opts.taskId, baseBranch: opts.baseBranch, startRef }, 'run start');
    return ctx;
  } catch (error) {
    // Provisioning failed: untrack, free the slot, and tear down so nothing is orphaned.
    untrackSandbox(opts.sandbox);
    await opts.sandbox.destroy().catch(() => undefined);
    releaseSandboxSlot(opts.sandbox);
    throw error;
  }
}

/**
 * Reseed an in-sandbox, self-contained git repo at the workspace root so the agent's own
 * `git diff` / `git status` work. copyIn brings the host's linked-worktree `.git` *file pointer*
 * (`gitdir: <host path>`), which resolves to a host path that does not exist in the container — so
 * every git command fails inside the sandbox and the agent loses its only ground truth for "did my
 * edit land?". Starved of that signal, weaker models confabulate completion ("already present, no
 * edits required") and the stage produces an empty diff.
 *
 * We replace that dangling pointer with a throwaway repo seeded from the copied-in tree as a single
 * baseline commit. The agent can then diff its work against the baseline. This repo never reaches the
 * host: COPY_BACK_SKIP excludes `.git`, and the authoritative diff is still computed host-side in
 * syncSandboxToWorktree against the real worktree. `.gitignore` (present in the tree) keeps node_modules
 * out of the baseline. Best-effort: a failure here must not abort provisioning, so we swallow errors.
 */
async function seedSandboxGit(sandbox: IsolatedSandboxProvider): Promise<void> {
  const script = [
    `cd ${WORKDIR}`,
    'rm -rf .git',
    'git init -q',
    'git config user.email agent@vanguard.local',
    'git config user.name vanguard',
    'git add -A',
    'git commit -q -m "vanguard baseline" --no-verify || true',
  ].join(' && ');
  await sandbox.exec(script).catch(() => undefined);
}

/** CI config paths (`.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, any .yml/.yaml under `.gitlab/` at any depth, plus files standing in for those directories — see WORKFLOW_PATH / CI_DIR_NAME) among changed paths. Empty ⇒ clean. */
export function workflowPaths(paths: string[]): string[] {
  return paths.filter((path) => WORKFLOW_PATH.test(path) || CI_DIR_NAME.test(path)).sort();
}

/** Throws WorkflowGuardError (logged) if a changed path is CI config. */
export function assertNoWorkflowChanges(paths: string[], log: VanguardLogger, taskId: string): void {
  const offending = workflowPaths(paths);
  if (offending.length === 0) return;
  log.error({ taskId, paths: offending }, 'diff guard: blocked commit — diff touches CI config (hard constraint)');
  throw new WorkflowGuardError(`Diff touches forbidden CI config path(s): ${offending.join(', ')}`);
}

/** Larger dropped files are reported as changed unread: CI YAML is small, and the sandbox chose the size. */
const MAX_COMPARED_BYTES = 4 * 1024 * 1024;
/** The copy-back warning names this many dropped files and counts the rest. */
const DROPPED_CI_LOGGED = 20;

/**
 * Collect the files under a dropped CI path whose sandbox copy is new or differs from the worktree.
 * Unchanged CI files are dropped on every copy-back; only these mean the agent's work is missing from
 * the diff. A file the agent deleted is not in staging, so it is not reported. The walk is sequential:
 * the sandbox chose how many files there are, and a parallel walk can run out of file descriptors.
 */
async function collectChangedFiles(staging: string, worktree: string, rel: string, changed: string[]): Promise<void> {
  const src = join(staging, rel);
  const dest = join(worktree, rel);
  const info = await lstat(src);
  if (info.isDirectory()) {
    for (const name of await readdir(src)) await collectChangedFiles(staging, worktree, join(rel, name), changed);
    return;
  }
  // Compare a symlink by its target and never read through it: the sandbox chose where it points.
  if (info.isSymbolicLink()) {
    if ((await readlink(src)) !== (await readlink(dest).catch(() => undefined))) changed.push(rel);
    return;
  }
  const destInfo = info.isFile() ? await lstat(dest).catch(() => undefined) : undefined;
  if (destInfo?.isFile() !== true || destInfo.size !== info.size || info.size > MAX_COMPARED_BYTES) {
    changed.push(rel);
    return;
  }
  if (!(await readFile(src)).equals(await readFile(dest))) changed.push(rel);
}

// ponytail: copy-back ceiling of 2 GiB / 200,000 files (node_modules and .git are skipped and not
// counted). Far above any real change; it exists so a sandbox cannot fill the host disk through the worktree.
export const COPY_BACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const COPY_BACK_MAX_FILES = 200_000;

/**
 * A running total over the entries copy-back syncs into the worktree; throws a SandboxError as soon as
 * the total size or file count passes the ceiling. Directories count toward neither.
 */
export function copyBackBudget(maxBytes = COPY_BACK_MAX_BYTES, maxFiles = COPY_BACK_MAX_FILES): (entry: { isDirectory: () => boolean; size: number }) => void {
  let bytes = 0;
  let files = 0;
  return (entry) => {
    if (entry.isDirectory()) return;
    bytes += entry.size;
    files += 1;
    if (bytes > maxBytes || files > maxFiles) {
      throw new SandboxError(
        `copy-back: sandbox workspace exceeds the copy-back ceiling (${maxFiles} files / ${Math.round(maxBytes / 1024 / 1024)} MiB, node_modules and .git excluded); nothing was committed — remove build output or large generated files from the workspace`,
      );
    }
  };
}

/** Copy the sandbox workspace back onto the worktree via a staging dir, then return the resulting diff. */
async function syncSandboxToWorktree(ctx: RunContext): Promise<string> {
  const staging = await ensureStateDir(ctx.localRepoPath, join(ctx.localRepoPath, '.vanguard', 'staging', ctx.taskId));
  try {
    await ctx.sandbox.copyFileOut(WORKDIR, staging);
    const charge = copyBackBudget();
    const dropped: string[] = [];
    await cp(staging, ctx.worktreePath, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      filter: async (src) => {
        // Relative, so a `.gitlab` or `.github` directory above the repo does not match.
        const rel = relative(staging, src);
        const standsIn = async (): Promise<boolean> => {
          if (!CI_DIR_NAME.test(rel) && !IN_CI_DIR.test(rel)) return false;
          const info = await lstat(src);
          return CI_DIR_NAME.test(rel) ? !info.isDirectory() : info.isSymbolicLink();
        };
        if (WORKFLOW_PATH.test(rel) || (await standsIn())) {
          dropped.push(rel);
          return false;
        }
        if (COPY_BACK_SKIP.test(src)) return false;
        charge(await lstat(src));
        return true;
      },
    });
    // A comparison that fails reports the whole dropped path, so an edit is never hidden.
    const changed: string[] = [];
    for (const rel of dropped) {
      await collectChangedFiles(staging, ctx.worktreePath, rel, changed).catch(() => changed.push(rel));
    }
    if (changed.length > 0) {
      ctx.log.warn(
        { taskId: ctx.taskId, count: changed.length, paths: changed.slice(0, DROPPED_CI_LOGGED) },
        'copy-back: dropped CI config path (.github/workflows, .github/actions, .gitlab-ci.yml and .gitlab/ YAML are never synced back)',
      );
      const recorded = (ctx.droppedCiPaths ??= new Set());
      for (const path of changed) recorded.add(path);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const diff = await ctx.wm.diff(ctx.worktreePath);
  // Paths from git, not parsed diff headers: diff content lines can start with `+++ ` or `--- `.
  assertNoWorkflowChanges(await ctx.wm.changedPaths(ctx.worktreePath), ctx.log, ctx.taskId);
  return diff;
}

/** Run one agent stage against an existing context. Multiple stages can share a context (pipeline). */
export async function runAgent(ctx: RunContext, input: StageInput): Promise<RunResult> {
  const startedAt = Date.now();
  ctx.log.info(
    { taskId: ctx.taskId, ...(input.stageName !== undefined ? { stage: input.stageName } : {}) },
    'stage start',
  );
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sources = [input.signal, timeout.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = AbortSignal.any(sources);

  // A claude-CLI session id names host files (capture/restore below) and comes from agent output, so
  // one that is not a plain id token is dropped: the stage runs without resume rather than on a path.
  const claudeFamily = agentFamily(input.agent.name) === 'claude-cli';
  const safeSession = (id: string | undefined): string | undefined => {
    if (id === undefined || !claudeFamily || isSafeSessionId(id)) return id;
    ctx.log.warn({ taskId: ctx.taskId, sessionId: JSON.stringify(id).slice(0, 80) }, 'ignoring malformed session id');
    return undefined;
  };
  const resumeSessionId = safeSession(input.resumeSessionId);

  try {
    // Only the claude-CLI providers have a captured jsonl to restore (see captureSession below); codex/cursor
    // keep their chat in the sandbox, so a restore would copyIn a host file that never existed and throw.
    if (resumeSessionId !== undefined && claudeFamily) {
      // Within a shared sandbox the session is already present natively (the prior stage wrote it).
      // Restoring it would overwrite the agent-owned jsonl with a root-owned copy the agent cannot
      // read, breaking resume. Only restore for a true cross-run resume, when it is not present.
      const present = await ctx.sandbox.exists(sessionPath(ctx.home, WORKDIR, resumeSessionId));
      if (!present) {
        const hostFile = hostSessionFile(join(ctx.localRepoPath, '.vanguard', 'sessions', ctx.taskId), resumeSessionId);
        await assertStatePath(ctx.localRepoPath, hostFile);
        await restoreSession(ctx.sandbox, { home: ctx.home, cwd: WORKDIR, sessionId: resumeSessionId, hostFile });
      }
    }

    const prompt = await renderPrompt(input.promptTemplate, { variables: input.variables ?? {}, sandbox: ctx.sandbox });

    const gen = input.agent.run({
      prompt,
      sandbox: ctx.sandbox,
      workdir: WORKDIR,
      home: ctx.home,
      maxTurns,
      signal,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(input.forkSession !== undefined ? { forkSession: input.forkSession } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.mcpConfig !== undefined ? { mcpConfig: input.mcpConfig } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    });

    let finalText = '';
    let turns = 0;
    let sessionId = resumeSessionId;
    let usage: AgentUsage | undefined;
    let costUsd: number | undefined;
    let transcript: string | undefined;
    let modelUsed = input.model;

    for (;;) {
      const next = await gen.next();
      if (next.done) {
        finalText = next.value.finalText;
        turns = next.value.turns;
        if (next.value.sessionId !== undefined) sessionId = safeSession(next.value.sessionId) ?? sessionId;
        usage = next.value.usage;
        costUsd = next.value.costUsd;
        transcript = next.value.transcript;
        if (next.value.model !== undefined) modelUsed = next.value.model;
        break;
      }
      if (next.value.sessionId !== undefined) sessionId = safeSession(next.value.sessionId) ?? sessionId;
      // DEBUG-ONLY: this line logs raw model output (`text`) and may contain task content; it must
      // stay at debug level. Never log prompts or secrets, and never raise this to info.
      ctx.log.debug({ taskId: ctx.taskId, text: next.value.text }, 'agent turn');
    }
    // A gateway that predates the requested model can silently serve its own default instead of
    // erroring (live case: Meridian 1.43.0's bundled SDK answered claude-fable-5 requests with
    // claude-sonnet-4-6). Surface the swap loudly. Aliases ('opus', 'sonnet') legitimately resolve
    // to versioned ids, so only exact full-id requests (claude-*) are checked, and only on the Claude CLI:
    // cursor maps a claude-* request to an Auto mode and reports the routed model's display name.
    if (
      input.model !== undefined &&
      input.model.startsWith('claude-') &&
      agentFamily(input.agent.name) === 'claude-cli' &&
      modelUsed !== undefined &&
      modelUsed !== input.model
    ) {
      ctx.log.warn(
        { taskId: ctx.taskId, requested: input.model, served: modelUsed },
        'model mismatch — the provider/gateway served a different model than requested',
      );
    }
    const completed = hasTerminationSignal(finalText);

    const diff = input.copyBack !== false ? await syncSandboxToWorktree(ctx) : '';

    // captureSession pulls the Claude session jsonl from ~/.claude/projects for token-saving resume. Only
    // the claude-CLI providers write there; codex/cursor report a session id but no jsonl, so skip them
    // entirely (no failed copy, no noise). For a claude-family provider the copy should succeed — if it
    // does not, that is a real signal, so log at warn (still non-fatal: capture is an optimization).
    if (sessionId !== undefined && claudeFamily) {
      try {
        const hostDir = await ensureStateDir(ctx.localRepoPath, join(ctx.localRepoPath, '.vanguard', 'sessions', ctx.taskId));
        await captureSession(ctx.sandbox, { home: ctx.home, cwd: WORKDIR, sessionId, hostDir });
      } catch (cause) {
        ctx.log.warn({ taskId: ctx.taskId, sessionId, err: String(cause) }, 'session capture failed');
      }
    }

    const preserved = await ctx.wm.isDirty(ctx.worktreePath);
    const exitReason: ExitReason = completed
      ? 'completed'
      : timeout.signal.aborted
      ? 'timeout'
      : turns >= maxTurns
      ? 'maxTurns'
      : 'incomplete';

    const durationMs = Date.now() - startedAt;

    const result: RunResult = {
      taskId: ctx.taskId,
      completed,
      exitReason,
      turns,
      worktreePath: ctx.worktreePath,
      worktreePreserved: preserved,
      finalText,
      durationMs,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(diff !== '' ? { diff } : {}),
      ...(usage !== undefined ? { usage, cacheEfficiency: cacheEfficiency(usage) } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      ...(modelUsed !== undefined ? { model: modelUsed } : {}),
    };
    // Stage-complete logs ONLY the flat stageMetric (no finalText/diff/transcript/prompt/secrets).
    ctx.log.info(stageMetric(result, input.stageName, input), 'stage complete');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Destroy the sandbox and remove the worktree unless it has uncommitted changes. */
export async function disposeContext(ctx: RunContext, opts: { keep?: boolean } = {}): Promise<void> {
  // Free the host concurrency slot in both cases: a kept sandbox is parked for inspection/resume,
  // not actively running stages, so it should not count against the live-run budget.
  releaseSandboxSlot(ctx.sandbox);
  if (opts.keep === true) return; // leave the sandbox + worktree alive for inspection or resume
  untrackSandbox(ctx.sandbox);
  await ctx.sandbox.destroy().catch((error: unknown) => ctx.log.warn({ error }, 'failed to destroy sandbox'));
  const dirty = await ctx.wm.isDirty(ctx.worktreePath).catch(() => true);
  if (!dirty) {
    await ctx.wm.remove(ctx.worktreePath).catch((error: unknown) => ctx.log.warn({ error }, 'failed to remove worktree'));
  }
}

/** Single-stage convenience: prepare -> one agent run -> dispose. */
export async function run(opts: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const ctx = await prepareContext(
    {
      taskId: opts.taskId,
      localRepoPath: opts.localRepoPath,
      sandbox: opts.sandbox,
      agentName: opts.agent.name,
      // Cut from origin's copy of the base when it is ahead of the local one, so the sandbox, verification
      // and review see the tree the PR will land on (#423). A reused branch keeps its own history.
      baseBranch: opts.baseBranch ?? DEFAULT_BASE_BRANCH,
      start: opts.reuse === true ? 'reuse' : 'base',
      ...(opts.keepLocalIfAhead !== undefined ? { keepLocalIfAhead: opts.keepLocalIfAhead } : {}),
      ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    },
    deps,
  );
  try {
    return await runAgent(ctx, {
      promptTemplate: opts.promptTemplate,
      agent: opts.agent,
      ...(opts.variables !== undefined ? { variables: opts.variables } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.mcpConfig !== undefined ? { mcpConfig: opts.mcpConfig } : {}),
      ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } finally {
    await disposeContext(ctx);
  }
}
