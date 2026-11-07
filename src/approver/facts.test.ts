import { describe, it, expect } from 'vitest';
import { collectPrFacts, collectCheckFacts, collectReviewFacts, isFactoryPr } from './facts.js';
import { buildPullRequestReviewComment, buildMainLoopReviewComment, pullRequestReviewMarker } from '../runners/pr-review.js';
import type { ApproverPolicy, PrFacts } from './types.js';
import type { GhRunner } from '../tasks/github.js';

const policy: ApproverPolicy = {
  schemaVersion: 1,
  enabled: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [{ name: 'build', appId: 15368 }, { name: 'dependency-review', appId: 15368 }],
  // The login `gh pr view --json reviews` reports for the review workflow — no `[bot]` suffix.
  reviewAuthors: ['github-actions'],
  testGlobs: ['**/*.test.ts'],
  pathRules: {},
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0.1 },
};

const SHA = 'd1ff3210000000000000000000000000000000ab';

function prFacts(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    isDraft: false,
    headSha: SHA,
    headRefName: 'chore/vanguard-1',
    baseRefName: 'main',
    apiBaseSha: 'base',
    headRepo: 'o/r',
    reviews: [],
    ...overrides,
  };
}

function review(body: string, opts: { author?: string; submittedAt?: string; state?: string } = {}): PrFacts['reviews'][number] {
  return { author: opts.author ?? 'github-actions', body, submittedAt: opts.submittedAt ?? '2026-10-20T00:00:00Z', state: opts.state ?? 'COMMENTED' };
}

describe('collectPrFacts', () => {
  it('maps the gh JSON into typed facts, composing headRepo from owner and name', async () => {
    const gh: GhRunner = async () =>
      JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        isDraft: true,
        headRefOid: SHA,
        headRefName: 'chore/vanguard-7',
        baseRefName: 'main',
        baseRefOid: 'base7',
        headRepository: { name: 'r' },
        headRepositoryOwner: { login: 'o' },
        reviews: [{ author: { login: 'github-actions' }, body: 'b', submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED' }],
      });
    const facts = await collectPrFacts(gh, 'o/r', 7);
    expect(facts).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'OPEN',
      isDraft: true,
      headSha: SHA,
      headRefName: 'chore/vanguard-7',
      baseRefName: 'main',
      apiBaseSha: 'base7',
      headRepo: 'o/r',
      reviews: [{ author: 'github-actions', body: 'b', submittedAt: '2026-10-20T00:00:00Z', state: 'COMMENTED' }],
    });
  });

  it('defaults every absent field, leaving headRepo empty when the API omits the head repo', async () => {
    const gh: GhRunner = async () => JSON.stringify({ headRepositoryOwner: { login: 'o' } });
    const facts = await collectPrFacts(gh, 'o/r', 3);
    expect(facts).toMatchObject({ number: 3, headRepo: '', headSha: '', isDraft: false, reviews: [] });
  });
});

describe('isFactoryPr', () => {
  it.each([
    ['same repo, factory prefix', { headRepo: 'o/r', headRefName: 'chore/vanguard-1' }, true],
    ['same repo, other branch', { headRepo: 'o/r', headRefName: 'feat/x' }, false],
    ['fork head', { headRepo: 'fork/r', headRefName: 'chore/vanguard-1' }, false],
    ['unknown head repo', { headRepo: '', headRefName: 'chore/vanguard-1' }, false],
  ])('%s', (_label, overrides, expected) => {
    expect(isFactoryPr(prFacts(overrides), 'o/r', policy)).toBe(expected);
  });
});

describe('collectCheckFacts', () => {
  const runsPage = (runs: Array<{ name: string; conclusion: string | null; appId: number }>): string =>
    JSON.stringify({ check_runs: runs.map((r) => ({ name: r.name, conclusion: r.conclusion, app: { id: r.appId } })) });

  it('resolves each required check by name AND app id', async () => {
    const gh: GhRunner = async () =>
      runsPage([
        { name: 'build', conclusion: 'success', appId: 15368 },
        { name: 'dependency-review', conclusion: 'failure', appId: 15368 },
      ]);
    expect(await collectCheckFacts(gh, 'o/r', SHA, policy)).toEqual([
      { name: 'build', appId: 15368, conclusion: 'success' },
      { name: 'dependency-review', appId: 15368, conclusion: 'failure' },
    ]);
  });

  it('is null for an absent check and for one posted by another app, so no app can impersonate it', async () => {
    const gh: GhRunner = async () => runsPage([{ name: 'build', conclusion: 'success', appId: 99 }]);
    expect(await collectCheckFacts(gh, 'o/r', SHA, policy)).toEqual([
      { name: 'build', appId: 15368, conclusion: null },
      { name: 'dependency-review', appId: 15368, conclusion: null },
    ]);
  });

  it('reads every page of a --paginate response and drops a malformed one', async () => {
    const gh: GhRunner = async () =>
      `${runsPage([{ name: 'build', conclusion: 'success', appId: 15368 }])}{not json}${runsPage([{ name: 'dependency-review', conclusion: 'success', appId: 15368 }])}`;
    expect(await collectCheckFacts(gh, 'o/r', SHA, policy)).toEqual([
      { name: 'build', appId: 15368, conclusion: 'success' },
      { name: 'dependency-review', appId: 15368, conclusion: 'success' },
    ]);
  });
});

