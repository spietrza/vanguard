// New in slice 1: the server-side repo allowlist (pulled forward from wave 2 — see docs/hub.md).
// Every hub RPC handler that takes a `repoPath` resolves it through `ProjectAllowlist.assertAllowed`,
// which requires exact (realpath'd) membership in the live project set: the persisted project store
// plus the `--repo` seed. A free-text absolute path reaching sandbox execution is the difference
// between "a local tool" and "arbitrary-repo execution for anyone who reaches the port".
import { lstat, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

/** Mirror of active.rs `is_session_path`: only a real `.vanguard/sessions/**.jsonl` path qualifies. */
export function isSessionPathGrammar(p: string): boolean {
  if (p.includes('..')) return false;
  if (!p.toLowerCase().endsWith('.jsonl')) return false;
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === '.vanguard' && parts[i + 1] === 'sessions') return true;
  }
  return false;
}

/** Index of the `.vanguard` segment of a `.vanguard/sessions/...` path, or -1 if absent. Operates on
 * the REALPATH'd string, so a symlinked `.vanguard` (whose name would disappear under realpath)
 * cannot be used to smuggle a path outside an allowed project. */
function vanguardSessionsSegmentIndex(realPath: string): number {
  const parts = realPath.split(sep);
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === '.vanguard' && parts[i + 1] === 'sessions') return i;
  }
  return -1;
}

export interface BindOptions {
  isLoopback: boolean;
  allowAdd: boolean;
}

/** `add_project`/`browse_dirs` are extension points that can only widen the allowlist, so on a
 * non-loopback bind (reachable by more than the operator) they require an explicit opt-in. */
export function assertMutationsAllowed(opts: BindOptions): void {
  if (!opts.isLoopback && !opts.allowAdd) {
    throw new BadRequestError(
      'add_project and browse_dirs are disabled on a non-loopback bind — set VANGUARD_HUB_ALLOW_ADD=1 to allow them',
    );
  }
}

/** `add_project`'s validation: the path must be a directory containing a `.git` entry (file or dir —
 * a worktree's `.git` is a file). */
export async function assertGitWorkTreeDir(path: string): Promise<void> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new BadRequestError(`${path} does not exist or is not readable`);
  }
  if (!st.isDirectory()) throw new BadRequestError(`${path} is not a directory`);
  try {
    await lstat(join(path, '.git'));
  } catch {
    throw new BadRequestError(`${path} is not a git work tree (no .git entry)`);
  }
}

/**
 * Live allowlist of project real paths: the persisted project store (read on demand via the injected
 * `listProjectPaths`, so additions/removals take effect immediately) plus the `--repo` seed given at
 * startup (always allowed even before it's been added to the store).
 */
export class ProjectAllowlist {
  constructor(
    private readonly listProjectPaths: () => Promise<string[]>,
    private readonly seedRepoPath?: string,
  ) {}

  private async liveRealPaths(): Promise<Set<string>> {
    const raw = [...(await this.listProjectPaths())];
    if (this.seedRepoPath !== undefined) raw.push(this.seedRepoPath);
    const out = new Set<string>();
    for (const p of raw) {
      try {
        out.add(await realpath(p));
      } catch {
        // A project whose path no longer exists is simply not allowed — not a fatal condition.
      }
    }
    return out;
  }

  /** Resolve `repoPath` and require exact membership in the live allowed set. Returns the realpath. */
  async assertAllowed(repoPath: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(repoPath);
    } catch {
      throw new BadRequestError(`repoPath does not exist: ${repoPath}`);
    }
    const live = await this.liveRealPaths();
    if (!live.has(real)) {
      throw new BadRequestError(`repoPath is not an allowed project: ${repoPath}`);
    }
    return real;
  }

  /** `read_session`'s extra rule: the path must look like a Vanguard session log AND live under an
   * allowed project. Returns the realpath of the session file. */
  async assertSessionPath(sessionFile: string): Promise<string> {
    if (!isSessionPathGrammar(sessionFile)) {
      throw new BadRequestError('not a vanguard session file');
    }
    // A session log is a regular file; a symlink at the leaf (e.g. one copied out of a sandbox) is refused
    // rather than resolved and followed.
    const info = await lstat(sessionFile).catch(() => undefined);
    if (info !== undefined && !info.isFile()) {
      throw new BadRequestError('not a vanguard session file');
    }
    let real: string;
    try {
      real = await realpath(sessionFile);
    } catch {
      throw new BadRequestError(`session file does not exist: ${sessionFile}`);
    }
    const idx = vanguardSessionsSegmentIndex(real);
    if (idx <= 0) {
      throw new BadRequestError('not a vanguard session file');
    }
    const repoPath = idx === 0 ? sep : real.split(sep).slice(0, idx).join(sep);
    await this.assertAllowed(repoPath);
    return real;
  }
}
