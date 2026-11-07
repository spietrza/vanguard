/**
 * Decision record, facts, and policy types for the approver stage (v1: shadow mode). See
 * `src/approver/rules.ts` for the pure decision function and `src/approver/policy.ts` for the
 * zod schema these types mirror.
 */

export interface ApproverPolicy {
  schemaVersion: 1;
  enabled: boolean;
  factoryBranchPrefix: string;
  requiredChecks: Array<{ name: string; appId: number }>;
  reviewAuthors: string[];
  testGlobs: string[];
  pathRules: Record<string, string[]>;
  shape: { maxLines: number; maxFiles: number };
  ledger: { windowDays: number; maxLines: number };
  auditSample: { p: number };
}

export interface PrFacts {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  apiBaseSha: string;
  /** owner/name of the head repo, '' when the API omits it. */
  headRepo: string;
  reviews: Array<{ author: string; body: string; submittedAt: string; state: string }>;
}

export interface CheckFact {
  name: string;
  appId: number;
  conclusion: string | null;
}

export type ReviewVerdictValue = 'clean' | 'blocking' | null;

export interface ReviewFacts {
  verdict: ReviewVerdictValue;
  sha: string | null;
  author: string | null;
}

export interface DiffFacts {
  gateConfigPaths?: string[];
  files: number;
  lines: number;
  paths: string[];
  testFilesDeleted: number;
  testCasesDelta: number;
  exportsRemoved: number;
  newDependency: boolean;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  /** patch-id of merge-base..headSha, or undefined when the diff is empty / the computation failed. */
  headPatchId: string | undefined;
  /** patch-id of merge-base..reviewedSha, computed only when reviewedSha !== headSha. */
  reviewedPatchId: string | undefined;
  /** Whether reviewedSha is an ancestor of headSha (true trivially when they are equal). */
  reviewedIsAncestor: boolean | undefined;
  /** merge-tree(baseSha, headSha): true clean, false conflict, undefined on failure. */
  mergeTreeHeadClean: boolean | undefined;
  /** merge-tree(baseSha, reviewedSha), computed only when reviewedSha !== headSha. */
  mergeTreeReviewedClean: boolean | undefined;
  /** The fetched refs/pull/<n>/head did not match the API head SHA. */
  headMoved: boolean;
  /** Any required git fact could not be computed (fetch/merge-base/numstat failure). */
  gitFactsFailed: boolean;
}

export interface ApproverFacts {
  pr: Omit<PrFacts, 'reviews'>;
  isFactoryPr: boolean;
  checks: CheckFact[];
  review: ReviewFacts;
  diff: DiffFacts;
  ledger: Record<string, number>;
  /** Σ of this PR's own changed lines — folded into the ledger module sums for the velocity rule. */
  thisPrLines: number;
}

export interface AuditSample {
  p: number;
  seed: string;
  hit: boolean;
}

export interface Decision {
  verdict: 'APPROVE' | 'ESCALATE';
  rulesFired: string[];
  auditSample: AuditSample;
  reviewValid: boolean;
}

export type Mode = 'shadow';

export interface DecisionRecord {
  schemaVersion: 1;
  mode: Mode;
  repo: string;
  prNumber: number;
  headSha: string | null;
  baseSha: string | null;
  patchId: string | null;
  reviewedSha: string | null;
  checks: CheckFact[];
  review: { verdict: ReviewVerdictValue; sha: string | null };
  signals: {
    files: number;
    lines: number;
    testFilesDeleted: number;
    testCasesDelta: number;
    exportsRemoved: number;
    newDependency: boolean;
    paths: string[];
  };
  ledger: Record<string, number>;
  auditSample: AuditSample;
  rulesFired: string[];
  verdict: 'APPROVE' | 'ESCALATE';
  policyHash: string;
  timestamp: string;
  humanOutcome: 'merged-as-is' | 'merged-after-changes' | 'closed' | 'reverted' | null;
}
