import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from './remote.js';
import { fetchRemoteRun, listRemoteRuns } from './remote.js';
import { listRunSummaries, remoteRunsRoot } from './runs.js';
import { BadRequestError } from '../sidecar/sidecar.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-remote-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const GH_RUN_LIST_FIXTURE = [
  {
    databaseId: 28816699455,
    status: 'completed',
    conclusion: 'success',
    displayTitle: 'fix: thing',
    headBranch: 'feat/x',
    workflowName: 'CI',
    createdAt: '2026-07-06T19:12:02Z',
    event: 'pull_request',
    url: 'https://gh/run/1',
  },
];

function runRecordJson(taskId: string, timestamp: string): string {
  return JSON.stringify({
    taskId,
    completed: true,
    exitReason: 'completed',
    turns: 3,
    worktreePath: '/tmp/wt',
    worktreePreserved: false,
    finalText: 'done',
    timestamp,
    stage: 'implement',
    costUsd: 0.01,
  });
}

/** Extracts the `--dir <path>` value from a `gh run download` invocation's args. */
function downloadDirOf(args: string[]): string {
  const idx = args.indexOf('--dir');
  const dir = idx >= 0 ? args[idx + 1] : undefined;
  if (dir === undefined) throw new Error('test fixture: --dir not found in args');
  return dir;
}

describe('listRemoteRuns', () => {
  it('T-30 parses a gh run list --json style array into RemoteRun[]', async () => {
    const exec: Exec = async () => ({ stdout: JSON.stringify(GH_RUN_LIST_FIXTURE), stderr: '' });
    const runs = await listRemoteRuns(repo, exec);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      id: 28816699455,
      status: 'completed',
      conclusion: 'success',
      title: 'fix: thing',
      branch: 'feat/x',
      workflow: 'CI',
      createdAt: '2026-07-06T19:12:02Z',
      event: 'pull_request',
      url: 'https://gh/run/1',
      cached: false,
    });
  });

  it('marks only caches containing readable run records as cached', async () => {
    const root = remoteRunsRoot(repo, GH_RUN_LIST_FIXTURE[0]!.databaseId);
    const exec: Exec = async () => ({ stdout: JSON.stringify(GH_RUN_LIST_FIXTURE), stderr: '' });
    await mkdir(root, { recursive: true });
    expect((await listRemoteRuns(repo, exec))[0]?.cached).toBe(false);
    const task = join(root, 'task-cache');
    await mkdir(task);
    await writeFile(join(task, 'record.json'), 'invalid json');
    expect((await listRemoteRuns(repo, exec))[0]?.cached).toBe(false);
    await writeFile(join(task, 'record.json'), runRecordJson('task-cache', '2026-07-06T19:12:02.000Z'));
    expect((await listRemoteRuns(repo, exec))[0]?.cached).toBe(true);
  });

  it('T-31 maps an ENOENT-flavored rejection to a "gh not available" error', async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { stderr: '' });
    };
    await expect(listRemoteRuns(repo, exec)).rejects.toThrow(/`gh` not available/);
  });

  it('T-31 maps a generic failure to a "gh run list failed" error', async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error('Command failed with exit code 1'), { stderr: 'authentication required' });
    };
    await expect(listRemoteRuns(repo, exec)).rejects.toThrow(/`gh run list` failed/);
  });

  it('T-31 maps garbage (non-array) stdout to a "gh run list failed" error', async () => {
    const exec: Exec = async () => ({ stdout: 'not json at all', stderr: '' });
    await expect(listRemoteRuns(repo, exec)).rejects.toThrow(/`gh run list` failed/);
  });
});

