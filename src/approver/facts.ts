import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { extractReviewVerdict, VERDICT_WITHOUT_COMPLETION_NOTE } from '../runners/review-prompt.js';
import { pullRequestReviewMarkerShas } from '../runners/pr-review.js';
import type { ApproverPolicy, CheckFact, PrFacts, ReviewFacts } from './types.js';

/** Typed-facts collectors: gh JSON only, never free text from an issue/PR/comment body into the engine. */

interface GhPrView {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefOid?: string;
  headRefName?: string;
  baseRefName?: string;
  baseRefOid?: string;
  headRepository?: { name?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
  reviews?: Array<{ author?: { login?: string } | null; body?: string; submittedAt?: string; state?: string }>;
}

export async function collectPrFacts(gh: GhRunner, repoSlug: string, prNumber: number): Promise<PrFacts> {
  const out = await gh([
    'pr', 'view', String(prNumber), '--repo', repoSlug, '--json',
    'number,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,url,headRepository,headRepositoryOwner,state,reviews',
  ]);
  const view = JSON.parse(out) as GhPrView;
  const owner = view.headRepositoryOwner?.login;
  const name = view.headRepository?.name;
  const headRepo = owner !== undefined && owner !== '' && name !== undefined && name !== '' ? `${owner}/${name}` : '';
  return {
    number: view.number ?? prNumber,
    url: view.url ?? '',
    state: view.state ?? '',
    isDraft: view.isDraft ?? false,
    headSha: view.headRefOid ?? '',
    headRefName: view.headRefName ?? '',
    baseRefName: view.baseRefName ?? '',
    apiBaseSha: view.baseRefOid ?? '',
    headRepo,
    reviews: (view.reviews ?? []).map((r) => ({
      author: r.author?.login ?? '',
      body: r.body ?? '',
      submittedAt: r.submittedAt ?? '',
      state: r.state ?? '',
    })),
  };
}

/** Same-repo `chore/vanguard-*` head: a factory PR, never a fork and never an arbitrary branch. */
export function isFactoryPr(pr: PrFacts, repoSlug: string, policy: ApproverPolicy): boolean {
  return pr.headRepo === repoSlug && pr.headRefName.startsWith(policy.factoryBranchPrefix);
}

interface GhCheckRun {
  name?: string;
  conclusion?: string | null;
  app?: { id?: number } | null;
}
interface GhCheckRunsResponse {
  check_runs?: GhCheckRun[];
}

/** `gh api --paginate` concatenates JSON page bodies with no separator; split them back into objects. */
function splitJsonObjects(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const chunks: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        chunks.push(trimmed.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  return chunks;
}

/**
 * For each `policy.requiredChecks` entry, the check run whose name AND app id both match on the head
 * SHA. Only `'success'` satisfies the approver's preconditions; absent or a mismatched app id both
 * resolve to `null` so a check run posted by any other app (or a raw token) cannot impersonate it.
 */
export async function collectCheckFacts(
  gh: GhRunner,
  repoSlug: string,
  headSha: string,
  policy: ApproverPolicy,
): Promise<CheckFact[]> {
  const out = await gh(['api', `repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`, '--paginate']);
  const runs: GhCheckRun[] = [];
  for (const chunk of splitJsonObjects(out)) {
    try {
      const parsed = JSON.parse(chunk) as GhCheckRunsResponse;
      runs.push(...(parsed.check_runs ?? []));
    } catch {
      // a malformed page is dropped, not fatal
    }
  }
  return policy.requiredChecks.map((required) => {
    const match = runs.find((r) => r.name === required.name && r.app?.id === required.appId);
    return { name: required.name, appId: required.appId, conclusion: match?.conclusion ?? null };
  });
}

const REVIEW_HEADING = '## Vanguard Review';
// `Reviewed by <attribution>[ @ <sha7>]:` — the main loop's own in-pipeline review
// (buildMainLoopReviewComment), posted by the same identity and carrying the same head marker.
// Word boundary, not `\S`: an empty attribution (`Reviewed by :` or a bare `Reviewed by`) is still the main loop's.
const REVIEWED_BY_RE = /^Reviewed by\b/;

/**
 * Peel the external review's framing off a published body: the `## Vanguard Review` heading, then
 * optionally the exact "truncated" note — skipping blank lines between them — before handing the
 * remainder to extractReviewVerdict, the only function that decides the verdict grammar.
 *
 * Returns undefined for anything that is not that format, which disqualifies the review entirely:
 * a body that does not open with the heading, or one whose first content line is the main loop's
 * `Reviewed by ...:` attribution. The in-pipeline review is NOT independent — it runs before the
 * simplifier and the repair loop and edits code itself — so its verdict must never be the
 * approver's, even though it is indistinguishable by author and marker.
 */
function peelReviewPrefix(body: string): string | undefined {
  const lines = body.split('\n');
  if (lines[0] !== REVIEW_HEADING) return undefined;
  let i = 1;
  const skipBlank = (): void => {
    while (i < lines.length && lines[i]!.trim() === '') i += 1;
  };
  skipBlank();
  if (i < lines.length && REVIEWED_BY_RE.test(lines[i]!)) return undefined;
  if (i < lines.length && lines[i] === VERDICT_WITHOUT_COMPLETION_NOTE) {
    i += 1;
    skipBlank();
  }
  return lines.slice(i).join('\n');
}

/**
 * Select the review that speaks for the current content and extract its verdict. Candidates are
 * reviews in the external review format (see peelReviewPrefix) whose body carries exactly one
 * distinct marker SHA (zero = no marker, more than one = a planted marker, both rejected), which was
 * posted as a plain COMMENTED review, and whose author is exactly a login on `policy.reviewAuthors`
 * (an empty list accepts nobody); the latest `submittedAt` among
 * survivors wins. Returns all-null when there is none.
 */
export function collectReviewFacts(pr: PrFacts, policy: ApproverPolicy): ReviewFacts {
  const candidates = pr.reviews.flatMap((r) => {
    const shas = [...new Set(pullRequestReviewMarkerShas(r.body))];
    const peeled = peelReviewPrefix(r.body);
    if (shas.length !== 1 || peeled === undefined) return [];
    // The external review only ever posts with `gh pr review --comment`: an approval, a change request or a
    // dismissed review in the same shape is some other writer (or a withdrawn verdict), never the verdict.
    if (r.state !== 'COMMENTED') return [];
    if (!policy.reviewAuthors.includes(r.author)) return [];
    return [{ author: r.author, submittedAt: r.submittedAt, sha: shas[0]!, peeled }];
  });
  if (candidates.length === 0) return { verdict: null, sha: null, author: null };
  candidates.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const selected = candidates[candidates.length - 1]!;
  return { verdict: extractReviewVerdict(selected.peeled) ?? null, sha: selected.sha, author: selected.author };
}

export { defaultGhRunner };
