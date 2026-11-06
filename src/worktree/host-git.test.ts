import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { WorktreeManager } from './manager.js';
import { hostGitArgs, hostGitEnv } from './host-git.js';
import { commitStage } from '../pipeline/pipeline.js';
import { pushToExistingBranch } from '../pipeline/remote-branch.js';
import type { RunContext } from '../core/vanguard.js';

const HOOKS = ['post-commit', 'reference-transaction', 'post-index-change', 'pre-push', 'post-checkout'];
const IDENTITY = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

let root: string;
let repo: string;
let marker: string;

/** Plant every hook under the repo's relative hooksPath (as copy-back would); each logs its name to `marker`. */
async function plantHooks(dir: string): Promise<void> {
  const hooksDir = join(dir, '.husky', '_');
  await mkdir(hooksDir, { recursive: true });
  for (const hook of HOOKS) {
    await writeFile(join(hooksDir, hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`, { mode: 0o755 });
  }
}

async function ranHooks(): Promise<string[]> {
  const text = await readFile(marker, 'utf8').catch(() => '');
  return [...new Set(text.split('\n').filter((line) => line !== ''))];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-host-git-'));
  repo = join(root, 'repo');
  marker = join(root, 'hooks-ran.log');
  await mkdir(repo);
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', [...IDENTITY, 'commit', '-m', 'init'], { cwd: repo });
  // husky's default after install: a hooks path relative to the worktree root.
  await execa('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('host git in a run worktree', () => {
  it('control: plain git runs hooks planted at a relative core.hooksPath, even with --no-verify', async () => {
    const wt = await new WorktreeManager(repo).create('ctl', 'main');
    await plantHooks(wt.path);
    await writeFile(join(wt.path, 'feature.txt'), 'x');
    await execa('git', ['add', '-A'], { cwd: wt.path });
    await execa('git', [...IDENTITY, 'commit', '--no-verify', '-m', 'work'], { cwd: wt.path });
    expect(await ranHooks()).toEqual(expect.arrayContaining(['post-commit', 'reference-transaction']));
  });

  it('commitStage and pushToExistingBranch run none of the planted hooks', async () => {
    const remote = join(root, 'remote.git');
    await execa('git', ['init', '--bare', '-b', 'main', remote]);
    await execa('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    const wm = new WorktreeManager(repo);
    const wt = await wm.create('fix', 'main');
    await plantHooks(wt.path);
    await writeFile(join(wt.path, 'feature.txt'), 'x');
    const ctx = { worktreePath: wt.path, branch: wt.branch, wm } as unknown as RunContext;

    const outcome = await commitStage(ctx, { message: 'work' });
    await pushToExistingBranch(ctx, { prHeadRef: 'pr-head' });

    expect(outcome.committed).toBe(true);
    expect((await execa('git', ['rev-parse', 'refs/heads/pr-head'], { cwd: remote })).stdout).toBe(outcome.sha);
    expect(await ranHooks()).toEqual([]);
  });

  it('WorktreeManager.create runs none of the hooks committed on the branch it checks out', async () => {
    // A branch that carries the hooks in its tree, e.g. a reused run branch or a PR head.
    await plantHooks(repo);
    await execa('git', hostGitArgs(['checkout', '-q', '-b', 'carrier']), { cwd: repo });
    await execa('git', hostGitArgs(['add', '-A']), { cwd: repo });
    await execa('git', hostGitArgs([...IDENTITY, 'commit', '-q', '-m', 'hooks']), { cwd: repo });
    await execa('git', hostGitArgs(['checkout', '-q', 'main']), { cwd: repo });

    await new WorktreeManager(repo).create('fresh', 'carrier');
    expect(await ranHooks()).toEqual([]);

    // Control: the same checkout through plain git does run it.
    await execa('git', ['worktree', 'add', '-q', join(root, 'plain'), 'carrier'], { cwd: repo });
    expect(await ranHooks()).toEqual(expect.arrayContaining(['post-index-change']));
  });
});

describe('hostGitEnv', () => {
  it('appends after GIT_CONFIG_* entries the environment already carries', () => {
    expect(hostGitEnv({ GIT_CONFIG_COUNT: '1' })).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: 'false',
    });
    expect(hostGitEnv({})['GIT_CONFIG_COUNT']).toBe('2');
  });
});
