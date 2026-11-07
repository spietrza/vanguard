// listRemoteRuns ports apps/desktop/src-tauri/src/remote.rs; fetchRemoteRun is new (CI artifact import).
import { execa } from 'execa';
import { cp, lstat, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { assertStatePath, ensureStateDir } from '../core/state-path.js';
import { isRunRecordFile, listRunSummaries, remoteRunsRoot } from './runs.js';
import type { RemoteImport, RemoteRun, RunSummary } from '../wire.js';

// RemoteRun/RemoteImport live in src/wire.ts (the drift-tested TS<->TS contract); re-exported here
// so callers can keep importing them from './remote.js'.
export type { RemoteImport, RemoteRun } from '../wire.js';

/** Injectable shell-out, defaulting to the real `execa` — tests pass a fake. */
export interface Exec {
  (file: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: Exec = (file, args, options) => execa(file, args, options);

/** Hard ceiling on an imported artifact's file count — a runaway/malicious artifact shouldn't fill the disk. */
const MAX_IMPORT_FILES = 5000;
/** Hard ceiling on an imported artifact's total byte size. */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

function strOf(v: unknown, key: string): string {
  if (typeof v !== 'object' || v === null) return '';
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function parseRuns(json: unknown): Omit<RemoteRun, 'cached'>[] {
  if (!Array.isArray(json)) {
    throw new Error('unexpected gh output');
  }
  return json.map((r) => {
    const idValue = typeof r === 'object' && r !== null ? (r as Record<string, unknown>).databaseId : undefined;
    const id = typeof idValue === 'number' ? idValue : 0;
    return {
      id,
      status: strOf(r, 'status'),
      conclusion: strOf(r, 'conclusion'),
      title: strOf(r, 'displayTitle'),
      branch: strOf(r, 'headBranch'),
      workflow: strOf(r, 'workflowName'),
      createdAt: strOf(r, 'createdAt'),
      event: strOf(r, 'event'),
      url: strOf(r, 'url'),
    };
  });
}

/** The run's cached summaries, already imported into `<repoPath>/.vanguard/remote-runs/<id>` by a
 * prior `fetchRemoteRun`, or `[]` if not yet imported (or unreadable). */
async function cachedRunSummaries(repoPath: string, runId: number): Promise<RunSummary[]> {
  try {
    return await listRunSummaries(remoteRunsRoot(repoPath, runId));
  } catch {
    return [];
  }
}

function toRemoteImport(runId: number, runs: RunSummary[]): RemoteImport {
  return { runId, taskIds: [...new Set(runs.map((r) => r.taskId))], runs, cachedAt: new Date().toISOString() };
}

function isEnoentFlavored(message: string): boolean {
  return /ENOENT|not found/i.test(message);
}

/** List recent CI runs for a repo via `gh run list` (GitHub Actions). Mirrors remote.rs's list_remote_runs. */
export async function listRemoteRuns(repoPath: string, exec: Exec = defaultExec): Promise<RemoteRun[]> {
  let result;
  try {
    result = await exec(
      'gh',
      [
        'run',
        'list',
        '-L',
        '30',
        '--json',
        'databaseId,status,conclusion,displayTitle,headBranch,workflowName,createdAt,event,url',
      ],
      { cwd: repoPath },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isEnoentFlavored(message)) {
      throw new Error(`\`gh\` not available: ${message}`);
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : message;
    throw new Error(`\`gh run list\` failed: ${text.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('`gh run list` failed: unexpected gh output');
  }
  let runs: Omit<RemoteRun, 'cached'>[];
  try {
    runs = parseRuns(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`\`gh run list\` failed: ${message}`);
  }
  return Promise.all(runs.map(async (r) => ({ ...r, cached: (await cachedRunSummaries(repoPath, r.id)).length > 0 })));
}

/** Recursively walk `root`, rejecting symlinks and enforcing file-count/byte-size ceilings. */
async function validateImportTree(root: string): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        await rm(root, { recursive: true, force: true });
        throw new BadRequestError(`CI artifact contains a symlink (${entryPath}) — refusing to import`);
      }
      if (info.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      fileCount += 1;
      totalBytes += info.size;
      if (fileCount > MAX_IMPORT_FILES) {
        await rm(root, { recursive: true, force: true });
        throw new BadRequestError(`CI artifact exceeds ${MAX_IMPORT_FILES} files — refusing to import`);
      }
      if (totalBytes > MAX_IMPORT_BYTES) {
        await rm(root, { recursive: true, force: true });
        throw new BadRequestError(`CI artifact exceeds ${MAX_IMPORT_BYTES} bytes — refusing to import`);
      }
    }
  }

  await walk(root);
}

/** True if `dir` has at least one subdirectory containing at least one run-record `*.json` file. */
async function hasRunShape(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(dir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    if (files.some((f) => f.isFile() && isRunRecordFile(f.name))) {
      return true;
    }
  }
  return false;
}

/**
 * Defensively locate the runs-shaped directory inside an extracted artifact, at most 3 levels
 * deep: the artifact's internal layout is decided by a workflow step that doesn't exist yet.
 */
async function findRunsDir(tmpdirPath: string): Promise<string | undefined> {
  const relCandidates = ['.', 'runs', join('.vanguard', 'runs')];
  for (const rel of relCandidates) {
    const candidate = join(tmpdirPath, rel);
    if (await hasRunShape(candidate)) return candidate;
  }
  let topEntries;
  try {
    topEntries = await readdir(tmpdirPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    for (const rel of relCandidates) {
      const candidate = join(tmpdirPath, top.name, rel);
      if (await hasRunShape(candidate)) return candidate;
    }
  }
  return undefined;
}

async function topLevelEntryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Import a CI run's `vanguard-runs` artifact into `<repoPath>/.vanguard/remote-runs/<runId>/` and
 * return a summary of what was imported.
 */
export async function fetchRemoteRun(repoPath: string, runId: number, exec: Exec = defaultExec): Promise<RemoteImport> {
  const cachedRuns = await cachedRunSummaries(repoPath, runId);
  if (cachedRuns.length > 0) {
    return toRemoteImport(runId, cachedRuns);
  }
  const importDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-import-'));

  try {
    await exec('gh', ['run', 'download', String(runId), '-n', 'vanguard-runs', '--dir', importDir], {
      cwd: repoPath,
      timeout: 120_000,
    });
  } catch (error) {
    await rm(importDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : message;
    // gh wording seen live: "no valid artifacts found to download" (run without the artifact or still in progress).
    if (/no (?:valid )?artifacts?|not found/i.test(text)) {
      throw new BadRequestError(
        `CI run ${runId} has no "vanguard-runs" artifact — the workflow must upload .vanguard/runs (see docs/hub.md § CI run import)`,
      );
    }
    if (isEnoentFlavored(text)) {
      throw new Error(`\`gh\` not available: ${text}`);
    }
    throw new Error(text);
  }

  await validateImportTree(importDir);

  const runsDir = await findRunsDir(importDir);
  if (runsDir === undefined) {
    const found = await topLevelEntryNames(importDir);
    await rm(importDir, { recursive: true, force: true });
    throw new BadRequestError(
      `CI run ${runId}'s "vanguard-runs" artifact doesn't contain a recognizable runs tree (found: ${found.join(', ') || '<empty>'}) — see docs/hub.md § CI run import`,
    );
  }

  const remoteRunsBase = join(repoPath, '.vanguard', 'remote-runs');
  const finalDir = join(remoteRunsBase, String(runId));
  const tmpDest = `${finalDir}.tmp`;
  const gitignorePath = join(remoteRunsBase, '.gitignore');

  // The destination is inside the checkout: a committed symlink at `.vanguard`, `remote-runs` or any
  // of these leaves would point the recursive deletes and the copy outside it.
  try {
    for (const path of [finalDir, tmpDest, gitignorePath]) await assertStatePath(repoPath, path);
    await ensureStateDir(repoPath, remoteRunsBase);
  } catch (error) {
    await rm(importDir, { recursive: true, force: true });
    throw error;
  }
  await rm(tmpDest, { recursive: true, force: true });
  await cp(runsDir, tmpDest, { recursive: true });
  await rm(finalDir, { recursive: true, force: true });
  await rename(tmpDest, finalDir);

  try {
    await writeFile(gitignorePath, '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  await rm(importDir, { recursive: true, force: true });

  const runs = await listRunSummaries(remoteRunsRoot(repoPath, runId));
  return toRemoteImport(runId, runs);
}
