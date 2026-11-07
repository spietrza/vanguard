import { defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { VanguardError } from '../core/errors.js';
import { classifyAuthor } from '../tasks/comment-trust.js';
import type { Decision, DecisionRecord } from './types.js';

// gh api flags that take a value; the endpoint is the one positional argument left after them.
const API_VALUE_FLAGS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview']);
const API_BODY_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--input']);
const REPO = '[^/?\\s]+/[^/?\\s]+';
/** The only endpoints shadow mode may call: read check runs on a commit, create one, update one. */
const ALLOWED_API: Record<string, RegExp> = {
  GET: new RegExp(`^repos/${REPO}/commits/[^/?\\s]+/check-runs(\\?[^/\\s]*)?$`),
  POST: new RegExp(`^repos/${REPO}/check-runs$`),
  PATCH: new RegExp(`^repos/${REPO}/check-runs/\\d+$`),
};

/** Method and endpoint of a `gh api` argv, the way gh resolves them: a body without -X means POST. */
function parseApiCall(args: string[]): { method: string; endpoints: string[] } {
  let method: string | undefined;
  let hasBody = false;
  const endpoints: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]!;
    if (API_VALUE_FLAGS.has(a)) {
      if (a === '-X' || a === '--method') method = args[i + 1];
      if (API_BODY_FLAGS.has(a)) hasBody = true;
      i += 1;
    } else if (a.startsWith('--')) {
      const [flag, value] = a.split('=', 2);
      if (flag === '--method') method = value;
      if (API_BODY_FLAGS.has(flag!)) hasBody = true;
    } else if (a.startsWith('-') && a.length > 2) {
      // short flag with its value attached (-XPOST, -fname=x)
      if (a[1] === 'X') method = a.slice(2);
      if (a[1] === 'f' || a[1] === 'F') hasBody = true;
    } else if (!a.startsWith('-')) {
      endpoints.push(a);
    }
  }
  return { method: (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase(), endpoints };
}

/**
 * Allowlist over argv: shadow mode makes exactly three kinds of gh call — `pr view <n> --repo <r>
 * --json <f>`, `pr comment <n> --repo <r> --body <b>`, and `api` on the check-runs endpoints above.
 * Anything else (graphql, merges, refs, labels, reviews) throws, so a future edit cannot widen what
 * shadow mode can do without changing this list. Applied by wrapping every GhRunner the engine uses.
 */
export function assertShadowSafeGhArgs(args: string[]): void {
  const [cmd, sub, num, repoFlag, , valueFlag] = args;
  if (cmd === 'pr' && args.length === 7 && /^\d+$/.test(num ?? '') && repoFlag === '--repo') {
    if ((sub === 'view' && valueFlag === '--json') || (sub === 'comment' && valueFlag === '--body')) return;
  }
  if (cmd === 'api') {
    const { method, endpoints } = parseApiCall(args);
    if (endpoints.length === 1 && ALLOWED_API[method]?.test(endpoints[0]!) === true) return;
  }
  throw new VanguardError(`shadow mode: refusing gh call "${args.join(' ')}"`);
}

/** Wrap a GhRunner so any shadow-unsafe argv throws before it reaches gh — the second, independent guard layer. */
export function shadowSafeGhRunner(gh: GhRunner): GhRunner {
  return async (args: string[]): Promise<string> => {
    assertShadowSafeGhArgs(args);
    return gh(args);
  };
}

function summaryBody(decision: Decision, record: DecisionRecord): string {
  return [
    `Verdict: ${decision.verdict}`,
    decision.rulesFired.length === 0 ? '(no rules fired)' : decision.rulesFired.map((r) => `- ${r}`).join('\n'),
    `Signals: files=${record.signals.files} lines=${record.signals.lines} testFilesDeleted=${record.signals.testFilesDeleted} testCasesDelta=${record.signals.testCasesDelta} exportsRemoved=${record.signals.exportsRemoved} newDependency=${record.signals.newDependency}`,
    `Audit: p=${decision.auditSample.p} hit=${decision.auditSample.hit}`,
    `Policy: ${record.policyHash}`,
  ].join('\n');
}

