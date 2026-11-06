// New in the web hub — no Rust/Tauri equivalent (the desktop app used a native OS file dialog).
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

/** Hard cap on entries returned by a single `browseDirs` call — guards against a directory with an
 * enormous number of children (e.g. a flat cache dir) blowing up the response. */
export const MAX_BROWSE_ENTRIES = 2000;

export interface DirEntry {
  name: string;
  path: string; // absolute path
  /** true if this directory directly contains a `.git` entry (file or dir — a worktree's .git is a file). */
  isGitRepo: boolean;
  /** true if this directory directly contains a `.vanguard` entry. */
  hasVanguard: boolean;
}

export interface DirListing {
  /** The directory that was listed (absolute, realpath'd). */
  path: string;
  /** Absolute path of the parent directory, or undefined if `path` IS the confinement root (no further up). */
  parent?: string;
  entries: DirEntry[];
}

/** True if `child` is `root` itself or a real descendant of it (both already realpath'd). */
export function isWithinRoot(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** `add_project`'s confinement: the same realpath-both-sides guard `browseDirs` applies, so a
 * project can only come from somewhere the browse picker could have reached. */
export async function assertWithinBrowseRoot(root: string, path: string): Promise<void> {
  const realRoot = await realpath(root);
  let target: string;
  try {
    target = await realpath(resolve(path));
  } catch {
    throw new BadRequestError('path does not exist');
  }
  if (!isWithinRoot(realRoot, target)) throw new BadRequestError('path escapes the browse root');
}

/** True if an entry (file or dir, any type) exists directly inside `dir` under `name`. */
async function hasMarker(dir: string, name: string): Promise<boolean> {
  try {
    await lstat(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * List the subdirectories of `requestedPath` (default: `root` itself), confined to `root`.
 * Both `root` and the requested path are realpath'd before comparison — this is the traversal
 * guard: joining a `..`-laden path and realpath-ing it catches both literal `..` segments and
 * symlink escapes. Requests that resolve outside `root` throw `BadRequestError`.
 */
export async function browseDirs(root: string, requestedPath?: string): Promise<DirListing> {
  const realRoot = await realpath(root);
  const requested = requestedPath ? resolve(requestedPath) : realRoot;
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    throw new BadRequestError('path does not exist');
  }

  if (!isWithinRoot(realRoot, target)) {
    throw new BadRequestError('path escapes the browse root');
  }

  const dirents = await readdir(target, { withFileTypes: true });
  // Non-directories (including symlinks, which are skipped rather than resolved to classify
  // their target — simpler and avoids any chance of following a symlink cycle) are excluded.
  const names = dirents
    .filter((d) => !d.name.startsWith('.') && d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const capped = names.slice(0, MAX_BROWSE_ENTRIES);

  const entries: DirEntry[] = await Promise.all(
    capped.map(async (name) => {
      const childPath = join(target, name);
      const [isGitRepo, hasVanguard] = await Promise.all([hasMarker(childPath, '.git'), hasMarker(childPath, '.vanguard')]);
      return { name, path: childPath, isGitRepo, hasVanguard };
    }),
  );

  const listing: DirListing = { path: target, entries };

  if (target !== realRoot) {
    const parentDir = dirname(target);
    const realParent = await realpath(parentDir);
    if (realParent !== target) {
      listing.parent = realParent;
    }
  }

  return listing;
}
