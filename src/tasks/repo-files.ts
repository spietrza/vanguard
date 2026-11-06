import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { execa } from 'execa';
import { VanguardError, visibleError } from '../core/errors.js';
import { MAX_ATTACHMENT_BYTES } from '../wire.js';

/**
 * Composer `@`-mention autocomplete + mention inlining (Editor UX 7/7). Both read the PROJECT repo
 * over the sidecar's query pipe: `listRepoFiles` shells `git ls-files` (the tracked-file universe),
 * `readRepoFile` reads one tracked file capped at MAX_ATTACHMENT_BYTES. Neither writes.
 */

/** How many tracked paths the autocomplete is fed at once. `git ls-files` on a large monorepo is
 * tens of thousands of lines; the picker fuzzy-filters client-side, so a capped slice is plenty and
 * keeps the IPC payload (and the watchdog budget) bounded. `capped` drives a "results truncated" hint. */
export const REPO_FILES_CAP = 2000;

export interface ListRepoFilesResult {
  files: string[];
  capped: boolean;
}

export interface ReadRepoFileResult {
  path: string;
  content: string;
  /** True when the file was truncated to MAX_ATTACHMENT_BYTES — the caller warns and inlines the head. */
  truncated: boolean;
}

/** The tracked files of the project repo (`git ls-files`), sorted, capped to REPO_FILES_CAP. */
export async function listRepoFiles(repoPath: string): Promise<ListRepoFilesResult> {
  let stdout: string;
  try {
    ({ stdout } = await execa('git', ['-C', repoPath, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    throw visibleError(error);
  }
  const all = stdout.split('\0').filter((f) => f !== '');
  all.sort((a, b) => a.localeCompare(b));
  return { files: all.slice(0, REPO_FILES_CAP), capped: all.length > REPO_FILES_CAP };
}

/**
 * A repo-relative path is safe to read iff it is relative, contains no `..` escape, and stays inside
 * the repo. `git ls-files` only ever emits such paths, but the mention text arrives from the webview
 * and must be re-validated here — the sidecar reads with the app's ambient FS rights.
 */
export function resolveRepoFile(repoPath: string, rel: string): string {
  if (rel === '' || isAbsolute(rel) || rel.includes('\0')) {
    throw new VanguardError(`invalid mention path: ${rel}`);
  }
  const norm = normalize(rel);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.includes(`${sep}..${sep}`)) {
    throw new VanguardError(`mention path escapes the repo: ${rel}`);
  }
  return join(repoPath, norm);
}

/** `--error-unmatch` exits nonzero for an untracked or ignored path; `''` is the repo root itself. */
async function assertTracked(repoPath: string, rel: string, shown: string): Promise<void> {
  try {
    if (rel === '') throw new Error('repo root');
    await execa('git', ['-C', repoPath, 'ls-files', '--error-unmatch', '-z', '--', rel]);
  } catch {
    throw new VanguardError(`mention path is not a tracked file: ${shown}`);
  }
}

/** Read one tracked file, capped at MAX_ATTACHMENT_BYTES (UTF-8). Rejects path traversal. */
export async function readRepoFile(repoPath: string, rel: string): Promise<ReadRepoFileResult> {
  const abs = resolveRepoFile(repoPath, rel);
  let buf: Buffer;
  try {
    // Membership FIRST: the mention text is free-form (autocomplete only OFFERS tracked files, it
    // doesn't constrain what the user types), so `@.env`/`@.git/config` would otherwise inline a
    // gitignored secret into a prompt bound for a custom-provider baseUrl (review r3). Only tracked
    // files are readable — `--error-unmatch` exits nonzero for an untracked or ignored path.
    await assertTracked(repoPath, rel, rel);
    // The lexical check above cannot see symlinks: a TRACKED `notes.md -> /etc/passwd` passes both
    // it and the membership check, and readFile would follow the link out of the checkout — with a
    // custom-provider baseUrl that is an exfiltration channel (review r2). Canonicalize BOTH sides
    // and require containment, the same realpath discipline as the image root in complete.ts.
    const [realAbs, realRoot] = await Promise.all([realpath(abs), realpath(repoPath)]);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
      throw new VanguardError(`mention path escapes the repo: ${rel}`);
    }
    // Containment alone still lets a tracked `notes.md -> .env` read an untracked, ignored file
    // inside the checkout: when the path resolved somewhere else, the target must be tracked too.
    const realRel = relative(realRoot, realAbs);
    if (realRel !== normalize(rel)) await assertTracked(realRoot, realRel, rel);
    buf = await readFile(realAbs);
  } catch (error) {
    throw visibleError(error);
  }
  const truncated = buf.length > MAX_ATTACHMENT_BYTES;
  const content = buf.subarray(0, MAX_ATTACHMENT_BYTES).toString('utf8');
  return { path: rel, content, truncated };
}
