import { lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

/**
 * A session id names a single file (`<id>.jsonl`) on the host and in the sandbox, and it is parsed
 * from the sandboxed CLI's output, so the agent controls it. Claude Code ids are UUIDs; accept only
 * that token shape (letters, digits, `-`, `_`; no dots, separators or leading dash) so an id can
 * never carry a path. Anything else is treated as no session.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id);
}

function assertSafeSessionId(id: string): string {
  if (!isSafeSessionId(id)) throw new Error(`unsafe session id: ${JSON.stringify(id).slice(0, 80)}`);
  return id;
}

/** Mirror of the Agent SDK rule: absolute cwd with every non-alphanumeric char -> '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Location of a session transcript inside the sandbox: $HOME/.claude/projects/<enc>/<id>.jsonl */
export function sessionPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${encodeCwd(cwd)}/${assertSafeSessionId(sessionId)}.jsonl`;
}

/** Host file for a session id under `hostDir`; refuses an id or result that escapes `hostDir`. */
export function hostSessionFile(hostDir: string, sessionId: string): string {
  const name = `${assertSafeSessionId(sessionId)}.jsonl`;
  const file = join(hostDir, name);
  // Belt and braces over the id check: the file must be a direct child of hostDir.
  if (relative(hostDir, file) !== name) throw new Error(`session file escapes ${hostDir}`);
  return file;
}

/** The host end of a copy must be a regular file or absent — never a symlink planted in the checkout. */
async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a symlink — refusing to copy through it`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

export interface CaptureOptions {
  home: string;
  cwd: string;
  sessionId: string;
  hostDir: string;
}

/** Pull the session jsonl out of the sandbox to host for token-saving resume. Returns host path. */
export async function captureSession(sandbox: IsolatedSandboxProvider, options: CaptureOptions): Promise<string> {
  const dest = hostSessionFile(options.hostDir, options.sessionId);
  await assertNotSymlink(dest);
  await sandbox.copyFileOut(sessionPath(options.home, options.cwd, options.sessionId), dest);
  return dest;
}

export interface RestoreOptions {
  home: string;
  cwd: string;
  sessionId: string;
  hostFile: string;
}

/** Restore a previously captured jsonl into a fresh sandbox before resume/fork. */
export async function restoreSession(sandbox: IsolatedSandboxProvider, options: RestoreOptions): Promise<void> {
  const target = sessionPath(options.home, options.cwd, options.sessionId);
  // A missing file is left to copyIn to report; a symlink or directory planted there is refused.
  const info = await lstat(options.hostFile).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (info !== undefined && !info.isFile()) throw new Error(`${options.hostFile} is not a regular file — refusing to restore it`);
  await sandbox.copyIn(options.hostFile, target);
}
