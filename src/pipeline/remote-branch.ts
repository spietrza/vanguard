import { execa } from 'execa';
import { redactTokens } from '../core/secret-scan.js';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { neutralizeQuickActions } from '../tasks/gitlab.js';
import type { RunContext } from '../core/vanguard.js';
import { hostGitArgs, hostGitEnv } from '../worktree/host-git.js';

/**
 * The git write path to the remote: push an existing PR branch, rebase a new branch onto the moved
 * base, push it and open the review (gh / glab). Everything a run does to a remote branch after
 * commitStage lives here; pipeline.ts keeps stages, prompts, budget and assembly.
 */

/** `env` is merged over the process env for this one command. */
export type CommandRunner = (file: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;

/** Every command here runs in the run worktree: git gets the hook-free config, gh/glab pass it to the git they spawn. */
const defaultRunner: CommandRunner = async (file, args, cwd, env): Promise<string> =>
  file === 'git'
    ? (await execa(file, hostGitArgs(args), { cwd, ...(env !== undefined ? { env } : {}) })).stdout
    : (await execa(file, args, { cwd, env: { ...hostGitEnv(), ...env } })).stdout;

export interface PublishOptions {
  title: string;
  body?: string;
  /** Git identity for the pre-push rebase (same default as commitStage). */
  authorName?: string;
  authorEmail?: string;
  draft?: boolean;
  remote?: string;
  /** CLI tool to use for PR/MR creation. Default 'gh' (GitHub). Use 'glab' for GitLab MRs. */
  cli?: 'gh' | 'glab';
  /**
   * gh only: open the PR as this token's owner (GH_TOKEN for `gh pr create`). A PR opened with the
   * workflow's GITHUB_TOKEN fires no `pull_request` workflows (recursion guard), so it sits with no CI
   * until someone pushes. Refused (e.g. no Pull requests: write) → opens with the ambient credential.
   */
  prToken?: string;
  /** Injected for tests; defaults to running git/gh via execa. */
  runner?: CommandRunner;
}

export interface PublishOutcome {
  branch: string;
  prUrl: string;
  /** The pushed head (after the pre-push rebase, if any); undefined when rev-parse was unavailable. */
  headSha?: string;
}

export interface PushToExistingBranchOptions {
  /** The PR head branch name on the remote (e.g. 'fix-auth'). */
  prHeadRef: string;
  remote?: string;
  /**
   * When set (non-empty), the push authenticates with this token instead of the ambient
   * credential — this is what makes the push fire a `synchronize` event instead of being
   * suppressed by GitHub's GITHUB_TOKEN recursion guard.
   */
  pushToken?: string;
  /** GitHub host for the credential scope; default 'github.com'. */
  host?: string;
  /** Injected for tests; defaults to running git via execa. */
  runner?: CommandRunner;
}

function encodeBasicAuthToken(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/** Build the `git -c …` prefix that overrides the ambient credential for one push. */
export function pushAuthConfigArgs(token: string, host = 'github.com'): string[] {
  return ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${encodeBasicAuthToken(token)}`];
}

/** Strip a leaked basic-auth credential (base64 of x-access-token:<PAT>) from an error message. */
function redactPushAuthError(err: unknown, token: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message.split(encodeBasicAuthToken(token)).join('***');
  return new Error(redacted);
}

/**
 * Push the worktree's current HEAD to an existing remote branch (the PR head ref), updating
 * the PR in place. Unlike publishForReview, this never creates a new PR.
 * Runs: `git push <remote> HEAD:<prHeadRef>` in ctx.worktreePath.
 */
export async function pushToExistingBranch(ctx: RunContext, opts: PushToExistingBranchOptions): Promise<void> {
  const run = opts.runner ?? defaultRunner;
  const auth = opts.pushToken ? pushAuthConfigArgs(opts.pushToken, opts.host) : [];
  try {
    await run('git', [...auth, 'push', '--no-verify', opts.remote ?? 'origin', `HEAD:${opts.prHeadRef}`], ctx.worktreePath);
  } catch (err) {
    if (opts.pushToken) {
      throw redactPushAuthError(err, opts.pushToken);
    }
    throw err;
  }
}

const DROPPED_CI_LISTED = 20;

/**
 * PR/MR body (and revision summary) note for CI config the agent changed but copy-back dropped, so the
 * review does not look complete. Brand-neutral for white-label runs. Paths come from the sandbox, so
 * they are reduced to a plain charset that cannot add markdown or HTML.
 */
export function droppedCiPathsNote(paths: Iterable<string> = []): string {
  const sorted = [...paths].sort();
  if (sorted.length === 0) return '';
  const shown = sorted.slice(0, DROPPED_CI_LISTED).map((p) => `\`${p.replace(/[^\w./ -]/g, '?')}\``);
  const more = sorted.length > DROPPED_CI_LISTED ? ` and ${sorted.length - DROPPED_CI_LISTED} more` : '';
  return `**Not included:** changes to CI config are never copied into this branch: ${shown.join(', ')}${more}. Apply them by hand if this change needs them.`;
}

export interface RebaseOntoRemoteBaseOptions {
  remote: string;
  base: string;
  /** The task branch; the rebase is skipped when it already exists on the remote. */
  branch: string;
  authorName?: string;
  authorEmail?: string;
  log?: (line: string) => void;
}

/**
 * Rebase the task branch onto the remote base when the branch is behind it. The worktree is cut from
 * RunContext.startRef (the base as origin had it when the run began, or the local copy), so a commit
 * that lands on the remote base mid-run — typically a Dependabot workflow bump — leaves the branch
 * behind. GitHub compares a NEW branch's workflow files against the default branch, so a stale
 * `.github/workflows/*` is then rejected as a workflow update the token may not make (#423), even
 * though the agent never touched those files. Never worse than pushing as-is: every git failure here
 * is logged and the push proceeds unchanged (only the stale-workflow case is then still rejected by
 * GitHub, exactly as before). Compares HEAD, not startRef, against FETCH_HEAD: a reused branch was
 * cut from an older base than the one its run resolved, and it is the branch's own distance that
 * decides whether the push would be stale. FETCH_HEAD is what `git fetch <remote> <base>` always
 * writes (a single-branch clone creates no `refs/remotes/<remote>/<base>` for another base). Returns
 * true when the branch was rebased.
 */
export async function rebaseOntoRemoteBase(run: CommandRunner, cwd: string, opts: RebaseOntoRemoteBaseOptions): Promise<boolean> {
  assertSafeBaseBranch(opts.base);   // `main:refs/heads/x` or `+main` would make the fetch a writing refspec
  const log = opts.log ?? ((line: string): void => console.log(line));
  const target = `${opts.remote}/${opts.base}`;
  // GitHub compares workflow files with the default branch only for a NEW branch. An existing remote
  // branch (a --reuse re-run) was already pushed: rebasing it would make the plain push non-fast-forward.
  try {
    await run('git', ['ls-remote', '--exit-code', '--heads', '--end-of-options', opts.remote, opts.branch], cwd);
    return false;
  } catch {
    // exit 2: no such remote branch — proceed; any other failure surfaces at the fetch below.
  }
  try {
    await run('git', ['fetch', '--end-of-options', opts.remote, opts.base], cwd);
  } catch (cause) {
    log(`publish: could not fetch ${target}, pushing as-is (${errorMessage(cause)})`);
    return false;
  }
  let behind: string;
  try {
    // Last non-empty line: a stray warning ahead of the count must not disable the fix.
    behind = (await run('git', ['rev-list', '--count', 'HEAD..FETCH_HEAD'], cwd)).trim().split('\n').at(-1) ?? '';
  } catch (cause) {
    log(`publish: could not compare the branch with ${target}, pushing as-is (${errorMessage(cause)})`);
    return false;
  }
  const behindCount = Number.parseInt(behind, 10);
  if (Number.isNaN(behindCount) || behindCount <= 0) return false;
  // The host worktree has no git identity; rebase replays commits and needs one (same as commitStage).
  const name = opts.authorName ?? 'Vanguard';
  const email = opts.authorEmail ?? 'vanguard@local';
  try {
    await run('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'rebase', '--no-verify', 'FETCH_HEAD'], cwd);
  } catch (cause) {
    await run('git', ['rebase', '--abort'], cwd).catch(() => undefined);
    log(`publish: ${opts.base} moved during the run (${behind} new commit(s) on ${target}) but the branch does not rebase onto it, pushing as-is: ${errorMessage(cause)}`);
    return false;
  }
  log(`publish: rebased onto ${target} (${behind} new commit(s) on the base since the run started)`);
  return true;
}

/** First lines of a git error (enough for a conflict's file list), URL userinfo (`https://user:token@host`) masked. */
function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return redactTokens(text).split('\n').slice(0, 3).join(' | ').replace(/\/\/[^/@\s]+@/g, '//***@');
}

/** PR body note when the branch was rebased before the push. Brand-neutral: white-label bodies carry it too. */
export function rebasedNote(remote: string, base: string): string {
  return `Rebased onto \`${remote}/${base}\` before publishing: the base moved while this change was being prepared.`;
}

/** Open the PR/MR. With a prToken (gh only) try as the token's owner first: a refused token must not lose the run's work. */
async function openReview(run: CommandRunner, tool: string, args: string[], ctx: RunContext, opts: PublishOptions): Promise<string> {
  if (tool !== 'gh' || opts.prToken === undefined || opts.prToken === '') return run(tool, args, ctx.worktreePath);
  try {
    return await run(tool, args, ctx.worktreePath, { GH_TOKEN: opts.prToken });
  } catch (cause) {
    ctx.log.warn({ branch: ctx.branch }, `publish: opening the PR with the push token failed, using the ambient credential (the PR gets no CI until a push): ${errorMessage(cause)}`);
    return run(tool, args, ctx.worktreePath);
  }
}

/**
 * Merger review output: push the worktree branch and open a GitHub PR for human/CI review.
 * Outward-facing and opt-in — call after commitStage and before disposeContext. GitHub is the
 * review surface only; the task source of truth (e.g. Linear) is separate.
 */
export async function publishForReview(ctx: RunContext, opts: PublishOptions): Promise<PublishOutcome> {
  const run = opts.runner ?? defaultRunner;
  const tool = opts.cli ?? 'gh';
  // --no-verify skips the target repo's pre-push hook (e.g. a Conventional-Branch name check that
  // rejects Vanguard's `vanguard/…` branch prefix). The remote enforces no such rule; this is a local
  // husky gate, redundant with Vanguard's own review + the PR's CI.
  const remote = opts.remote ?? 'origin';
  // The base comes from the context: the same branch the worktree was prepared for, no default here.
  const base = ctx.baseBranch;
  const rebased = await rebaseOntoRemoteBase(run, ctx.worktreePath, {
    remote,
    base,
    branch: ctx.branch,
    log: (line) => ctx.log.info({ branch: ctx.branch }, line),
    ...(opts.authorName !== undefined ? { authorName: opts.authorName } : {}),
    ...(opts.authorEmail !== undefined ? { authorEmail: opts.authorEmail } : {}),
  });
  // A rebase rewrites the commit: callers must use this SHA (review marker, verdict header), not the
  // one commitStage returned. The branch ref, not HEAD: after a failed `rebase --abort` HEAD may be
  // detached mid-rebase while the push still sends the branch.
  const headSha = (await run('git', ['rev-parse', `refs/heads/${ctx.branch}`], ctx.worktreePath).catch(() => '')).trim();
  if (rebased && headSha === '') {
    ctx.log.warn({ branch: ctx.branch }, 'publish: rebased but could not resolve the branch head; the review marker will name the pre-rebase commit');
  }
  await run('git', ['push', '--no-verify', '-u', remote, ctx.branch], ctx.worktreePath);
  const body = [opts.body, droppedCiPathsNote(ctx.droppedCiPaths), rebased ? rebasedNote(remote, base) : undefined]
    .filter((part) => part !== undefined && part !== '').join('\n\n');
  let args: string[];
  if (tool === 'glab') {
    args = [
      'mr', 'create',
      '--source-branch', ctx.branch,
      '--target-branch', base,
      '--title', opts.title,
      '--description', neutralizeQuickActions(body),
    ];
    if (opts.draft === true) args.push('--draft');
  } else {
    args = [
      'pr', 'create',
      '--head', ctx.branch,
      '--base', base,
      '--title', opts.title,
      '--body', body,
    ];
    if (opts.draft === true) args.push('--draft');
  }
  const out = await openReview(run, tool, args, ctx, opts);
  const prUrl =
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('http'))
      .pop() ?? out.trim();
  return { branch: ctx.branch, prUrl, ...(headSha !== '' ? { headSha } : {}) };
}
