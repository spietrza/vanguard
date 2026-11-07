/**
 * The persisted reading of one reviewer/conformance reply: the merge gate's verdict plus the
 * `<findings>` block, so the record, the PR body and the Task Board chip can all read the SAME
 * decision instead of re-deriving it.
 */
import { hasBlockingFinding } from '../runners/review-prompt.js';
import { extractFindings } from '../structured/findings.js';
import type { Finding, ReviewVerdict } from '../wire.js';

export interface ReviewVerdictSummary {
  verdict: ReviewVerdict;
  findings: Finding[];
}

/**
 * The persisted reading of one review reply. `changes` iff `hasBlockingFinding()` — the SAME
 * predicate `publishReviewVerdict` gates `request-changes` on, so a chip can never disagree with
 * what the bot actually did to the PR. The stated `Verdict:` line is NOT used: nothing gates on it
 * today (see verdictContradictsFindings) and a self-contradicting reply must read as the gate read
 * it. `findings` is `[]` when no parseable `<findings>` block is present.
 */
export function reviewVerdictOf(text: string): ReviewVerdictSummary {
  const verdict: ReviewVerdict = hasBlockingFinding(text) ? 'changes' : 'pass';
  let findings: Finding[];
  try {
    findings = extractFindings(text).findings;
  } catch {
    findings = [];
  }
  return { verdict, findings };
}

/** `Review: PASS (0 findings)` / `Review: CHANGES (3 findings)` — the PR-body one-liner. */
export function reviewVerdictLine(summary: ReviewVerdictSummary): string {
  const n = summary.findings.length;
  const label = summary.verdict === 'pass' ? 'PASS' : 'CHANGES';
  return `Review: ${label} (${n} finding${n === 1 ? '' : 's'})`;
}
