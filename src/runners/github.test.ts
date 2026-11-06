import { describe, it, expect, vi } from 'vitest';
import { githubAdapter, sameRepoTasks } from './github.js';
import { GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import type { RunGithubIssueDeps } from './github.js';
import type { GhRunner } from '../tasks/github.js';
import type { Task } from '../tasks/fetcher.js';

function makeDeps(): RunGithubIssueDeps {
  return { repoPath: '/repo', repoSlug: 'owner/repo' };
}

function makeGh(failOn?: (args: string[]) => boolean): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (failOn?.(args) === true) throw new Error('gh: failed');
    return '';
  };
  return { gh, calls };
}

const task: Task = { id: 'owner/repo#7', title: 't', description: '', labels: [], children: [], comments: [] };

describe('githubAdapter', () => {
  it('signalSecretBlock creates the secret-blocked label before adding it, and posts the masked comment', async () => {
    const { gh, calls } = makeGh();
    const adapter = githubAdapter(makeDeps(), gh);

    await adapter.signalSecretBlock('owner/repo#7', task, {
      reason: 'findings',
      findings: [{ file: '.env', patternName: 'generic-api-key', masked: 'KEY=ab****' }],
    });

    const create = calls.findIndex((c) => c[0] === 'label' && c[1] === 'create' && c[2] === GITHUB_SECRET_BLOCKED_LABEL && c.includes('--force'));
    const add = calls.findIndex((c) => c[0] === 'issue' && c[1] === 'edit' && c[2] === '7' && c.includes('--add-label') && c.includes(GITHUB_SECRET_BLOCKED_LABEL));
    expect(create).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(create); // `gh issue edit --add-label` fails on a repo without the label
    const comment = calls.find((c) => c[0] === 'issue' && c[1] === 'comment' && c[2] === '7');
    expect(comment?.at(-1)).toContain('blocked publish');
    expect(comment?.at(-1)).toContain('KEY=ab****');
    expect(comment?.at(-1)).not.toContain('trigger label'); // the release step is per watch source, posted by the primitive
  });

  it('signalSecretBlock never throws: a failed label create still attempts the add and the comment', async () => {
    const { gh, calls } = makeGh((args) => args[0] === 'label');
    const adapter = githubAdapter(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'gitleaks missing' })).resolves.toBeUndefined();

    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c.includes(GITHUB_SECRET_BLOCKED_LABEL))).toBe(true);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'comment')).toBe(true);
  });

  it('signalSecretBlock never throws when every gh call fails', async () => {
    const { gh } = makeGh(() => true);
    const adapter = githubAdapter(makeDeps(), gh);

    await expect(adapter.signalSecretBlock('owner/repo#7', task, { reason: 'scan-error', message: 'x' })).resolves.toBeUndefined();
  });
});

describe('sameRepoTasks', () => {
  const task = (id: string): Task => ({ id, title: '', description: '', labels: [], children: [], comments: [] });

  it('keeps items of the configured repo (case-insensitive) and skips foreign ones with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const kept = sameRepoTasks([task('owner/repo#1'), task('other-org/other-repo#7'), task('Owner/Repo#2')], 'owner/repo');
      expect(kept.map((t) => t.id)).toEqual(['owner/repo#1', 'Owner/Repo#2']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('other-org/other-repo#7');
    } finally {
      warn.mockRestore();
    }
  });
});