describe('fetchRemoteRun', () => {
  it('T-32 imports a flat artifact layout (tmpdir/<taskId>/<ts>.json)', async () => {
    const exec: Exec = async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        const dir = downloadDirOf(args);
        const taskDir = join(dir, 'task-flat');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, '2026-07-06T19-12-02-000Z.json'), runRecordJson('task-flat', '2026-07-06T19:12:02.000Z'));
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };

    const result = await fetchRemoteRun(repo, 101, exec);
    expect(result.runId).toBe(101);
    expect(result.taskIds).toEqual(['task-flat']);
    expect(result.runs).toMatchObject([{ taskId: 'task-flat', timestamp: '2026-07-06T19:12:02.000Z', stages: ['implement'] }]);

    const summaries = await listRunSummaries(remoteRunsRoot(repo, 101));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.taskId).toBe('task-flat');
  });

  it('T-32 imports a nested artifact layout (tmpdir/some-artifact-name/<taskId>/<ts>.json)', async () => {
    const exec: Exec = async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        const dir = downloadDirOf(args);
        const taskDir = join(dir, 'some-artifact-name', 'task-nested');
        await mkdir(taskDir, { recursive: true });
        await writeFile(
          join(taskDir, '2026-07-06T19-13-02-000Z.json'),
          runRecordJson('task-nested', '2026-07-06T19:13:02.000Z'),
        );
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };

    const result = await fetchRemoteRun(repo, 102, exec);
    expect(result.taskIds).toEqual(['task-nested']);
    expect(result.runs).toMatchObject([{ taskId: 'task-nested', timestamp: '2026-07-06T19:13:02.000Z' }]);

    const summaries = await listRunSummaries(remoteRunsRoot(repo, 102));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.taskId).toBe('task-nested');
  });

  it('T-33 refuses a symlink anywhere inside the artifact and cleans up the import tmpdir', async () => {
    let capturedDir = '';
    const exec: Exec = async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        const dir = downloadDirOf(args);
        capturedDir = dir;
        const taskDir = join(dir, 'task-evil');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, '2026-07-06T19-14-02-000Z.json'), runRecordJson('task-evil', '2026-07-06T19:14:02.000Z'));
        // Plant a symlink pointing outside the artifact tree.
        await symlink('/etc/passwd', join(taskDir, 'evil-link'));
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };

    await expect(fetchRemoteRun(repo, 103, exec)).rejects.toBeInstanceOf(BadRequestError);
    expect(capturedDir).not.toBe('');
    await expect(access(capturedDir)).rejects.toThrow();
  });

  it('T-34 maps a "no artifact" download failure to the exact actionable BadRequestError', async () => {
    const exec: Exec = async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        throw Object.assign(new Error('Command failed with exit code 1'), {
          stderr: 'no artifact found matching: vanguard-runs',
        });
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };

    await expect(fetchRemoteRun(repo, 104, exec)).rejects.toBeInstanceOf(BadRequestError);
    await expect(fetchRemoteRun(repo, 104, exec)).rejects.toThrow(/vanguard-runs/);
    await expect(fetchRemoteRun(repo, 104, exec)).rejects.toThrow(/docs\/hub\.md/);
  });

  it('T-34b the live gh wording "no valid artifacts found to download" is the same actionable BadRequestError', async () => {
    const exec: Exec = async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        throw Object.assign(new Error('Command failed with exit code 1'), { stderr: 'no valid artifacts found to download' });
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };
    await expect(fetchRemoteRun(repo, 105, exec)).rejects.toBeInstanceOf(BadRequestError);
    await expect(fetchRemoteRun(repo, 105, exec)).rejects.toThrow(/has no "vanguard-runs" artifact/);
  });

  it('T-35 opens a previously cached import without gh and preserves .gitignore', async () => {
    const makeExec = (taskId: string, timestamp: string): Exec => async (file, args) => {
      if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
        const dir = downloadDirOf(args);
        const taskDir = join(dir, taskId);
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, `${timestamp.replace(/[^0-9A-Za-z]/g, '-')}.json`), runRecordJson(taskId, timestamp));
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
    };

    const incomplete = join(remoteRunsRoot(repo, 105), 'incomplete');
    await mkdir(incomplete, { recursive: true });
    await writeFile(join(incomplete, 'record.json'), 'invalid json');
    await fetchRemoteRun(repo, 105, makeExec('task-first', '2026-07-06T19:15:02.000Z'));
    await expect(lstat(incomplete)).rejects.toThrow();
    const second = await fetchRemoteRun(repo, 105, async () => {
      throw new Error('cached records must open without gh');
    });

    expect(second.taskIds).toEqual(['task-first']);
    const summaries = await listRunSummaries(remoteRunsRoot(repo, 105));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.taskId).toBe('task-first');

    const remoteRunsBase = join(repo, '.vanguard', 'remote-runs');
    await expect(lstat(join(remoteRunsBase, '105.tmp'))).rejects.toThrow();

    const gitignore = await readFile(join(remoteRunsBase, '.gitignore'), 'utf8');
    expect(gitignore).toBe('*\n');
  });
});

describe('fetchRemoteRun — committed symlinks under .vanguard', () => {
  const exec: Exec = async (file, args) => {
    if (file === 'gh' && args[0] === 'run' && args[1] === 'download') {
      const taskDir = join(downloadDirOf(args), 't1');
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, '2026-01-01T00-00-00-000Z.json'), runRecordJson('t1', '2026-01-01T00:00:00.000Z'));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected exec call: ${file} ${args.join(' ')}`);
  };
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'vanguard-hub-remote-outside-'));
    await mkdir(join(outside, '123'));
    await writeFile(join(outside, '123', 'keep.txt'), 'keep');
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses a symlinked .vanguard/remote-runs and deletes nothing behind it', async () => {
    await mkdir(join(repo, '.vanguard'));
    await symlink(outside, join(repo, '.vanguard', 'remote-runs'));
    await expect(fetchRemoteRun(repo, 123, exec)).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, '123', 'keep.txt'), 'utf8')).toBe('keep');
    await expect(access(join(outside, '.gitignore'))).rejects.toThrow();
  });

  it('refuses a symlinked .vanguard', async () => {
    await symlink(outside, join(repo, '.vanguard'));
    await expect(fetchRemoteRun(repo, 123, exec)).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, '123', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a symlinked <runId> leaf', async () => {
    await mkdir(join(repo, '.vanguard', 'remote-runs'), { recursive: true });
    await symlink(join(outside, '123'), join(repo, '.vanguard', 'remote-runs', '123'));
    await expect(fetchRemoteRun(repo, 123, exec)).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, '123', 'keep.txt'), 'utf8')).toBe('keep');
  });
});
