import { describe, it, expect } from 'vitest';
import { decide, reviewValidity, auditSample } from './rules.js';
import { cleanDiff, cleanFacts } from './facts.fixture.js';
import type { ApproverPolicy } from './types.js';

const policy: ApproverPolicy = {
  schemaVersion: 1,
  enabled: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [{ name: 'build', appId: 15368 }, { name: 'dependency-review', appId: 15368 }],
  reviewAuthors: [],
  testGlobs: ['**/*.test.ts'],
  pathRules: { 'ci-config': ['.github/**'], 'review-pipeline': ['src/approver/**'] },
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0.1 },
};

describe('decide — baseline', () => {
  it('APPROVE with no rules fired on an all-clean fixture', () => {
    const d = decide(cleanFacts(), policy, 'seed-clean-1');
    expect(d.verdict).toBe('APPROVE');
    expect(d.rulesFired).toEqual([]);
  });
});

describe('decide — one rule at a time', () => {
  it('not-factory-pr', () => {
    expect(decide(cleanFacts({ isFactoryPr: false }), policy, 's').rulesFired).toContain('not-factory-pr');
  });
  it('draft', () => {
    const facts = cleanFacts();
    facts.pr = { ...facts.pr, isDraft: true };
    expect(decide(facts, policy, 's').rulesFired).toContain('draft');
  });
  it.each(['CLOSED', 'MERGED', ''])('not-open (state %j)', (state) => {
    const facts = cleanFacts();
    facts.pr = { ...facts.pr, state };
    expect(decide(facts, policy, 's').rulesFired).toEqual(['not-open']);
  });
  it('check-missing:<name> one id per failing check', () => {
    const facts = cleanFacts({ checks: [{ name: 'build', appId: 15368, conclusion: 'failure' }, { name: 'dependency-review', appId: 15368, conclusion: 'success' }] });
    expect(decide(facts, policy, 's').rulesFired).toEqual(['check-missing:build']);
  });
  it('review-missing', () => {
    const facts = cleanFacts({ review: { verdict: null, sha: null, author: null } });
    expect(decide(facts, policy, 's').rulesFired).toContain('review-missing');
  });
  it('review-stale when sha differs with no valid patch-id proof', () => {
    const facts = cleanFacts({ review: { verdict: 'clean', sha: 'old', author: 'bot' } });
    expect(decide(facts, policy, 's').rulesFired).toContain('review-stale');
  });
  it('review-blocking', () => {
    const facts = cleanFacts({ review: { verdict: 'blocking', sha: 'head', author: 'bot' } });
    expect(decide(facts, policy, 's').rulesFired).toContain('review-blocking');
  });
  it('review-incomplete', () => {
    const facts = cleanFacts({ review: { verdict: null, sha: 'head', author: 'bot' } });
    expect(decide(facts, policy, 's').rulesFired).toContain('review-incomplete');
  });
  it('merge-conflict', () => {
    const facts = cleanFacts({ diff: cleanDiff({ mergeTreeHeadClean: false }) });
    expect(decide(facts, policy, 's').rulesFired).toContain('merge-conflict');
  });
  it('head-moved', () => {
    const facts = cleanFacts({ diff: cleanDiff({ headMoved: true }) });
    expect(decide(facts, policy, 's').rulesFired).toContain('head-moved');
  });
  it('git-facts-failed', () => {
    const facts = cleanFacts({ diff: cleanDiff({ gitFactsFailed: true }) });
    expect(decide(facts, policy, 's').rulesFired).toContain('git-facts-failed');
  });
  it.each([['ci-config', '.github/workflows/x.yml'], ['review-pipeline', 'src/approver/rules.ts']])('path:%s', (key, path) => {
    const facts = cleanFacts({ diff: cleanDiff({ paths: [path] }) });
    expect(decide(facts, policy, 's').rulesFired).toContain(`path:${key}`);
  });
  it('size-lines: 150 passes, 151 fires', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ lines: 150 }) }), policy, 's').rulesFired).not.toContain('size-lines');
    expect(decide(cleanFacts({ diff: cleanDiff({ lines: 151 }) }), policy, 's').rulesFired).toContain('size-lines');
  });
  it('size-files: 5 passes, 6 fires', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ files: 5 }) }), policy, 's').rulesFired).not.toContain('size-files');
    expect(decide(cleanFacts({ diff: cleanDiff({ files: 6 }) }), policy, 's').rulesFired).toContain('size-files');
  });
  it('test-file-deleted', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ testFilesDeleted: 1 }) }), policy, 's').rulesFired).toContain('test-file-deleted');
  });
  it('test-cases-lost', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ testCasesDelta: -2 }) }), policy, 's').rulesFired).toContain('test-cases-lost');
  });
  it('new-dependency', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ newDependency: true }) }), policy, 's').rulesFired).toContain('new-dependency');
  });
  it('public-api-changed', () => {
    expect(decide(cleanFacts({ diff: cleanDiff({ exportsRemoved: 1 }) }), policy, 's').rulesFired).toContain('public-api-changed');
  });
  it('velocity: 250+60 fires, 250+40 passes', () => {
    const fires = decide(cleanFacts({ ledger: { 'src/foo': 250 }, thisPrLines: 60 }), policy, 's');
    expect(fires.rulesFired).toContain('velocity');
    const passes = decide(cleanFacts({ ledger: { 'src/foo': 250 }, thisPrLines: 40 }), policy, 's');
    expect(passes.rulesFired).not.toContain('velocity');
  });
  it('policy-unreadable / stopped are exclusive, handled by the caller — stopped short-circuits here', () => {
    const d = decide(cleanFacts(), { ...policy, enabled: false }, 's');
    expect(d.rulesFired).toEqual(['stopped']);
  });
});

