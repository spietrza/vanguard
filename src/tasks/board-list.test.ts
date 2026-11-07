import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginRun } from '../core/run-store.js';
import { STAGE_MARKER_TTL_MS, writeStageMarker } from '../core/run-stage-marker.js';
import { BOARD_FETCH_CAP, listBoardTasks } from './board-list.js';
import { toBoardTask } from './board.js';
import type { TaskFetcher, Task } from './fetcher.js';
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-board-list-'));
  await mkdir(join(repo, '.vanguard'));
  await writeFile(join(repo, '.vanguard', 'app.json'), JSON.stringify({ source: 'github' }));
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });
const tasks: Task[] = [
  { id: '1', title: 'running', description: '', children: [], comments: [], labels: ['vanguard:running'], state: 'open' },
  { id: '2', title: 'review', description: '', children: [], comments: [], labels: ['review'], state: 'open' },
  { id: '3', title: 'queued', description: '', children: [], comments: [], labels: ['ready for agent'], state: 'open' },
];
const fetcherFor = async (): Promise<TaskFetcher> => ({ list: async () => tasks, fetch: async () => tasks[0]! });

it('T20/T22: decorates running/review cards without changing existing fields or capped', async () => {
  for (const id of ['1', '2', '3']) await writeStageMarker(repo, { taskId: `gh-owner-repo-${id}`, stage: 'implementer', index: 0, of: 2, updatedAt: new Date().toISOString() });
  await beginRun(repo, 'gh-owner-repo-2').writeStages([{ name: 'implementer', result: {
    taskId: 'gh-owner-repo-2', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/missing', worktreePreserved: false, finalText: '',
  } }]);
  const response = await listBoardTasks(repo, fetcherFor);
  expect(response.capped).toBe(false);
  expect(response.tasks[0]?.stage).toBe('implementer');
  expect(response.tasks[1]?.chips).toEqual([{ key: 'implementer', label: 'implementer: ok', tone: 'pass' }]);
  expect(response.tasks[1]).not.toHaveProperty('stage');
  expect(response.tasks[2]).not.toHaveProperty('stage');
  expect(response.tasks[0]).not.toHaveProperty('chips');
  response.tasks.forEach(({ stage: _stage, chips: _chips, ...task }, i) => expect(task).toEqual(toBoardTask('github', tasks[i]!)));
  const capped = await listBoardTasks(repo, async () => ({ list: async () => Array.from({ length: BOARD_FETCH_CAP }, () => tasks[0]!), fetch: async () => tasks[0]! }));
  expect(capped.capped).toBe(true);
});

it('T21: absent/unreadable local state preserves tracker results; expired markers are omitted', async () => {
  expect((await listBoardTasks(repo, fetcherFor)).tasks).toEqual(tasks.map((t) => toBoardTask('github', t)));
  await writeStageMarker(repo, { taskId: 'gh-1', stage: 'implementer', index: 0, of: 1, updatedAt: new Date(Date.now() - STAGE_MARKER_TTL_MS - 1).toISOString() });
  expect((await listBoardTasks(repo, fetcherFor)).tasks[0]).not.toHaveProperty('stage');
  await rm(join(repo, '.vanguard', 'stage'), { recursive: true });
  // A non-directory deterministically exercises the unreadable-directory path even as root.
  await writeFile(join(repo, '.vanguard', 'stage'), 'unreadable');
  await writeFile(join(repo, '.vanguard', 'runs'), 'unreadable');
  expect((await listBoardTasks(repo, fetcherFor)).tasks).toEqual(tasks.map((t) => toBoardTask('github', t)));
});

it('refuses a symlinked marker directory and malformed marker payloads', async () => {
  await mkdir(join(repo, 'outside'));
  await writeFile(join(repo, 'outside', 'gh-1.json'), JSON.stringify({ taskId: 'gh-1', stage: 'forged', index: 0, of: 1, updatedAt: new Date().toISOString() }));
  await symlink(join(repo, 'outside'), join(repo, '.vanguard', 'stage'));
  expect((await listBoardTasks(repo, fetcherFor)).tasks[0]).not.toHaveProperty('stage');
});
