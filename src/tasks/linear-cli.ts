import { execa } from 'execa';
import { VanguardError } from '../core/errors.js';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

/** Runs the `linear` CLI and returns stdout. Injected for testing. */
export type LinearCliRunner = (args: string[]) => Promise<string>;

const defaultRunner: LinearCliRunner = async (args: string[]): Promise<string> => (await execa('linear', args)).stdout;

// `issue view <id> --json` returns a single issue WITH a description, children.nodes (sub-issues) and
// comments (included by default; `--no-comments` excludes them) but no labels — so fetch() uses it.
// The comments field shape varies (array vs { nodes: [...] }) and author is exposed under user/author
// with name/displayName, so it is parsed defensively.
//
// list() does NOT use the CLI — see the note on list(). An earlier version shelled `issue query`,
// which does not exist in the installed CLI (this file previously claimed "verified against
// linear-cli 2.0"; the CLI in play is schpet v1.11.1). The same LinearCliIssue shape is reused for
// the GraphQL nodes, which return the same fields.
interface LinearCliActor {
  name?: string;
  displayName?: string;
}

interface LinearCliCommentNode {
  body?: string | null;
  /** The workspace user who wrote it; Linear sets it to null for integration and bot comments. */
  user?: LinearCliActor | null;
  author?: LinearCliActor | null;
  /** Set instead of `user` when an integration (Slack, Intercom, Asks) posted for a non-member. */
  externalUser?: LinearCliActor | null;
}

interface LinearCliIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  labels?: { nodes?: Array<{ name?: string }> };
  state?: { name?: string; type?: string };
  children?: { nodes?: Array<{ identifier?: string; id?: string; title?: string }> };
  comments?: LinearCliCommentNode[] | { nodes?: LinearCliCommentNode[] };
}

/**
 * Accepts comments as either an array or a { nodes: [...] } connection; unknown shapes -> [].
 * Only a comment Linear attributes to a workspace `user` is stamped `authorAssociation: 'MEMBER'`.
 * Vanguard's own spec comment is posted under the API key owner's user, so it keeps MEMBER (its
 * human name does not match isBotLogin; without the stamp every Linear run would fall back to
 * Part of). A comment an integration posted (Slack sync, Intercom, Asks) carries `externalUser` or
 * no user at all: it gets author '' and association '', which fails closed like GitHub's omitted
 * association. The external display name is chosen outside the workspace, so it never becomes
 * `author`: it would be matched against bot logins and --feedback-authors.
 */
function parseComments(comments: LinearCliIssue['comments']): TaskComment[] {
  const nodes = Array.isArray(comments) ? comments : (comments?.nodes ?? []);
  return nodes
    .map((node) => {
      const member = node.user ?? node.author ?? undefined;
      return {
        author: member?.name ?? member?.displayName ?? '',
        body: node.body ?? '',
        authorAssociation: member !== undefined ? 'MEMBER' : '',
      };
    })
    .filter((comment) => comment.body !== ''); // attachment-only comments have no body; skip for v1
}

function toTask(issue: LinearCliIssue): Task {
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name ?? '').filter((name) => name !== '');
  const children = (issue.children?.nodes ?? [])
    .map((child) => ({ id: child.identifier ?? child.id ?? '', title: child.title ?? '' }))
    .filter((child) => child.id !== '');
  const stateName = issue.state?.name;
  return {
    id: issue.identifier ?? issue.id ?? '',
    title: issue.title ?? '',
    description: issue.description ?? '',
    labels,
    children,
    comments: parseComments(issue.comments),
    ref: issue.identifier ?? issue.id ?? '',
    // The LIST query has always fetched state — it was dropped here. The board needs it (S9).
    ...(stateName !== undefined ? { state: stateName } : {}),
  };
}

/** One Linear GraphQL round-trip. Injected for testing; the default posts to the public API. */
export type LinearGraphql = (body: { query: string; variables: Record<string, unknown> }) => Promise<unknown>;

const LINEAR_API = 'https://api.linear.app/graphql';

/**
 * The credential, in the order the CLI itself resolves it. `LINEAR_API_KEY` first because the commands
 * that list issues already require it (`cli/watch.ts` and `sidecar/deps.ts` both hard-throw without
 * it), so it is present exactly where list() is used. The `linear auth token` fallback covers the
 * desktop, which inherits a login rather than an env var.
 */
async function linearToken(run: LinearCliRunner): Promise<string> {
  // Trim, like the CLI-fallback path below: a whitespace-only key would otherwise be sent as the
  // Authorization value and fail at Linear with an opaque 401 instead of the actionable message here.
  const fromEnv = process.env['LINEAR_API_KEY']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  let token: string;
  try {
    token = (await run(['auth', 'token'])).trim();
  } catch {
    // Non-zero exit = not logged in. Without this map the raw execa error ("Command failed…")
    // reaches the board on every load (S9 — the Rust board had the actionable message; core didn't).
    throw new VanguardError('Not logged in to Linear — run `linear auth login` or set LINEAR_API_KEY.');
  }
  if (token === '') throw new VanguardError('No Linear credential — set LINEAR_API_KEY or run `linear auth login`.');
  return token;
}

