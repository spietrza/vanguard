import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir } from './state-path.js';
import { StatePathError } from './errors.js';

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-statepath-'));
  outside = await mkdtemp(join(tmpdir(), 'vg-statepath-outside-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('assertStatePath', () => {
  it('accepts a path whose components do not exist yet', async () => {
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'runs', 'T-1', 'a.json'))).resolves.toBeUndefined();
  });

  it('accepts real directories and a real leaf file', async () => {
    await mkdir(join(repo, '.vanguard', 'runs'), { recursive: true });
    await writeFile(join(repo, '.vanguard', 'runs', 'metrics.jsonl'), '');
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'runs', 'metrics.jsonl'))).resolves.toBeUndefined();
  });

  it('refuses a committed .vanguard symlink', async () => {
    await symlink(outside, join(repo, '.vanguard'));
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'runs', 'x.json'))).rejects.toBeInstanceOf(StatePathError);
  });

  it('refuses a nested component symlink', async () => {
    await mkdir(join(repo, '.vanguard'));
    await symlink(outside, join(repo, '.vanguard', 'runs'));
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'runs', 'T-1'))).rejects.toThrow(/symlink/);
  });

  it('refuses a leaf symlink, dangling or not', async () => {
    await mkdir(join(repo, '.vanguard', 'memory'), { recursive: true });
    await symlink(join(outside, 'missing.txt'), join(repo, '.vanguard', 'memory', 'retrospective.md'));
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'memory', 'retrospective.md'))).rejects.toThrow(/symlink/);
  });

  it('refuses a file where a directory is expected', async () => {
    await mkdir(join(repo, '.vanguard'));
    await writeFile(join(repo, '.vanguard', 'runs'), '');
    await expect(assertStatePath(repo, join(repo, '.vanguard', 'runs', 'x.json'))).rejects.toThrow(/not a directory/);
  });

  it('refuses a target outside .vanguard', async () => {
    await expect(assertStatePath(repo, join(repo, 'src', 'x.ts'))).rejects.toThrow(/outside/);
    await expect(assertStatePath(repo, join(repo, '.vanguard', '..', '..', 'x'))).rejects.toThrow(/outside/);
  });
});

describe('ensureStateDir', () => {
  it('creates real directories on a clean checkout', async () => {
    const dir = await ensureStateDir(repo, join(repo, '.vanguard', 'sessions', 'T-1'));
    expect((await lstat(dir)).isDirectory()).toBe(true);
  });

  it('creates nothing through a committed symlink', async () => {
    await symlink(outside, join(repo, '.vanguard'));
    await expect(ensureStateDir(repo, join(repo, '.vanguard', 'staging', 'T-1'))).rejects.toBeInstanceOf(StatePathError);
    expect(await readdir(outside)).toEqual([]);
  });
});
