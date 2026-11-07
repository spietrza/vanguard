import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStageMarker, readStageMarkers, writeStageMarker, STAGE_MARKER_TTL_MS } from './run-stage-marker.js';
import { fingerprint, listRuns, runsRoot } from './run-store.js';
import { listActive } from '../hub/active.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-stage-marker-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('run-stage-marker (T10-T14)', () => {
  it('T10: write then read returns the marker; a second write overwrites it', async () => {
    await writeStageMarker(repo, { taskId: 'gh-1', stage: 'implementer', index: 0, of: 3, updatedAt: new Date().toISOString() });
    let markers = await readStageMarkers(repo);
    expect(markers.get('gh-1')?.stage).toBe('implementer');

    const later = new Date(Date.now() + 1000).toISOString();
    await writeStageMarker(repo, { taskId: 'gh-1', stage: 'reviewer', index: 1, of: 3, updatedAt: later });
    markers = await readStageMarkers(repo);
    expect(markers.size).toBe(1);
    expect(markers.get('gh-1')).toEqual({ taskId: 'gh-1', stage: 'reviewer', index: 1, of: 3, updatedAt: later });
  });

  it('T11: clearStageMarker removes it; clearing a missing marker is a no-op', async () => {
    await writeStageMarker(repo, { taskId: 'gh-2', stage: 'implementer', index: 0, of: 1, updatedAt: new Date().toISOString() });
    await clearStageMarker(repo, 'gh-2');
    expect((await readStageMarkers(repo)).has('gh-2')).toBe(false);
    await expect(clearStageMarker(repo, 'gh-2')).resolves.toBeUndefined();
    await expect(clearStageMarker(repo, 'gh-missing')).resolves.toBeUndefined();
  });

  it('T12: a marker older than STAGE_MARKER_TTL_MS is not returned', async () => {
    const stale = new Date(Date.now() - STAGE_MARKER_TTL_MS - 1).toISOString();
    await writeStageMarker(repo, { taskId: 'gh-3', stage: 'implementer', index: 0, of: 1, updatedAt: stale });
    expect((await readStageMarkers(repo)).has('gh-3')).toBe(false);
  });

  it('T13: a symlinked marker file reads as absent; a traversal taskId is rejected before any FS access', async () => {
    await mkdir(join(repo, '.vanguard', 'stage'), { recursive: true });
    const outside = join(repo, 'outside.json');
    await writeFile(outside, JSON.stringify({ taskId: 'gh-4', stage: 'implementer', index: 0, of: 1, updatedAt: new Date().toISOString() }));
    await symlink(outside, join(repo, '.vanguard', 'stage', 'gh-4.json'));
    expect((await readStageMarkers(repo)).has('gh-4')).toBe(false);

    await expect(writeStageMarker(repo, { taskId: '../escape', stage: 'x', index: 0, of: 1, updatedAt: new Date().toISOString() })).resolves.toBeUndefined();
    await expect(clearStageMarker(repo, '/abs')).resolves.toBeUndefined();
    const markers = await readStageMarkers(repo);
    expect(markers.has('../escape')).toBe(false);
  });

  it('T14: writing a marker does not touch the runs fingerprint/listRuns, and listActive still reports the task active', async () => {
    const taskId = 'gh-5';
    const taskDir = join(runsRoot(repo), taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, '2026-01-01T00-00-00-000Z-implementer.json'),
      JSON.stringify({ taskId, completed: true, exitReason: 'done', turns: 1, worktreePath: '/tmp', worktreePreserved: false, finalText: '', timestamp: '2026-01-01T00:00:00.000Z', stage: 'implementer' }),
    );
    const sessionsDir = join(repo, '.vanguard', 'sessions', taskId);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'session.jsonl'), '{}\n');

    const old = new Date(Date.now() - 300_000);
    await utimes(join(taskDir, '2026-01-01T00-00-00-000Z-implementer.json'), old, old);
    const fpBefore = await fingerprint(runsRoot(repo));
    const runsBefore = await listRuns(runsRoot(repo));
    const activeBefore = await listActive(repo);

    await writeStageMarker(repo, { taskId, stage: 'implementer', index: 0, of: 3, updatedAt: new Date().toISOString() });

    const fpAfter = await fingerprint(runsRoot(repo));
    const runsAfter = await listRuns(runsRoot(repo));
    const activeAfter = await listActive(repo);

    expect(fpAfter).toBe(fpBefore);
    expect(runsAfter).toEqual(runsBefore);
    expect(activeBefore.some((a) => a.taskId === taskId)).toBe(true);
    expect(activeAfter.some((a) => a.taskId === taskId)).toBe(true);
  });
});
