import { execa } from 'execa';
import type { Task, TaskComment, TaskFetcher, TaskFilter } from './fetcher.js';
import { redactForPublish } from '../core/secret-scan.js';

export interface GitLabNote {
  id: number;
  body: string;
  author: { username: string };
  system: boolean;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  /** glab always includes it; carried for the board (S9). */
  state?: string;
  author?: { username: string };
}

/** Runs a `glab` subcommand and returns its stdout. Injected so unit tests never call real glab. */
export type GlabRunner = (args: string[]) => Promise<string>;

export const defaultGlabRunner: GlabRunner = async (args: string[]): Promise<string> =>
  (await execa('glab', args)).stdout;

/** Strips an optional `group/project#` prefix, returning just the numeric IID part. */
export function issueIID(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(hash + 1);
}

/** URL-encodes a GitLab project path for use in `glab api` calls (slashes → %2F). */
export function encodeProject(project: string): string {
  return project.replace(/\//g, '%2F');
}

// The glab user is constant for the process, and watch loops read it on every poll. A failed
// lookup is dropped from the cache so the next call retries it.
const glabUsers = new WeakMap<GlabRunner, Promise<string>>();

/** The username glab is authenticated as (GET /user), cached per runner. Throws when it cannot be read. */
export function glabUser(glab: GlabRunner): Promise<string> {
  const cached = glabUsers.get(glab);
  if (cached !== undefined) return cached;
  const user = glab(['api', 'user'])
    .then((out) => {
      const name = (JSON.parse(out) as { username?: string }).username;
      if (name === undefined || name === '') throw new Error('it returned no username');
      return name;
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read the glab user; the token must be able to read GET /user (${detail})`, { cause: error });
    });
  glabUsers.set(glab, user);
  user.catch(() => glabUsers.delete(glab));
  return user;
}

/**
 * GitLab notes carry no association. A note by the user glab runs as (Vanguard's own spec, research
 * and manifest notes) is stamped MEMBER, so it stays trusted when --feedback-authors makes every other
 * association-less note fail closed. Everyone else keeps an absent association (see classifyAuthor).
 */
function toGitLabTask(project: string, issue: GitLabIssue, notes: GitLabNote[] = [], self?: string): Task {
  const selfLower = self?.toLowerCase();
  const comments: TaskComment[] = notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: n.author.username,
      body: n.body,
      ...(selfLower !== undefined && n.author.username.toLowerCase() === selfLower ? { authorAssociation: 'MEMBER' } : {}),
    }));
  return {
    id: `${project}#${issue.iid}`,
    title: issue.title,
    description: issue.description ?? '',
    labels: issue.labels,
    children: [],
    comments,
    ref: String(issue.iid),
    ...(issue.state !== undefined ? { state: issue.state } : {}),
    ...(issue.author?.username !== undefined ? { author: issue.author.username } : {}),
  };
}

/** Fetches GitLab issues (via the glab CLI) and maps them to Vanguard tasks. */
export class GitLabTaskFetcher implements TaskFetcher {
  constructor(
    private readonly project: string,
    private readonly glab: GlabRunner = defaultGlabRunner,
  ) {}

  async fetch(id: string): Promise<Task> {
    const iid = issueIID(id);
    const issueOut = await this.glab(['issue', 'view', iid, '--repo', this.project, '--output', 'json']);
    const issue = JSON.parse(issueOut) as GitLabIssue;
    // notes fetched separately — glab issue view does not include them
    const notesOut = await this.glab(['api', `projects/${encodeProject(this.project)}/issues/${iid}/notes?per_page=100`]);
    const notes = JSON.parse(notesOut) as GitLabNote[];
    return toGitLabTask(this.project, issue, notes, await this.self(notes));
  }

  /** The glab user, looked up only when there are notes to attribute. A failed lookup leaves every note unstamped (fails closed under an allowlist). */
  private async self(notes: GitLabNote[]): Promise<string | undefined> {
    if (!notes.some((n) => !n.system)) return undefined;
    try {
      return await glabUser(this.glab);
    } catch (error) {
      console.warn(`vanguard: ${error instanceof Error ? error.message : String(error)}; Vanguard's own notes on ${this.project} are not recognised`);
      return undefined;
    }
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    const args = [
      'issue', 'list',
      '--repo', this.project,
      '--output', 'json',
    ];
    // glab has no `--state <value>` flag: opened is the default, closed/all are booleans.
    const state = filter?.state ?? 'opened';
    if (state === 'closed') args.push('--closed');
    else if (state === 'all') args.push('--all');
    if (filter?.limit !== undefined) args.push('-P', String(filter.limit)); // conditional — see TaskFilter.limit
    for (const label of filter?.labels ?? []) args.push('--label', label);
    const out = await this.glab(args);
    // comments are not fetched on bulk list() — avoids N+1; only fetch() returns them
    return (JSON.parse(out) as GitLabIssue[]).map((issue) => toGitLabTask(this.project, issue));
  }
}

/**
 * Keep GitLab from running quick actions in text the bot posts. A note or description created through the
 * API runs each line that starts with `/` and a command name (`/merge`, `/approve`, `/label ~x`) as the
 * posting user, and bot text quotes MR, issue and agent content. A backslash before the slash stops that and
 * renders as nothing outside code. Every command name starts with a letter, so `//` and `/**` lines in quoted
 * code stay as they are. Leading spaces and tabs are covered too, although GitLab only matches a `/` at the
 * very start of a line.
 */
export function neutralizeQuickActions(text: string): string {
  return text.replace(/^([ \t]*)\/(?=[a-z])/gim, '$1\\/');
}

/** Post a note on a GitLab issue. */
export async function commentGitlabIssue(
  project: string,
  issueRef: string,
  body: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await glab(['issue', 'note', 'create', issueIID(issueRef), '--repo', project, '-m', neutralizeQuickActions(redactForPublish(body))]);
}

/** Comment an MR link back onto the source GitLab issue (closes the loop). */
export async function linkMergeRequest(
  project: string,
  issueRef: string,
  mrUrl: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  await commentGitlabIssue(project, issueRef, `Vanguard opened an MR for review: ${mrUrl}`, glab);
}

/**
 * Best-effort: ensure the scoped label exists on the project, then add it to a GitLab MR
 * (used to flag failed proofs for triage). Without the pre-create, `glab mr update --label`
 * is a silent no-op on a project lacking the label (matching GitHub's `gh label create --force`
 * pre-step). Both steps swallow errors — labeling a draft MR must never block the run.
 */
export async function addMrFailureLabel(
  project: string,
  iid: number,
  label: string,
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  try {
    await glab(['label', 'create', '--repo', project, '--name', label]);
  } catch { /* best-effort */ }
  try {
    await glab(['mr', 'update', String(iid), '--repo', project, '--label', label]);
  } catch { /* best-effort */ }
}

/** Add/remove labels on a GitLab issue (used to claim/advance it in the watch loop). */
export async function editGitlabLabels(
  project: string,
  issueRef: string,
  labels: { add?: string[]; remove?: string[] },
  glab: GlabRunner = defaultGlabRunner,
): Promise<void> {
  const args = ['issue', 'update', issueIID(issueRef), '--repo', project];
  for (const label of labels.add ?? []) args.push('--label', label);
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  if (args.length > 5) await glab(args);
}
