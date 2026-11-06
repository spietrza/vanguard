import { escapePromptTags } from '../context/escape.js';
import { trustedComments } from './comment-trust.js';
import type { TrustOptions } from './comment-trust.js';

/** A child (sub-issue) of a task; identifier and title only (sub-issues carry no body in list shape). */
export interface SubTask {
  id: string;
  title: string;
}

export interface TaskComment {
  author: string;
  body: string;
  /** Provider's author association, upper-case (GitHub CommentAuthorAssociation). Absent ⇒ the provider models none (GitLab). */
  authorAssociation?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  labels: string[];
  children: SubTask[];
  comments: TaskComment[];
  /** Provider-native short ref (`904`, `42`, `DEV-639`) — the board id mint's input (S9). Never in prompts. */
  ref?: string;
  /** Provider lifecycle state (`open`/`closed`/`opened`/Linear state name) — the board's column input (S9). */
  state?: string;
  /** Issue/PR author login (GitHub `author.login`, GitLab `author.username`). Absent ⇒ no issue-author trust. */
  author?: string;
}

export interface TaskFilter {
  labels?: string[];
  state?: string;
  /**
   * Page/result cap (S9, board parity). STRICTLY conditional: unset ⇒ gh/glab argv is
   * byte-identical to before this field existed, and Linear keeps first:100 + exhaustive
   * pagination (behavior-identical; the query wire now passes `first` as a variable) — watch
   * never sets it, and its fetch size must not change. Set ⇒ gh -L / glab -P / Linear single page.
   */
  limit?: number;
}

/**
 * Source of work items. Impl: LinearCliTaskFetcher (the `linear` CLI; auth via
 * `linear auth login` or LINEAR_API_KEY) mapping an issue to prompt variables via taskToVariables().
 */
export interface TaskFetcher {
  fetch: (id: string) => Promise<Task>;
  list: (filter?: TaskFilter) => Promise<Task[]>;
}

/**
 * One comment as a delimited block. The author comes from the fetched login, escaped (quotes too), and
 * the body is escaped, so a body cannot close the block or forge another author's comment.
 */
function renderComment(comment: TaskComment): string {
  const author = escapePromptTags(comment.author).replaceAll('"', '&quot;');
  return `<comment author="${author}">\n${escapePromptTags(comment.body)}\n</comment>`;
}

/**
 * Map a fetched task to prompt-engine {{KEY}} variables. COMMENTS carries only trustedComments (repo
 * members, the issue author, `trust.allowedAuthors`, Vanguard's bot): an outsider's comment never
 * reaches the agent prompt.
 */
export function taskToVariables(task: Task, trust: TrustOptions = {}): Record<string, string> {
  return {
    TITLE: escapePromptTags(task.title),
    DESCRIPTION: escapePromptTags(task.description),
    LABELS: task.labels.map((label) => escapePromptTags(label)).join(', '),
    SUBTASKS: task.children.map((child) => escapePromptTags(`${child.id} ${child.title}`)).join('\n'),
    COMMENTS: trustedComments(task, trust).map(renderComment).join('\n'),
  };
}
