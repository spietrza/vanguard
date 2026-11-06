import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { githubPullRequestWatchPrimitives, watchPullRequests, watchPullRequestsOnce } from './pr-watch.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchItem, PullRequestWatchPrimitives } from './pr-watch.js';

function pr(number: number): PullRequestWatchItem {
  return {
    repoSlug: 'o/r',
    number,
    title: `PR ${number}`,
    isDraft: false,
    author: 'alice',
    headRefOid: `sha-${number}`,
    labels: ['ready for vanguard review'],
  };
}

describe('watchPullRequestsOnce', () => {
  it('claims, reviews, and marks each ready PR in order', async () => {
    const logs: string[] = [];
    const order: string[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => [pr(12)],
      claim: vi.fn(async (item) => {
        order.push(`claim:${item.number}`);
      }),
      review: vi.fn(async (item) => {
        order.push(`review:${item.number}`);
      }),
      markReviewed: vi.fn(async (item) => {
        order.push(`mark:${item.number}`);
      }),
      onFailure: vi.fn(),
    };

    const tick = await watchPullRequestsOnce(primitives, { log: (line) => logs.push(line) });

    expect(tick).toEqual({ reviewed: ['o/r#12'], failed: [], skipped: [] });
    expect(order).toEqual(['claim:12', 'review:12', 'mark:12']);
    expect(logs).toEqual([
      'watch-prs: poll -> 1 ready',
      'watch-prs o/r#12: claim -> reviewing',
      'watch-prs o/r#12: reviewed -> marked',
    ]);
  });

  it('skips already-claimed PRs and restores the trigger label on review failure', async () => {
    const logs: string[] = [];
    const restored: number[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => [pr(12), pr(13)],
      claim: vi.fn(async (item) => {
        if (item.number === 12) throw new Error('already claimed');
      }),
      review: vi.fn(async () => {
        throw new Error('review failed');
      }),
      markReviewed: vi.fn(),
      onFailure: vi.fn(async (item) => {
        restored.push(item.number);
      }),
    };

    const tick = await watchPullRequestsOnce(primitives, { log: (line) => logs.push(line), concurrency: 1 });

    expect(tick).toEqual({ reviewed: [], failed: ['o/r#13'], skipped: ['o/r#12'] });
    expect(restored).toEqual([13]);
    expect(logs).toContain('watch-prs o/r#12: skipped -> already claimed');
    expect(logs).toContain('watch-prs o/r#13: failed -> retry later (review failed)');
  });

  it('reports PR as failed even when onFailure (label restore) also throws', async () => {
    const logs: string[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => [pr(13)],
      claim: vi.fn(),
      review: vi.fn(async () => {
        throw new Error('review boom');
      }),
      markReviewed: vi.fn(),
      onFailure: vi.fn(async () => {
        throw new Error('restore boom');
      }),
    };

    const tick = await watchPullRequestsOnce(primitives, { log: (line) => logs.push(line), concurrency: 1 });

    expect(tick.failed).toEqual(['o/r#13']);
    expect(tick.reviewed).toEqual([]);
    expect(tick.skipped).toEqual([]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('watch-prs o/r#13: restore failed -> manual label check'),
        'watch-prs o/r#13: failed -> retry later (review boom)',
      ]),
    );
  });
});

/** The REST issue lookup behind the PR-author gate: a MEMBER author unless a test says otherwise. */
function trustedAuthorApi(args: string[], association = 'MEMBER'): string {
  return args[0] === 'api' ? JSON.stringify({ user: { login: 'alice' }, author_association: association }) : '';
}

/** Vanguard's own review identity, as gh reports it. */
const BOT = { author: { login: 'github-actions' }, authorAssociation: 'CONTRIBUTOR' };

