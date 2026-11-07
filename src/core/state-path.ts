import type { Stats } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { StatePathError } from './errors.js';

/** The per-repo state directory every host-side run artifact lives under. */
export function stateDir(repoPath: string): string {
  return join(repoPath, '.vanguard');
}

/**
 * Refuse a host write or delete at `target` (a path under `<repo>/.vanguard`) that would follow a
 * symlink out of the checkout. The checkout is target-repo content, so a repo can commit `.vanguard`,
 * any directory below it or the leaf file itself as a symlink. Walks every component from `.vanguard`
 * down to `target` with lstat: a symlink anywhere refuses, and so does an intermediate component that
 * exists but is not a directory. Absent components are fine — the caller creates them as real ones.
 * The repo path itself is operator-chosen and may legitimately sit behind a symlink (e.g. macOS /tmp).
 */
export async function assertStatePath(repoPath: string, target: string): Promise<void> {
  const base = stateDir(repoPath);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StatePathError(`${target} is outside ${base} — refusing to operate on it`);
  }
  const components = rel === '' ? [] : rel.split(sep);
  let current = base;
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = join(current, components[i] as string);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing below exists yet
      throw e;
    }
    if (info.isSymbolicLink()) throw new StatePathError(`${current} is a symlink — refusing to operate on it`);
    if (i < components.length - 1 && !info.isDirectory()) {
      throw new StatePathError(`${current} is not a directory — refusing to operate on it`);
    }
  }
}

/** {@link assertStatePath}, then create `dir` (and any missing parents) as real directories. */
export async function ensureStateDir(repoPath: string, dir: string): Promise<string> {
  await assertStatePath(repoPath, dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Guard against path traversal: a task id must name a single direct child of a state subdirectory. */
export function isSafeTaskId(taskId: string): boolean {
  return taskId !== '' && !taskId.includes('/') && !taskId.includes('\\') && !taskId.includes('..') && !isAbsolute(taskId);
}