describe('collectReviewFacts', () => {
  it('takes the verdict from the external review, matching the real gh login shape', () => {
    const body = buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS\n\nLooks good.', SHA);
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toEqual({
      verdict: 'clean',
      sha: SHA,
      author: 'github-actions',
    });
  });

  it('reads a blocking verdict, and peels the truncation note before the verdict line', () => {
    const body = buildPullRequestReviewComment('Verdict: BLOCKING\n\n[high] boom', SHA, { completed: false });
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toMatchObject({ verdict: 'blocking', sha: SHA });
  });

  it('never counts the in-pipeline main-loop review, even with a valid marker and a clean verdict line', () => {
    const body = buildMainLoopReviewComment('Verdict: NO BLOCKING FINDINGS\n\nLooks good.', {
      headRefOid: SHA,
      attribution: 'claude-opus-5',
    });
    expect(body).toContain(pullRequestReviewMarker(SHA));
    expect(body).toContain('Verdict: NO BLOCKING FINDINGS');
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toEqual({ verdict: null, sha: null, author: null });
  });

  it.each(['Reviewed by :', 'Reviewed by', 'Reviewed by  @ abc1234:'])('treats an empty main-loop attribution "%s" as the main loop too', (line) => {
    const body = `## Vanguard Review\n\n${line}\n\nVerdict: NO BLOCKING FINDINGS\n\n${pullRequestReviewMarker(SHA)}`;
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toEqual({ verdict: null, sha: null, author: null });
  });

  it('prefers the external review when the main-loop review for the same head is also on the PR', () => {
    const mainLoop = review(buildMainLoopReviewComment('Verdict: BLOCKING', { headRefOid: SHA, attribution: 'claude-opus-5' }), {
      submittedAt: '2026-10-20T02:00:00Z',
    });
    const external = review(buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA), { submittedAt: '2026-10-20T01:00:00Z' });
    expect(collectReviewFacts(prFacts({ reviews: [mainLoop, external] }), policy)).toMatchObject({ verdict: 'clean', sha: SHA });
  });

  it('is not a candidate when a human authored the review, marker and verdict notwithstanding', () => {
    const body = buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA);
    expect(collectReviewFacts(prFacts({ reviews: [review(body, { author: 'spietrza' })] }), policy)).toEqual({
      verdict: null,
      sha: null,
      author: null,
    });
  });

  it('counts only a COMMENTED review from an exact allow-listed login, never a lookalike or another review state', () => {
    const body = buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA);
    for (const author of ['github-actions[bot]', 'GitHub-Actions', 'github-actions-ci', 'mallory']) {
      expect(collectReviewFacts(prFacts({ reviews: [review(body, { author })] }), policy).sha).toBeNull();
    }
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING']) {
      expect(collectReviewFacts(prFacts({ reviews: [review(body, { state })] }), policy).sha).toBeNull();
    }
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy).sha).toBe(SHA);
  });

  it('rejects a body with no marker, and one carrying two distinct planted markers', () => {
    const none = buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS');
    const two = `${buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA)}\n\n${pullRequestReviewMarker('deadbeef')}`;
    expect(collectReviewFacts(prFacts({ reviews: [review(none)] }), policy)).toMatchObject({ sha: null });
    expect(collectReviewFacts(prFacts({ reviews: [review(two)] }), policy)).toMatchObject({ sha: null });
  });

  it('finds no verdict when the body does not open with the review heading', () => {
    const body = `Verdict: NO BLOCKING FINDINGS\n\n${pullRequestReviewMarker(SHA)}`;
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toEqual({ verdict: null, sha: null, author: null });
  });

  it('selects the latest submittedAt among candidates', () => {
    const old = review(buildPullRequestReviewComment('Verdict: BLOCKING', 'oldsha'), { submittedAt: '2026-10-19T00:00:00Z' });
    const recent = review(buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA), { submittedAt: '2026-10-21T00:00:00Z' });
    expect(collectReviewFacts(prFacts({ reviews: [recent, old] }), policy)).toMatchObject({ verdict: 'clean', sha: SHA });
  });

  it('keeps the sha but no verdict when the external body states none (review-incomplete)', () => {
    const body = buildPullRequestReviewComment('Some prose with no verdict line.', SHA);
    expect(collectReviewFacts(prFacts({ reviews: [review(body)] }), policy)).toEqual({
      verdict: null,
      sha: SHA,
      author: 'github-actions',
    });
  });

  it('accepts nobody when the allow-list is empty (fail closed, never "any author")', () => {
    const body = buildPullRequestReviewComment('Verdict: NO BLOCKING FINDINGS', SHA);
    const empty = { ...policy, reviewAuthors: [] };
    expect(collectReviewFacts(prFacts({ reviews: [review(body, { author: 'anyone' })] }), empty)).toEqual({ verdict: null, sha: null, author: null });
  });
});
