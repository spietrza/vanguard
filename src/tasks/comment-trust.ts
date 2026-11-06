import type { Task, TaskComment } from './fetcher.js';

/** GitHub CommentAuthorAssociation values that imply write-ish standing in the repo. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface TrustOptions {
  /** Issue/PR author login (Task.author). Trusted for spec/tech-spec/manifest inputs. */
  issueAuthor?: string | undefined;
  /** Explicit allowlist (--feedback-authors; the workflow's allowed-actors). Case-insensitive. */
  allowedAuthors?: readonly string[] | undefined;
  /** Extra bot logins, as ActionableOptions.botLogins today. */
  botLogins?: readonly string[] | undefined;
}

export type AuthorTrust = 'association' | 'allowed' | 'issue-author' | 'bot' | 'no-association' | 'untrusted';

/**
 * Bot recognition for *granting* trust: exact logins only. An outsider can pick a username such as
 * `mallory-vanguard`, so the substring match of isBotLogin must never make a comment authoritative.
 */
function isTrustedBotLogin(login: string, extraBotLogins?: readonly string[]): boolean {
  const lower = login.toLowerCase();
  return (
    lower === 'vanguard' ||
    lower.endsWith('[bot]') ||
    lower === 'github-actions' ||
    (extraBotLogins ?? []).some((b) => lower === b.toLowerCase())
  );
}

/**
 * Shared bot recognition for *excluding* automation from human feedback: isTrustedBotLogin widened to
 * a substring match, so `vanguard-ci` and friends never land in the maintainer-notes/actionable sets.
 * Deliberately wide — excluding a human by accident costs a missed comment, not a trust boundary.
 */
export function isBotLogin(login: string, extraBotLogins?: readonly string[]): boolean {
  return login.toLowerCase().includes('vanguard') || isTrustedBotLogin(login, extraBotLogins);
}

/**
 * Bot check first (so Vanguard's own comments classify as 'bot', never 'association'). The built-in
 * names are GitHub logins: on a provider with no association model (GitLab) anyone can register
 * `vanguard` or `github-actions`, so there only the operator's explicit botLogins count.
 */
export function classifyAuthor(author: string, association: string | undefined, opts: TrustOptions = {}): AuthorTrust {
  const isBot =
    association === undefined
      ? (opts.botLogins ?? []).some((b) => b.toLowerCase() === author.toLowerCase())
      : isTrustedBotLogin(author, opts.botLogins);
  if (isBot) return 'bot';
  const lowerAuthor = author.toLowerCase();
  if ((opts.allowedAuthors ?? []).some((a) => a.toLowerCase() === lowerAuthor)) return 'allowed';
  if (association !== undefined && TRUSTED_ASSOCIATIONS.has(association.trim().toUpperCase())) return 'association';
  if (opts.issueAuthor !== undefined && opts.issueAuthor.toLowerCase() === lowerAuthor) return 'issue-author';
  // An absent association means the provider models none at all (GitLab notes). With no identity
  // signal configured there is nothing to fail closed on, so those providers keep their pre-gate
  // behaviour. Once the operator names trusted logins (allowlist or bot logins), an unlisted author
  // fails closed, or the allowlist would not be a boundary. Vanguard's own GitLab notes stay trusted
  // because the fetcher stamps the glab user's notes. A *supplied* association, '' included, is a
  // real signal and fails closed.
  if (association === undefined) {
    const hasIdentitySignal = (opts.allowedAuthors ?? []).length > 0 || (opts.botLogins ?? []).length > 0;
    return hasIdentitySignal ? 'untrusted' : 'no-association';
  }
  return 'untrusted';
}

/** true for every classification except 'untrusted' — i.e. the SPEC/marker trust set (bot included). */
export function isTrustedComment(comment: TaskComment, opts: TrustOptions = {}): boolean {
  return classifyAuthor(comment.author, comment.authorAssociation, opts) !== 'untrusted';
}

/**
 * isTrustedComment without issue-author trust: the reporter controls the description those gates
 * already read, but must not be able to *suppress* work (e.g. skip spec generation) by posting a
 * forged `<tech_spec>`. Bot / association / allowlist trust still count.
 */
export function isTrustedNonAuthorComment(comment: TaskComment, opts: TrustOptions = {}): boolean {
  return isTrustedComment(comment, { ...opts, issueAuthor: undefined });
}

/** task.comments filtered by isTrustedComment; issueAuthor defaults to task.author. */
export function trustedComments(task: Task, opts: TrustOptions = {}): TaskComment[] {
  const trust: TrustOptions = { ...opts, issueAuthor: opts.issueAuthor ?? task.author };
  return task.comments.filter((comment) => isTrustedComment(comment, trust));
}

/** Bodies of trustedComments joined with '\n' — the replacement for the ad-hoc joins. */
export function trustedSpecText(task: Task, opts: TrustOptions = {}): string {
  return trustedComments(task, opts).map((comment) => comment.body).join('\n');
}

/** Short render for summaries/logs: `@mallory (NONE)`; association '' renders as `(none)`. */
export function describeIgnoredAuthor(author: string, association?: string): string {
  const label = association === undefined || association === '' ? 'none' : association;
  return `@${author} (${label})`;
}
