import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from './manager.js';
import { WorktreeError } from '../core/errors.js';

let repo: string;
let wm: WorktreeManager;
let runCounter: number;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-repo-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
  // Deterministic run ids so the branch/path are predictable in tests.
  runCounter = 0;
  wm = new WorktreeManager(repo, undefined, () => `r${(runCounter += 1)}`);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('creates a worktree on a unique per-run branch', async () => {
    const wt = await wm.create('task-1', 'main');
    expect(wt.branch).toBe('chore/vanguard-task-1-r1');
    expect(await wm.isDirty(wt.path)).toBe(false);
  });

  it('honours branchPrefix/branchId overrides (white-label mode)', async () => {
    const wt = await wm.create('gh-owner-repo-904', 'main', { branchPrefix: 'feat/', branchId: '904' });
    expect(wt.branch).toBe('feat/904-r1');
    expect(wt.path.endsWith('904-r1')).toBe(true);
  });

  it('refuses a base branch git would read as an option', async () => {
    await expect(wm.create('task-1', '-dev')).rejects.toThrow('Invalid base branch');
  });

  it('gives the same task a fresh branch and path on each run (no collision)', async () => {
    const first = await wm.create('dup', 'main');
    const second = await wm.create('dup', 'main');
    expect(first.branch).not.toBe(second.branch);
    expect(first.path).not.toBe(second.path);
    expect(second.branch).toBe('chore/vanguard-dup-r2');
  });

  it('reuse: true returns the same branch on a second call (live worktree)', async () => {
    const first = await wm.create('iter', 'main', { reuse: true });
    expect(first.branch).toBe('chore/vanguard-iter-r1');
    const second = await wm.create('iter', 'main', { reuse: true });
    expect(second.branch).toBe('chore/vanguard-iter-r1');
    expect(second.path).toBe(first.path);
  });

  it('reuse: true recreates worktree on the same branch after removal', async () => {
    const first = await wm.create('iter2', 'main', { reuse: true });
    await wm.remove(first.path);
    const second = await wm.create('iter2', 'main', { reuse: true });
    expect(second.branch).toBe(first.branch);
    expect(second.path).toBe(first.path);
  });

  it('default mode still creates unique branches even when reuse branch exists', async () => {
    await wm.create('dup2', 'main', { reuse: true });
    const second = await wm.create('dup2', 'main');
    expect(second.branch).toBe('chore/vanguard-dup2-r2');
  });

  it('detects uncommitted changes', async () => {
    const wt = await wm.create('task-2', 'main');
    await writeFile(join(wt.path, 'new.txt'), 'x');
    expect(await wm.isDirty(wt.path)).toBe(true);
  });

  it('includes new untracked files in the diff', async () => {
    const wt = await wm.create('task-3', 'main');
    await writeFile(join(wt.path, 'added.txt'), 'hello');
    const diff = await wm.diff(wt.path);
    expect(diff).toContain('added.txt');
  });

  it('removes a clean worktree', async () => {
    const wt = await wm.create('task-4', 'main');
    await wm.remove(wt.path);
    expect(await wm.isDirty(wt.path).catch(() => 'gone')).toBe('gone');
  });

  it('changedPaths lists untracked files (NUL-separated git output through execa)', async () => {
    const wt = await wm.create('task-5', 'main');
    await writeFile(join(wt.path, 'one.txt'), '1');
    await writeFile(join(wt.path, 'two.txt'), '2');
    const paths = await wm.changedPaths(wt.path);
    expect(paths).toContain('one.txt');
    expect(paths).toContain('two.txt');
  });
});

describe('WorktreeManager — committed symlink under .vanguard', () => {
  it('refuses to create a worktree through a symlinked .vanguard/worktrees', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vg-wt-outside-'));
    try {
      await mkdir(join(repo, '.vanguard'));
      await symlink(outside, join(repo, '.vanguard', 'worktrees'));
      await expect(wm.create('task-1', 'main')).rejects.toBeInstanceOf(WorktreeError);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
