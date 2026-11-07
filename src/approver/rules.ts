import { gateConfigPaths } from '../context/gate-config.js';
import { createHash } from 'node:crypto';
import { matchingPathRuleKeys } from './policy.js';
import type { ApproverFacts, ApproverPolicy, AuditSample, Decision, DiffFacts } from './types.js';

/** `diff.gateConfigPaths`, or recomputed path-only (no package.json script heuristic) for facts predating that field. */
function gateConfigPathsOf(diff: DiffFacts): string[] {
  return diff.gateConfigPaths ?? gateConfigPaths(diff.paths.map((path) => ({ path })));
}

/**
 * Whether the review on file speaks for the current head content: same SHA, or an equal patch-id
 * on an ancestor commit with both merge-trees clean. Any unknown collapses to invalid; a conflict
 * anywhere forces a fresh review.
 */
export function reviewValidity(facts: ApproverFacts): boolean {
  const { review, diff } = facts;
  if (review.sha === null) return false;
  if (review.sha === diff.headSha) return true;
  if (diff.reviewedPatchId === undefined || diff.headPatchId === undefined) return false;
  if (diff.reviewedPatchId !== diff.headPatchId) return false;
  if (diff.reviewedIsAncestor !== true) return false;
  if (diff.mergeTreeReviewedClean !== true) return false;
  if (diff.mergeTreeHeadClean !== true) return false;
  return true;
}

/** Deterministic, replayable audit sample: u = sha256(seed) read as a uint32 fraction; hit iff u < p. */
export function auditSample(seedInput: string, p: number): AuditSample {
  const seed = process.env.VANGUARD_APPROVER_AUDIT_SEED ?? seedInput;
  const u = createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32;
  return { p, seed, hit: u < p };
}

/**
 * Pure decision function: typed facts + policy + seed => verdict and every rule id that fired.
 * No I/O, no Date.now, no Math.random — the clock and seed are inputs so a run is always replayable.
 */
export function decide(facts: ApproverFacts, policy: ApproverPolicy, seedInput: string): Decision {
  const sample = auditSample(seedInput, policy.auditSample.p);

  if (policy.enabled === false || (process.env.VANGUARD_APPROVER_STOP ?? '') !== '') {
    return { verdict: 'ESCALATE', rulesFired: ['stopped'], auditSample: sample, reviewValid: false };
  }

  const rules: string[] = [];
  const fire = (id: string): void => {
    if (!rules.includes(id)) rules.push(id);
  };

  if (!facts.isFactoryPr) fire('not-factory-pr');
  if (facts.pr.state !== 'OPEN') fire('not-open');
  if (facts.pr.isDraft) fire('draft');
  for (const check of facts.checks) if (check.conclusion !== 'success') fire(`check-missing:${check.name}`);

  const reviewValid = reviewValidity(facts);
  if (facts.review.sha === null) fire('review-missing');
  else if (!reviewValid) fire('review-stale');
  if (facts.review.verdict === 'blocking') fire('review-blocking');
  if (facts.review.sha !== null && facts.review.verdict === null) fire('review-incomplete');

  if (facts.diff.mergeTreeHeadClean === false) fire('merge-conflict');
  if (facts.diff.headMoved) fire('head-moved');
  if (facts.diff.gitFactsFailed) fire('git-facts-failed');
  if (gateConfigPathsOf(facts.diff).length > 0) fire('gate-config-changed');

  for (const path of facts.diff.paths) {
    for (const key of matchingPathRuleKeys(policy.pathRules, path)) fire(`path:${key}`);
  }

  if (facts.diff.lines > policy.shape.maxLines) fire('size-lines');
  if (facts.diff.files > policy.shape.maxFiles) fire('size-files');
  if (facts.diff.testFilesDeleted > 0) fire('test-file-deleted');
  if (facts.diff.testCasesDelta < 0) fire('test-cases-lost');
  if (facts.diff.newDependency) fire('new-dependency');
  if (facts.diff.exportsRemoved > 0) fire('public-api-changed');

  const velocityFired = Object.values(facts.ledger).some((trailing) => trailing + facts.thisPrLines > policy.ledger.maxLines);
  if (velocityFired) fire('velocity');

  if (rules.length === 0 && sample.hit) fire('audit-sample');

  return { verdict: rules.length === 0 ? 'APPROVE' : 'ESCALATE', rulesFired: rules, auditSample: sample, reviewValid };
}
