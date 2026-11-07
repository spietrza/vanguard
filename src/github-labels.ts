import type { ProofFailureKind } from './runners/source-adapter.js';

export const GITHUB_SPEC_CLAIMED_LABEL = 'vanguard:speccing';
export const GITHUB_CLAIMED_LABEL = 'vanguard:running';
export const GITHUB_REVIEW_LABEL = 'vanguard:needs-human-review';
export const GITHUB_NEEDS_RESEARCH_LABEL = 'needs research';
export const GITHUB_RESEARCHING_LABEL = 'vanguard:researching';
export const GITHUB_VERIFY_FAILED_LABEL = 'vanguard:verify-failed';
export const GITHUB_VISUAL_PROOF_FAILED_LABEL = 'vanguard:visual-proof-failed';
export const GITHUB_SECRET_BLOCKED_LABEL = 'vanguard:secret-blocked';
export const GITHUB_GATE_CONFIG_LABEL = 'vanguard:gate-config-changed';

/** Map a proof-failure kind to its GitHub label. */
export function githubFailureLabel(kind: ProofFailureKind): string {
  if (kind === 'gate-config') return GITHUB_GATE_CONFIG_LABEL;
  return kind === 'verify' ? GITHUB_VERIFY_FAILED_LABEL : GITHUB_VISUAL_PROOF_FAILED_LABEL;
}
