/**
 * Cross-process current stage carrier (Tauri has separate run/query children).
 * Kept outside runs/: updates must not invalidate run caches or mark an active run finished.
 */
import { readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir, stateDir } from './state-path.js';
import { readTextNoSymlink, isSafeTaskId } from './run-store.js';

export interface StageMarker {
  taskId: string;
  stage: string;
  index: number;
  of: number;
  updatedAt: string;
}

/** Longer than the 30-min DEFAULT_TIMEOUT_MS per stage, so a healthy stage never ages out mid-run. */
export const STAGE_MARKER_TTL_MS = 60 * 60 * 1000;

function markerDir(repoPath: string): string {
  return join(stateDir(repoPath), 'stage');
}

function markerPath(repoPath: string, taskId: string): string {
  return join(markerDir(repoPath), `${taskId}.json`);
}

/** Write (overwrite) the marker for one task. Best-effort — a marker failure must never fail a run. */
export async function writeStageMarker(repoPath: string, m: StageMarker): Promise<void> {
  if (!isSafeTaskId(m.taskId)) return;
  await ensureStateDir(repoPath, markerDir(repoPath));
  const file = markerPath(repoPath, m.taskId);
  await assertStatePath(repoPath, file);
  await writeFile(file, JSON.stringify(m));
}

/** Remove the marker for one task. Missing marker is a no-op. Best-effort. */
export async function clearStageMarker(repoPath: string, taskId: string): Promise<void> {
  if (!isSafeTaskId(taskId)) return;
  const file = markerPath(repoPath, taskId);
  await assertStatePath(repoPath, file);
  await unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/**
 * Fresh markers only, keyed by taskId: a marker older than STAGE_MARKER_TTL_MS (crashed/SIGKILLed
 * run) reads as absent, so a card can never be pinned at "implementer" forever. Missing directory,
 * a symlinked leaf, or a garbage file are all skipped rather than thrown.
 */
export async function readStageMarkers(repoPath: string): Promise<Map<string, StageMarker>> {
  const dir = markerDir(repoPath);
  const out = new Map<string, StageMarker>();
  let entries;
  try {
    await assertStatePath(repoPath, dir);
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const text = await readTextNoSymlink(join(dir, entry.name));
      const marker = JSON.parse(text) as StageMarker;
      if (typeof marker.taskId !== 'string' || !isSafeTaskId(marker.taskId) || entry.name !== `${marker.taskId}.json`
        || typeof marker.stage !== 'string' || typeof marker.updatedAt !== 'string'
        || !Number.isInteger(marker.index) || !Number.isInteger(marker.of)) continue;
      const updatedMs = Date.parse(marker.updatedAt);
      if (Number.isNaN(updatedMs) || now - updatedMs > STAGE_MARKER_TTL_MS) continue;
      out.set(marker.taskId, marker);
    } catch {
      continue;
    }
  }
  return out;
}