interface GhCheckRunsLookup {
  check_runs?: Array<{ id: number; external_id?: string }>;
}

/**
 * `vanguard/approver` check run on the head SHA, conclusion `neutral` in shadow mode regardless of
 * verdict. Idempotent per (PR, head SHA) via `external_id`: PATCHes an existing run, else POSTs.
 * A failure throws; runApprover still records the decision and then reports it.
 */
export async function publishCheckRun(
  gh: GhRunner,
  repoSlug: string,
  headSha: string,
  prNumber: number,
  decision: Decision,
  record: DecisionRecord,
): Promise<void> {
  const safeGh = shadowSafeGhRunner(gh);
  const externalId = `${prNumber}:${headSha}`;
  const title = `${decision.verdict} (shadow)`;
  const summary = summaryBody(decision, record);
  const existing = await safeGh(['api', `repos/${repoSlug}/commits/${headSha}/check-runs?check_name=vanguard%2Fapprover`]);
  const parsed = JSON.parse(existing) as GhCheckRunsLookup;
  const match = (parsed.check_runs ?? []).find((r) => r.external_id === externalId);
  const fields = [
    '-f', 'name=vanguard/approver',
    '-f', `head_sha=${headSha}`,
    '-f', 'status=completed',
    '-f', 'conclusion=neutral',
    '-f', `external_id=${externalId}`,
    '-f', `output[title]=${title}`,
    '-f', `output[summary]=${summary}`,
  ];
  if (match !== undefined) {
    await safeGh(['api', '--method', 'PATCH', `repos/${repoSlug}/check-runs/${match.id}`, ...fields]);
  } else {
    // Create is POST /repos/{owner}/{repo}/check-runs; /commits/{sha}/check-runs only lists.
    await safeGh(['api', '--method', 'POST', `repos/${repoSlug}/check-runs`, ...fields]);
  }
}

const COMMENT_HEADING = '## Vanguard Approver (shadow mode)';

function commentBody(decision: Decision, record: DecisionRecord): string {
  return [
    COMMENT_HEADING,
    '',
    `Verdict: **${decision.verdict}**`,
    '',
    decision.rulesFired.length === 0 ? 'No rules fired.' : decision.rulesFired.map((r) => `- ${r}`).join('\n'),
    '',
    `Signals: files=${record.signals.files}, lines=${record.signals.lines}, testFilesDeleted=${record.signals.testFilesDeleted}, testCasesDelta=${record.signals.testCasesDelta}, exportsRemoved=${record.signals.exportsRemoved}, newDependency=${record.signals.newDependency}`,
    '',
    '_Shadow mode — nothing was merged, approved or labelled._',
    '',
    `<!-- vanguard-approver: ${record.headSha ?? 'none'} -->`,
  ].join('\n');
}

interface GhComment {
  body?: string;
  author?: { login?: string } | null;
  authorAssociation?: string;
}

/** A human-readable copy of the decision, deduped per head SHA by a hidden marker. Nothing ever parses this comment. */
export async function commentDecision(
  gh: GhRunner,
  repoSlug: string,
  prNumber: number,
  decision: Decision,
  record: DecisionRecord,
): Promise<void> {
  const safeGh = shadowSafeGhRunner(gh);
  const marker = `<!-- vanguard-approver: ${record.headSha ?? 'none'} -->`;
  try {
    const out = await safeGh(['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'comments']);
    const parsed = JSON.parse(out) as { comments?: GhComment[] };
    // Only a trusted author's marker dedupes: anyone can post the marker text to suppress the decision comment.
    const trusted = (c: GhComment): boolean => classifyAuthor(c.author?.login ?? '', c.authorAssociation ?? '') !== 'untrusted';
    if ((parsed.comments ?? []).some((c) => c.body?.includes(marker) === true && trusted(c))) return;
  } catch {
    // best-effort dedupe lookup; fall through and post
  }
  await safeGh(['pr', 'comment', String(prNumber), '--repo', repoSlug, '--body', commentBody(decision, record)]);
}

export { defaultGhRunner };