describe('githubPullRequestWatchPrimitives', () => {
  it('lists only non-draft, human-authored PRs that still carry the trigger label', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'aaa',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 13,
            title: 'Draft',
            isDraft: true,
            author: { login: 'bob' },
            headRefOid: 'bbb',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 14,
            title: 'Bot',
            isDraft: false,
            author: { login: 'github-actions[bot]' },
            headRefOid: 'ccc',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 15,
            title: 'Already claimed',
            isDraft: false,
            author: { login: 'carol' },
            headRefOid: 'ddd',
            labels: [{ name: 'vanguard:reviewing' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [] });
      }
      return trustedAuthorApi(args);
    };

    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'o/r',
      '--state',
      'open',
      '--label',
      'ready for vanguard review',
      '--limit',
      '100',
      '--json',
      'number,title,isDraft,author,headRefOid,labels',
    ]);
  });

  it('reviews only the configured author and skips PRs opened by others', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        // The mocked gh ignores --author, so the client-side filter must drop mallory's PR.
        return JSON.stringify([
          {
            number: 20,
            title: 'Mine',
            isDraft: false,
            author: { login: 'SebaBoler' },
            headRefOid: 'm1',
            labels: [{ name: 'ready for vanguard review' }],
          },
          {
            number: 21,
            title: 'Theirs',
            isDraft: false,
            author: { login: 'mallory' },
            headRefOid: 't1',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      author: 'SebaBoler',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([20]);
    // The filter is also pushed down to gh for a smaller payload.
    expect(calls[0]).toContain('--author');
    expect(calls[0]).toContain('SebaBoler');
  });

  it('skips a PR when Vanguard already reviewed the same head commit', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          comments: [{ body: 'Older note.' }],
          reviews: [{ ...BOT, body: '## Vanguard Review\n\nNo blocking findings.\n\n<!-- vanguard-pr-review: abc123 -->' }],
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(calls[1]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('skips a PR when the matching review marker appears after an older marker', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          comments: [],
          reviews: [
            {
              ...BOT,
              body: [
                '## Vanguard Review',
                '',
                '<!-- vanguard-pr-review: deadbeef -->',
                '',
                'Current review body.',
                '',
                '<!-- vanguard-pr-review: abc123 -->',
              ].join('\n'),
            },
          ],
        });
      }
      return trustedAuthorApi(args);
    };

    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(calls[1]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('keeps a PR ready when the per-PR dedupe lookup fails', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') throw new Error('temporary gh failure');
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(calls[1]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'comments,reviews']);
  });

  it('claims, marks reviewed, and restores labels through gh pr edit', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return args[1] === 'list' ? '[]' : '';
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
    });
    const item = pr(12);

    await primitives.claim(item);
    await primitives.markReviewed(item);
    await primitives.onFailure(item, new Error('boom'));

    expect(calls).toEqual([
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'ready for vanguard review', '--add-label', 'vanguard:reviewing'],
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'vanguard:reviewing', '--add-label', 'vanguard:reviewed'],
      ['pr', 'edit', '12', '--repo', 'o/r', '--remove-label', 'vanguard:reviewing', '--add-label', 'ready for vanguard review'],
    ]);
  });

  it('logs why a scanned PR is skipped when its head is already reviewed', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [{ ...BOT, body: '<!-- vanguard-pr-review: abc123 -->' }] });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#12: skip -> head abc123 already reviewed');
  });

  it('pins the hinted PR when the label scan misses it (eventually consistent search)', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 316,
          title: 'Re-labeled after a failed review',
          isDraft: false,
          author: { login: 'alice' },
          headRefOid: 'abc123',
          labels: [{ name: 'ready for vanguard review' }],
          state: 'OPEN',
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      hintPr: 316,
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([316]);
    expect(calls).toContainEqual([
      'pr',
      'view',
      '316',
      '--repo',
      'o/r',
      '--json',
      'number,title,isDraft,author,headRefOid,labels,state',
    ]);
  });

  it('reviews the hinted PR even when its head already carries a review marker', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Deliberately re-labeled',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ comments: [], reviews: [{ ...BOT, body: '<!-- vanguard-pr-review: abc123 -->' }] });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      hintPr: 12,
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    // The dedupe lookup is bypassed for the hinted PR — the re-label was deliberate.
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'view')).toBe(false);
  });

  it('skips the hinted PR when it is no longer open or lost the trigger label', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 316,
          title: 'Merged already',
          isDraft: false,
          author: { login: 'alice' },
          headRefOid: 'abc123',
          labels: [{ name: 'ready for vanguard review' }],
          state: 'MERGED',
        });
      }
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      hintPr: 316,
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    await expect(primitives.listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#316: hint skip -> state MERGED');
  });

  it('keeps the scan alive when the hint fetch fails', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([
          {
            number: 12,
            title: 'Fix auth',
            isDraft: false,
            author: { login: 'alice' },
            headRefOid: 'abc123',
            labels: [{ name: 'ready for vanguard review' }],
          },
        ]);
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '99') throw new Error('boom');
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args);
    };
    const primitives = githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      hintPr: 99,
      log: (line) => logs.push(line),
      gh,
      reviewOne: async () => {},
    });

    const ready = await primitives.listReady();

    expect(ready.map((item) => item.number)).toEqual([12]);
    expect(logs).toContain('watch-prs o/r#99: hint fetch failed -> boom');
  });
});