/** POST one query. The token is sent BARE, not as `Bearer` — `linear auth login` mints a personal API
 *  key, which Linear authorizes unprefixed. (If the CLI ever moves to OAuth, this becomes `Bearer`.) */
async function postGraphql(token: string, body: { query: string; variables: Record<string, unknown> }): Promise<unknown> {
  // Node's global fetch has NO default timeout: a stalled connection (proxy black-hole, TCP drop with
  // no RST) would hang a watch poll forever. That is the same "a hung watcher is worse than a crash"
  // failure the cursor and page-count guards exist to prevent — and it is the likeliest of the three.
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Linear puts the actionable reason (bad key, missing scope) in the BODY. Throwing on the status
    // line alone turns a fixable auth problem into a bare "401 Unauthorized" on every watch poll.
    const detail = await res.text().catch(() => '');
    throw new VanguardError(`Linear API request failed: ${res.status} ${res.statusText}${detail === '' ? '' : ` — ${detail.slice(0, 300)}`}`);
  }
  return res.json();
}

/** Per-request wall clock. Generous — this is a hang guard, not a latency budget. */
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
/** Backstop only — not a work-queue cap. Real teams are far under this; see the loop in list(). */
const MAX_PAGES = 100;

/** One page of the issue list. `state { type }` is what TaskFilter.state selects on. */
const LIST_QUERY = `query($f: IssueFilter, $after: String, $first: Int!) {
  issues(first: $first, after: $after, filter: $f) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description state { name type } labels { nodes { name } } }
  }
}`;

/** Labels for ONE issue; `issue(id:)` accepts the human identifier (`TES-1`) as well as the UUID. */
const LABELS_QUERY = `query($id: String!) {
  issue(id: $id) { labels { nodes { name } } }
}`;

interface LabelsResponse {
  data?: { issue?: { labels?: LinearCliIssue['labels'] } | null };
  errors?: { message?: string }[];
}

interface IssuePage {
  data?: { issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: LinearCliIssue[] } };
  errors?: { message?: string }[];
}

/**
 * A GraphQL sender with the credential already resolved. One place resolves the Linear token, so
 * `create.ts` cannot drift into a second credential path.
 */
export async function linearGraphql(runner?: LinearCliRunner): Promise<LinearGraphql> {
  const token = await linearToken(runner ?? defaultRunner);
  return (body) => postGraphql(token, body);
}

export interface LinearCliOptions {
  team?: string;
  linear?: LinearCliRunner;
  graphql?: LinearGraphql;
}

/** Fetches Linear issues via the `linear` CLI (lighter than the SDK; needs `linear auth login` or LINEAR_API_KEY). */
export class LinearCliTaskFetcher implements TaskFetcher {
  constructor(private readonly options: LinearCliOptions = {}) {}

  private get run(): LinearCliRunner {
    return this.options.linear ?? defaultRunner;
  }

  /**
   * `issue view <id> --json` (includes the description) plus the issue's labels over GraphQL, which
   * `view` does not return. Labels drive routing (`vanguard:model=<m>`), so they are fetched for real;
   * a failed label query degrades to `labels: []` rather than failing the run — the view already
   * proved the issue exists, and label-less is how fetch() always behaved before.
   */
  async fetch(id: string): Promise<Task> {
    const issue = JSON.parse(await this.run(['issue', 'view', id, '--json'])) as LinearCliIssue;
    if (issue.identifier === undefined && issue.id === undefined) {
      throw new VanguardError(`Linear issue not found: ${id}`);
    }
    const labels = issue.labels ?? (await this.fetchLabels(issue.identifier ?? issue.id ?? id));
    return toTask({ ...issue, ...(labels !== undefined ? { labels } : {}) });
  }

  private async fetchLabels(id: string): Promise<LinearCliIssue['labels'] | undefined> {
    try {
      const send = await this.sender();
      const res = (await send({ query: LABELS_QUERY, variables: { id } })) as LabelsResponse;
      return res.data?.issue?.labels;
    } catch {
      return undefined;
    }
  }

  /**
   * A sender with the credential already resolved. Called ONCE per list(), not per page: with
   * LINEAR_API_KEY unset (the desktop path) `linearToken` shells `linear auth token`, so resolving
   * inside the pagination loop would spawn one subprocess per page, on every watch poll.
   */
  private async sender(): Promise<LinearGraphql> {
    return this.options.graphql ?? (await linearGraphql(this.options.linear));
  }

