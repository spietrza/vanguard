import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeBaseBranch } from '../core/base-branch.js';
import { WorktreeError } from '../core/errors.js';
import { hostGitArgs } from './host-git.js';

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Branch prefix for every Vanguard run. Conventional-Branch compliant (`<type>/<description>`, lowercase,
 * hyphens): the type is `chore` and `vanguard-` marks the namespace so `gc` reaps only Vanguard branches,
 * not humans' `chore/*`. A plain `vanguard/` prefix is rejected by repos that enforce Conventional Branch
 * (the type must be one of feat/fix/bugfix/hotfix/release/chore/refactor/docs/test/ci).
 */
export const VANGUARD_BRANCH_PREFIX = 'chore/vanguard-';

export interface CreateOptions {
  /** Reuse an existing <prefix><id>-* branch instead of minting a new run id. */
  reuse?: boolean;
  /** Override the branch prefix (default VANGUARD_BRANCH_PREFIX). White-label mode uses e.g. `feat/`. */
  branchPrefix?: string;
  /** Override the branch/path id (default taskId). White-label mode uses the bare issue number. */
  branchId?: string;
}

/** Short, unique-per-run id so re-running the same task never collides on an existing branch/path. */
const defaultRunId = (): string => randomUUID().slice(0, 8);

function parseWorktreeList(output: string): Array<{ path: string; branch: string }> {
  const result: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length);
    } else if (line === '' && cur.path && cur.branch) {
      result.push({ path: cur.path, branch: cur.branch });
      cur = {};
    }
  }
  if (cur.path && cur.branch) result.push({ path: cur.path, branch: cur.branch });
  return result;
}

export class WorktreeManager {
  constructor(
    private readonly repoPath: string,
    private readonly baseDir: string = join(repoPath, '.vanguard', 'worktrees'),
    private readonly newRunId: () => string = defaultRunId,
  ) {}

  async create(taskId: string, baseBranch: string = 'main', opts: CreateOptions = {}): Promise<Worktree> {
    assertSafeBaseBranch(baseBranch);
    const prefix = opts.branchPrefix ?? VANGUARD_BRANCH_PREFIX;
    const id = opts.branchId ?? taskId;
    if (opts.reuse) {
      const existing = await this.findExistingBranch(id, prefix);
      if (existing) return existing;
    }
    // Append a unique run id: disposeContext removes the worktree but not the branch, and a prior
    // run also leaves a remote branch, so reusing `<prefix><id>` collides on re-run.
    const name = `${id}-${this.newRunId()}`;
    const branch = `${prefix}${name}`;
    const path = join(this.baseDir, name);
    try {
      await execa('git', hostGitArgs(['worktree', 'add', '-b', branch, path, baseBranch]), { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to create worktree for ${taskId}`, { cause });
    }
  }

  private async findExistingBranch(id: string, prefix: string = VANGUARD_BRANCH_PREFIX): Promise<Worktree | null> {
    let branchOut: string;
    let wtOut: string;
    try {
      [{ stdout: branchOut }, { stdout: wtOut }] = await Promise.all([
        execa('git', ['branch', '--list', `${prefix}${id}-*`], { cwd: this.repoPath }),
        execa('git', ['worktree', 'list', '--porcelain'], { cwd: this.repoPath }),
      ]);
    } catch (cause) {
      throw new WorktreeError(`Failed to query git state for ${id}`, { cause });
    }
    const branch = branchOut
      .split('\n')
      .map(b => b.trim().replace(/^[*+] /, ''))
      .find(Boolean);
    if (!branch) return null;

    // Use create()'s own path form: git reports a symlink-resolved path (e.g. /private/var on macOS),
    // which would not string-equal the join(baseDir, name) that create() returns.
    const name = branch.slice(prefix.length);
    const path = join(this.baseDir, name);

    // If a live worktree already uses this branch, reuse it.
    const live = parseWorktreeList(wtOut).find((w) => w.branch === `refs/heads/${branch}`);
    if (live) return { path, branch };

    // Branch exists but its worktree was removed — recreate the worktree on the existing branch.
    try {
      await execa('git', hostGitArgs(['worktree', 'add', path, branch]), { cwd: this.repoPath });
      return { path, branch };
    } catch (cause) {
      throw new WorktreeError(`Failed to reuse worktree for ${id}`, { cause });
    }
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execa('git', hostGitArgs(['status', '--porcelain']), { cwd: worktreePath });
      return stdout.trim() !== '';
    } catch (cause) {
      throw new WorktreeError(`Failed to check worktree status ${worktreePath}`, { cause });
    }
  }

  async diff(worktreePath: string): Promise<string> {
    try {
      // -N (intent-to-add) so brand-new untracked files appear in `git diff HEAD`.
      await execa('git', hostGitArgs(['add', '-A', '-N']), { cwd: worktreePath });
      const { stdout } = await execa('git', hostGitArgs(['diff', 'HEAD']), { cwd: worktreePath });
      return stdout;
    } catch (cause) {
      throw new WorktreeError(`Failed to get worktree diff ${worktreePath}`, { cause });
    }
  }

  /**
   * Paths the worktree changes against HEAD, new files included and both sides of a rename listed.
   * NUL-separated, so no quoting, and unaffected by diff prefix or rename settings in the user's config.
   */
  async changedPaths(worktreePath: string): Promise<string[]> {
    try {
      await execa('git', hostGitArgs(['add', '-A', '-N']), { cwd: worktreePath });
      const { stdout } = await execa('git', hostGitArgs(['diff', 'HEAD', '--name-only', '--no-renames', '-z']), { cwd: worktreePath });
      return stdout.split('\0').filter((path) => path !== '');
    } catch (cause) {
      throw new WorktreeError(`Failed to list worktree changes ${worktreePath}`, { cause });
    }
  }

  /**
   * Commit messages in `<baseRef>..HEAD`, for the commit-message closing-keyword scan (a rebase
   * merge closes an issue per commit message, regardless of the PR body). Best-effort: returns []
   * (never throws) when `baseRef` can't be resolved locally.
   */
  async commitMessages(worktreePath: string, baseRef: string): Promise<string[]> {
    try {
      const { stdout } = await execa('git', hostGitArgs(['log', `${baseRef}..HEAD`, '--format=%B%x00']), { cwd: worktreePath });
      return stdout
        .split('\0')
        .map((m) => m.trim())
        .filter((m) => m !== '');
    } catch {
      return [];
    }
  }

  async remove(worktreePath: string, force: boolean = false): Promise<void> {
    try {
      await execa('git', ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], { cwd: this.repoPath });
    } catch (cause) {
      throw new WorktreeError(`Failed to remove worktree ${worktreePath}`, { cause });
    }
  }
}