describe('decide — multiple rules and determinism', () => {
  it('multiple rules all appear, ordered and deduped', () => {
    const facts = cleanFacts({ isFactoryPr: false, diff: cleanDiff({ lines: 200, paths: ['src/foo.ts', 'src/foo.ts'] }) });
    const d = decide(facts, policy, 's');
    expect(d.rulesFired).toContain('not-factory-pr');
    expect(d.rulesFired).toContain('size-lines');
    expect(d.rulesFired.filter((r) => r === 'size-lines')).toHaveLength(1);
  });
  it('stopped short-circuits even when other rules would also fire', () => {
    const d = decide(cleanFacts({ isFactoryPr: false }), { ...policy, enabled: false }, 's');
    expect(d.rulesFired).toEqual(['stopped']);
  });
  it('decide is pure: identical inputs twice give an identical object, clock-independent', () => {
    const a = decide(cleanFacts(), policy, 'seed-x');
    const b = decide(cleanFacts(), policy, 'seed-x');
    expect(a).toEqual(b);
  });
});

describe('reviewValidity', () => {
  it('same SHA -> valid', () => {
    expect(reviewValidity(cleanFacts())).toBe(true);
  });
  it('different SHA, equal patch-id, ancestor, no conflict -> valid', () => {
    const facts = cleanFacts({
      review: { verdict: 'clean', sha: 'old', author: 'bot' },
      diff: cleanDiff({ headPatchId: 'p1', reviewedPatchId: 'p1', reviewedIsAncestor: true, mergeTreeReviewedClean: true, mergeTreeHeadClean: true }),
    });
    expect(reviewValidity(facts)).toBe(true);
  });
  it('a conflict -> invalid', () => {
    const facts = cleanFacts({
      review: { verdict: 'clean', sha: 'old', author: 'bot' },
      diff: cleanDiff({ headPatchId: 'p1', reviewedPatchId: 'p1', reviewedIsAncestor: true, mergeTreeReviewedClean: false, mergeTreeHeadClean: true }),
    });
    expect(reviewValidity(facts)).toBe(false);
  });
  it('patch-id unknown -> invalid', () => {
    const facts = cleanFacts({ review: { verdict: 'clean', sha: 'old', author: 'bot' }, diff: cleanDiff({ reviewedPatchId: undefined }) });
    expect(reviewValidity(facts)).toBe(false);
  });
  it('patch-ids equal but not an ancestor -> invalid', () => {
    const facts = cleanFacts({
      review: { verdict: 'clean', sha: 'old', author: 'bot' },
      diff: cleanDiff({ headPatchId: 'p1', reviewedPatchId: 'p1', reviewedIsAncestor: false, mergeTreeReviewedClean: true, mergeTreeHeadClean: true }),
    });
    expect(reviewValidity(facts)).toBe(false);
  });
  it('missing review -> invalid', () => {
    expect(reviewValidity(cleanFacts({ review: { verdict: null, sha: null, author: null } }))).toBe(false);
  });
});

describe('auditSample', () => {
  it('p=0 never fires; p=1 fires on an otherwise-clean decision', () => {
    expect(decide(cleanFacts(), { ...policy, auditSample: { p: 0 } }, 's').rulesFired).not.toContain('audit-sample');
    expect(decide(cleanFacts(), { ...policy, auditSample: { p: 1 } }, 's').rulesFired).toContain('audit-sample');
  });
  it('p=1 does not add audit-sample to an already-ESCALATE decision', () => {
    const d = decide(cleanFacts({ isFactoryPr: false }), { ...policy, auditSample: { p: 1 } }, 's');
    expect(d.rulesFired).not.toContain('audit-sample');
  });
  it('same seed gives the same hit across repeated calls; different seeds can differ', () => {
    const first = auditSample('same-seed', 0.1).hit;
    for (let i = 0; i < 20; i += 1) expect(auditSample('same-seed', 0.1).hit).toBe(first);
    const hits = new Set([auditSample('seed-a', 0.5).hit, auditSample('seed-b', 0.5).hit, auditSample('seed-c', 0.5).hit, auditSample('seed-d', 0.5).hit]);
    expect(hits.size).toBeGreaterThanOrEqual(1);
  });
  it('VANGUARD_APPROVER_AUDIT_SEED overrides the computed seed for replay', () => {
    process.env.VANGUARD_APPROVER_AUDIT_SEED = 'fixed-seed';
    try {
      expect(auditSample('irrelevant', 0.1).seed).toBe('fixed-seed');
    } finally {
      delete process.env.VANGUARD_APPROVER_AUDIT_SEED;
    }
  });
});

  it.each(['skills/review/SKILL.md', '.github/vanguard-skills/review/SKILL.md', 'skills.lock.json', 'vitest.config.ts'])('escalates protected config %s regardless of path policy', (path) => {
    const facts = cleanFacts({ diff: cleanDiff({ paths: [path], gateConfigPaths: [path] }) });
    const result = decide(facts, { ...policy, pathRules: {} }, 'seed-clean-1');
    expect(result.verdict).toBe('ESCALATE');
    expect(result.rulesFired).toContain('gate-config-changed');
  });