  /**
   * All issues matching the filter, over Linear's GraphQL API.
   *
   * NOT the `linear` CLI: it has no machine-readable issue list (schpet v1.11.1 has no `issue query`
   * at all, and `issue list` has no `--json`), and which flags exist varies by CLI version. The API
   * does not. This method used to shell `issue query` — a command that does not exist — which broke
   * `vanguard watch --linear` on every poll while the unit tests, all using a fake runner, stayed green.
   *
   * `filter.state` is a Linear state TYPE (triage/backlog/unstarted/started/completed/canceled) and
   * MUST reach the query: without it a watcher polls every issue in the team and would claim ones that
   * are already completed. Pagination runs to exhaustion for the same reason — a watcher that silently
   * caps its work queue is a bug, not a limit.
   */
  async list(filter?: TaskFilter): Promise<Task[]> {
    const issueFilter: Record<string, unknown> = {};
    if (this.options.team !== undefined) issueFilter['team'] = { key: { eq: this.options.team } };
    if (filter?.state !== undefined) issueFilter['state'] = { type: { eq: filter.state } };

    const send = await this.sender(); // credential resolved once, not per page
    const issues: LinearCliIssue[] = [];
    let after: string | undefined;
    // filter.limit (S9, board): cap `first:` and stop after enough issues — the board wants ONE
    // page (its cap banner covers the rest), and paginating a big team to exhaustion can bust the
    // sidecar query pipe's 60s watchdog. Unset ⇒ exhaustive, exactly as before (watch's contract).
    const pageSize = filter?.limit !== undefined ? Math.min(filter.limit, PAGE_SIZE) : PAGE_SIZE;
    for (let page = 0; ; page++) {
      // "Exhaust the pages" still assumes a finite, well-behaved server. A `hasNextPage: true` with a
      // cursor that never advances (server bug, proxy, hostile response) would spin here forever and
      // grow `issues` without bound — a hung watcher is strictly worse than the crash this replaced,
      // and removing the old --limit took away the accidental backstop. Fail loudly instead.
      if (page >= MAX_PAGES) {
        throw new VanguardError(`Linear list exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE}+ issues) — refusing to page further.`);
      }
      const response = (await send({
        query: LIST_QUERY,
        variables: { f: issueFilter, first: pageSize, ...(after !== undefined ? { after } : {}) },
      })) as IssuePage;
      // A GraphQL error arrives with HTTP 200 and no `data`. Returning [] here would be indistinguishable
      // from "no work to do" — the watcher would idle forever against a broken query.
      const errors = response.errors;
      if (errors !== undefined && errors.length > 0) {
        throw new VanguardError(`Linear API error: ${errors.map((e) => e.message ?? '').join('; ')}`);
      }
      const connection = response.data?.issues;
      // Valid JSON, no `errors`, but no issue connection either (`{"data":{"issues":null}}`, or a proxy
      // returning well-formed-but-wrong JSON). Falling through would `break` and return [] — again
      // indistinguishable from "no work to do", idling the watcher forever. That is the failure mode
      // this whole change exists to kill, so it must not survive in the malformed-SUCCESS case either.
      if (connection === undefined || connection === null) {
        throw new VanguardError('Linear API returned no issue connection — refusing to report an empty list.');
      }
      issues.push(...(connection.nodes ?? []));
      if (filter?.limit !== undefined && issues.length >= filter.limit) break; // board cap — one page
      const next = connection.pageInfo;
      if (next?.hasNextPage !== true || next.endCursor === null || next.endCursor === undefined) break;
      // The cursor must ADVANCE. `hasNextPage: true` with a repeating cursor is the infinite loop.
      if (next.endCursor === after) {
        throw new VanguardError('Linear pagination cursor did not advance — refusing to loop forever.');
      }
      after = next.endCursor;
    }

    const tasks = issues.map(toTask);
    const wanted = filter?.labels;
    if (wanted !== undefined && wanted.length > 0) {
      return tasks.filter((task) => wanted.some((label) => task.labels.includes(label)));
    }
    return tasks;
  }
}

/** Move a Linear issue to a workflow state (by name or type), e.g. to claim it ("In Progress"). */
export async function setLinearState(issueId: string, state: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await runner(['issue', 'update', issueId, '--state', state]);
}

/** Add a freeform comment to a Linear issue (e.g. to report a failed run). */
export async function commentLinearIssue(issueId: string, body: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await runner(['issue', 'comment', 'add', issueId, '--body', body]);
}

/** Comment a PR link back onto a Linear issue via the CLI (closes the loop). */
export async function linkLinearIssue(issueId: string, prUrl: string, runner: LinearCliRunner = defaultRunner): Promise<void> {
  await commentLinearIssue(issueId, `Vanguard opened a PR for review: ${prUrl}`, runner);
}
