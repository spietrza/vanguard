import { describe, it, expect, vi } from 'vitest';
import { GitHubTaskFetcher, linkPullRequest } from './github.js';
import { isTrustedComment } from './comment-trust.js';
import type { GhRunner } from './github.js';

function fakeGh(): GhRunner {
  const issue = { number: 7, title: 'Bug', body: 'desc', labels: [{ name: 'bug' }] };
  return async (args: string[]): Promise<string> =>
    args.includes('view') ? JSON.stringify(issue) : JSON.stringify([issue]);
}

describe('GitHubTaskFetcher', () => {
  it('maps an issue to a Task (id = repo#number)', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task).toEqual({ id: 'SebaBoler/vanguard#7', title: 'Bug', description: 'desc', labels: ['bug'], children: [], comments: [], ref: '7' }); // ref additive (S9)
  });

  it('accepts a repo#number reference', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('SebaBoler/vanguard#7');
    expect(task.id).toBe('SebaBoler/vanguard#7');
  });

  it('lists open issues', async () => {
    const list = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('SebaBoler/vanguard#7');
  });

  it('maps comments from the JSON response into Task.comments', async () => {
    const issueWithComments = {
      number: 7,
      title: 'Bug',
      body: 'desc',
      labels: [{ name: 'bug' }],
      comments: [
        { author: { login: 'alice' }, body: 'First comment', createdAt: '2024-01-01T00:00:00Z' },
        { author: { login: 'bob' }, body: 'Second comment', createdAt: '2024-01-02T00:00:00Z' },
      ],
    };
    const gh: GhRunner = async (): Promise<string> => JSON.stringify(issueWithComments);
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', gh).fetch('7');
    expect(task.comments).toEqual([
      { author: 'alice', authorAssociation: '', body: 'First comment' },
      { author: 'bob', authorAssociation: '', body: 'Second comment' },
    ]);
  });

  it('defaults comments to [] when the issue has no comments field', async () => {
    const task = await new GitHubTaskFetcher('SebaBoler/vanguard', fakeGh()).fetch('7');
    expect(task.comments).toEqual([]);
  });

  it('T19: fetch sources the issue author and comment association', async () => {
    const calls: string[][] = [];
    const fetcher = new GitHubTaskFetcher('o/r', async (args) => {
      calls.push(args);
      return JSON.stringify({ number: 1, title: '', body: '', labels: [], author: { login: 'reporter' },
        comments: [{ author: { login: 'maintainer' }, authorAssociation: 'OWNER', body: 'spec' }] });
    });
    const task = await fetcher.fetch('1');
    expect(task.author).toBe('reporter');
    expect(task.comments[0]?.authorAssociation).toBe('OWNER');
    expect(calls[0]?.at(-1)?.split(',')).toContain('author');
  });

  // GitHub always models an association, so a missing one fails closed (unlike GitLab, which models
  // none) — and the fetcher warns, since a future gh that drops the field would mute every human.
  it('fails closed and warns when gh returned no association at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const gh = async (): Promise<string> =>
        JSON.stringify({ number: 1, title: '', body: '', labels: [], comments: [{ author: { login: 'alice' }, body: 'hi' }] });
      const task = await new GitHubTaskFetcher('o/r', gh).fetch('1');
      expect(task.comments[0]?.authorAssociation).toBe('');
      expect(isTrustedComment(task.comments[0]!)).toBe(false);
      expect(warn.mock.calls[0]?.[0]).toContain('no authorAssociation');
      warn.mockClear();
      const withAssociation = async (): Promise<string> =>
        JSON.stringify({ number: 1, title: '', body: '', labels: [], comments: [{ author: { login: 'alice' }, authorAssociation: 'NONE', body: 'hi' }] });
      await new GitHubTaskFetcher('o/r', withAssociation).fetch('1');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('linkPullRequest', () => {
  it('comments the PR url onto the issue', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return '';
    };
    await linkPullRequest('SebaBoler/vanguard', 'SebaBoler/vanguard#7', 'https://example/pr/1', gh);
    expect(calls[0]).toEqual(expect.arrayContaining(['issue', 'comment', '7', '--repo', 'SebaBoler/vanguard']));
    expect(calls[0]?.join(' ')).toContain('https://example/pr/1');
  });
});

// S9: TaskFilter.limit is STRICTLY conditional — unset keeps watch's argv byte-identical.
it('list() argv is byte-identical to the pre-S9 shape when limit is unset (watch contract)', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return '[]';
  };
  await new GitHubTaskFetcher('o/r', gh).list({ state: 'open', labels: ['x'] });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'o/r', '--json', 'number,title,body,labels', '--state', 'open', '--label', 'x']);
});

it('list() with limit adds -L and the state field to --json (the board call)', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return JSON.stringify([{ number: 9, title: 't', body: null, labels: [], state: 'closed' }]);
  };
  const tasks = await new GitHubTaskFetcher('o/r', gh).list({ state: 'all', limit: 50 });
  expect(calls[0]).toEqual(['issue', 'list', '--repo', 'o/r', '--json', 'number,title,body,labels,state', '--state', 'all', '-L', '50']);
  expect(tasks[0]).toMatchObject({ ref: '9', state: 'closed' });
});

import { githubDefaultBranch } from './github.js';
import { VanguardError } from '../core/errors.js';
describe('githubDefaultBranch', () => {
  it('reads the API default branch with the exact argv', async () => {
    const calls: string[][] = [];
    expect(await githubDefaultBranch('o/r', async (args) => { calls.push(args); return JSON.stringify({ defaultBranchRef: { name: 'main' } }); })).toBe('main');
    expect(calls).toEqual([['repo', 'view', 'o/r', '--json', 'defaultBranchRef']]);
  });
  it.each([{}, { defaultBranchRef: null }, { defaultBranchRef: { name: '' } }])('fails closed on %j', async (data) => {
    await expect(githubDefaultBranch('o/r', async () => JSON.stringify(data))).rejects.toThrow(VanguardError);
  });
});
