import { execa } from 'execa';
import { classifyAuthor } from './comment-trust.js';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';

export interface GitHubLabel {
  name: string;
}

export interface GitHubCommentAuthor {
  login: string;
}

export interface GitHubComment {
  author: GitHubCommentAuthor | null; // gh returns null for deleted accounts; justifies optional chaining in toTask()
  body: string;
  createdAt: string;
  /** GitHub CommentAuthorAssociation (e.g. OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/NONE). */
  authorAssociation?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: GitHubLabel[];
  comments?: GitHubComment[];
  /** Present only when list() requests it (S9 board). */
  state?: string;
  /** Issue author; added to fetch()'s --json field list (never on list(), which fetches no comments either). */
  author?: GitHubCommentAuthor | null;
}

/**
 * Runs a `gh` subcommand and returns its stdout. Injected so unit tests never call real gh.
 * `env` is merged over the process env for this one call (e.g. a one-off GH_TOKEN override).
 */
export type GhRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

export const defaultGhRunner: GhRunner = async (args, env): Promise<string> =>
  (await execa('gh', args, env !== undefined ? { env } : {})).stdout;

/** Strips an optional `owner/repo#` prefix, returning just the numeric part. */
export function issueNumber(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

export function toTask(repo: string, issue: GitHubIssue): Task {
  const comments: TaskComment[] = (issue.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? '',
    body: comment.body ?? '',
    // GitHub models an association on every comment and gh returns it on `issue view --json comments`,
    // so a missing one is mapped to '' and fails closed (see classifyAuthor). Only providers that model
    // none at all (GitLab) keep the absent-means-no-signal path.
    authorAssociation: comment.authorAssociation ?? '',
  }));
  // A future gh that drops the field would turn every non-bot comment untrusted: say it out loud.
  if (comments.length > 0 && (issue.comments ?? []).every((c) => c.authorAssociation === undefined)) {
    console.warn(`vanguard: ${repo}#${issue.number} — gh returned no authorAssociation on any comment; non-bot comments are treated as untrusted`);
  }
  return {
    id: `${repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: issue.labels.map((label) => label.name),
    children: [], // the gh issue mapping does not fetch sub-issues
    comments,
    ref: String(issue.number),
    ...(issue.state !== undefined ? { state: issue.state } : {}),
    ...(issue.author?.login !== undefined ? { author: issue.author.login } : {}),
  };
}

/**
 * Whether the author of issue or PR `number` is trusted to start work: OWNER/MEMBER/COLLABORATOR, an
 * allowlisted login (--feedback-authors) or a GitHub App bot. `gh issue/pr --json` exposes no author
 * association, so this reads the REST issue (PRs are issues there). A failed lookup fails closed.
 */
export async function isTrustedIssueAuthor(
  repo: string,
  number: number | string,
  allowedAuthors: readonly string[] | undefined,
  gh: GhRunner = defaultGhRunner,
): Promise<{ trusted: boolean; author: string; association: string }> {
  try {
    const issue = JSON.parse(await gh(['api', `repos/${repo}/issues/${issueNumber(String(number))}`])) as {
      user?: { login?: string } | null;
      author_association?: string;
    };
    const author = issue.user?.login ?? '';
    const association = issue.author_association ?? '';
    const trusted = author !== '' && classifyAuthor(author, association, { allowedAuthors }) !== 'untrusted';
    return { trusted, author, association };
  } catch {
    return { trusted: false, author: '', association: '' };
  }
}

/** Fetches GitHub issues (via the gh CLI) and maps them to Vanguard tasks. */
export class GitHubTaskFetcher implements TaskFetcher {
  constructor(
    private readonly repo: string,
    private readonly gh: GhRunner = defaultGhRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const number = issueNumber(id);
    const out = await this.gh(['issue', 'view', number, '--repo', this.repo, '--json', 'number,title,body,labels,comments,author']);
    return toTask(this.repo, JSON.parse(out) as GitHubIssue);
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    // comments are not fetched on bulk list() (avoids N+1); only fetch() returns them.
    // `state` joins --json ONLY when a limit is set (the board call): keeping the unset-limit argv
    // byte-identical protects watch's fetch shape (S9 — conditional by contract, test-pinned).
    const fields = filter?.limit !== undefined ? 'number,title,body,labels,state' : 'number,title,body,labels';
    const args = ['issue', 'list', '--repo', this.repo, '--json', fields, '--state', filter?.state ?? 'open'];
    if (filter?.limit !== undefined) args.push('-L', String(filter.limit));
    if (filter?.labels !== undefined && filter.labels.length > 0) args.push('--label', filter.labels.join(','));
    const out = await this.gh(args);
    return (JSON.parse(out) as GitHubIssue[]).map((issue) => toTask(this.repo, issue));
  }
}

/** Comment a PR link back onto the source GitHub issue (closes the loop). */
export async function commentGithubIssue(
  repo: string,
  issueRef: string,
  body: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await gh(['issue', 'comment', issueNumber(issueRef), '--repo', repo, '--body', body]);
}

export async function linkPullRequest(
  repo: string,
  issueRef: string,
  prUrl: string,
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  await commentGithubIssue(repo, issueRef, `Vanguard opened a PR for review: ${prUrl}`, gh);
}

/**
 * Best-effort: ensure a label exists and add it to a PR (used to flag failed proofs for triage).
 * Both steps swallow errors — labeling a draft PR must never block the run.
 */
export async function addPrFailureLabel(repoPath: string, prUrl: string, label: string): Promise<void> {
  try {
    await execa('gh', ['label', 'create', label, '--force'], { cwd: repoPath });
  } catch { /* best-effort */ }
  try {
    await execa('gh', ['pr', 'edit', prUrl, '--add-label', label], { cwd: repoPath });
  } catch { /* best-effort */ }
}

/** Add/remove labels on a GitHub issue (used to claim/advance it in the watch loop). */
export async function editGithubLabels(
  repo: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  gh: GhRunner = defaultGhRunner,
): Promise<void> {
  const args = ['issue', 'edit', issueNumber(issueRef), '--repo', repo];
  for (const label of labels.add ?? []) args.push('--add-label', label);
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  if (args.length > 4) await gh(args);
}