describe('watchPullRequests', () => {
  it('continuous ticks leave no abort listener behind on the signal', async () => {
    const controller = new AbortController();
    const listeners: number[] = [];
    const primitives: PullRequestWatchPrimitives = {
      listReady: async () => {
        listeners.push(getEventListeners(controller.signal, 'abort').length);
        if (listeners.length === 12) controller.abort();
        return [];
      },
      claim: async () => {},
      review: async () => {},
      markReviewed: async () => {},
      onFailure: async () => {},
    };

    await watchPullRequests(primitives, { signal: controller.signal, intervalMs: 0 });

    expect(listeners).toEqual(Array(12).fill(0));
  });
});

describe('githubPullRequestWatchPrimitives trust', () => {
  const listed = JSON.stringify([
    { number: 12, title: 'Fix', isDraft: false, author: { login: 'alice' }, headRefOid: 'abc123', labels: [{ name: 'ready for vanguard review' }] },
  ]);
  const primitivesFor = (gh: GhRunner, extra: { allowedAuthors?: string[]; log?: (line: string) => void } = {}): PullRequestWatchPrimitives =>
    githubPullRequestWatchPrimitives({
      repoSlug: 'o/r',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      gh,
      reviewOne: async () => {},
      ...extra,
    });

  it('ignores a review marker posted by an untrusted commenter', async () => {
    const gh: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') {
        return JSON.stringify({
          comments: [{ author: { login: 'mallory' }, authorAssociation: 'NONE', body: '<!-- vanguard-pr-review: abc123 -->' }],
          reviews: [],
        });
      }
      return trustedAuthorApi(args);
    };
    const ready = await primitivesFor(gh).listReady();
    expect(ready.map((item) => item.number)).toEqual([12]);
  });

  it('skips a PR whose author is neither a repo member nor allowlisted', async () => {
    const logs: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args, 'CONTRIBUTOR');
    };
    await expect(primitivesFor(gh, { log: (line) => logs.push(line) }).listReady()).resolves.toEqual([]);
    expect(logs).toContain('watch-prs o/r#12: skip -> PR author @alice (CONTRIBUTOR) is not trusted');
  });

  it('reviews an allowlisted non-member author and fails closed when the author lookup fails', async () => {
    const ok: GhRunner = async (args) => {
      if (args[1] === 'list') return listed;
      if (args[1] === 'view') return JSON.stringify({ comments: [], reviews: [] });
      return trustedAuthorApi(args, 'NONE');
    };
    expect((await primitivesFor(ok, { allowedAuthors: ['Alice'] }).listReady()).map((item) => item.number)).toEqual([12]);
    const broken: GhRunner = async (args) => {
      if (args[0] === 'api') throw new Error('rate limited');
      return ok(args);
    };
    await expect(primitivesFor(broken, { allowedAuthors: ['alice'] }).listReady()).resolves.toEqual([]);
  });
});
