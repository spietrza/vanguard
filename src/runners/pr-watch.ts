import { fanOut } from '../pipeline/fan-out.js';
import { failureReason } from '../core/errors.js';
import { hasPullRequestReviewMarker } from './pr-review.js';
import { defaultGhRunner, isTrustedIssueAuthor } from '../tasks/github.js';
import { classifyAuthor, describeIgnoredAuthor, isBotLogin } from '../tasks/comment-trust.js';
import type { GhRunner } from '../tasks/github.js';

export interface PullRequestWatchItem {
  repoSlug: string;
  number: number;
  title: string;
  isDraft: boolean;
  author: string;
  headRefOid: string;
  labels: string[];
}

export interface PullRequestWatchPrimitives {
  listReady: () => Promise<PullRequestWatchItem[]>;
  claim: (item: PullRequestWatchItem) => Promise<void>;
  review: (item: PullRequestWatchItem) => Promise<void>;
  markReviewed: (item: PullRequestWatchItem) => Promise<void>;
  onFailure: (item: PullRequestWatchItem, error: unknown) => Promise<void>;
}

export interface PullRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchPullRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchPullRequestsLoopOptions extends WatchPullRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitHubPullRequestWatchOptions {
  repoSlug: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  /** Only review PRs opened by this GitHub login (self-review-only when set). */
  author?: string;
  /**
   * PR number named by the triggering label event (or --pr). The label-filtered list is
   * search-backed and eventually consistent, so a just-labeled PR can be missing from the scan;
   * this PR is fetched directly and reviewed even when its head already carries a review marker —
   * the label was deliberately (re-)added.
   */
  hintPr?: number;
  /**
   * Extra PR-author logins trusted beyond OWNER/MEMBER/COLLABORATOR (--feedback-authors; the workflow's
   * allowed-actors). A PR by anyone else is skipped, as the label-triggered path's author gate does.
   */
  allowedAuthors?: readonly string[];
  log?: (line: string) => void;
  gh?: GhRunner;
  reviewOne: (item: PullRequestWatchItem) => Promise<void>;
}

interface GhPullRequestListItem {
  number?: number;
  title?: string;
  isDraft?: boolean;
  author?: { login?: string } | string | null;
  headRefOid?: string;
  labels?: Array<{ name?: string } | string>;
}

interface GhPullRequestReviewBody {
  body?: string | null;
  author?: { login?: string } | null;
  authorAssociation?: string;
}

interface GhPullRequestReviewView {
  comments?: GhPullRequestReviewBody[];
  reviews?: GhPullRequestReviewBody[];
}

type PullRequestWatchKind = 'reviewed' | 'failed' | 'skipped';

function prId(item: PullRequestWatchItem): string {
  return `${item.repoSlug}#${item.number}`;
}

function labelNames(labels: GhPullRequestListItem['labels']): string[] {
  return (labels ?? []).flatMap((label) => {
    if (typeof label === 'string') return [label];
    return typeof label.name === 'string' ? [label.name] : [];
  });
}

function authorLogin(author: GhPullRequestListItem['author']): string {
  if (typeof author === 'string') return author;
  return author?.login ?? '';
}

function eligiblePullRequests(
  parsed: GhPullRequestListItem[],
  repoSlug: string,
  triggerLabel: string,
  onlyAuthor?: string,
): PullRequestWatchItem[] {
  return parsed.flatMap((item) => {
    if (item.number === undefined) return [];
    const labels = labelNames(item.labels);
    const author = authorLogin(item.author);
    const pr: PullRequestWatchItem = {
      repoSlug,
      number: item.number,
      title: item.title ?? '',
      isDraft: item.isDraft === true,
      author,
      headRefOid: item.headRefOid ?? '',
      labels,
    };
    if (pr.isDraft) return [];
    if (isBotLogin(author)) return [];
    if (onlyAuthor !== undefined && author !== onlyAuthor) return [];
    if (!labels.includes(triggerLabel)) return [];
    return [pr];
  });
}

function editPullRequestLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['pr', 'edit', String(number), '--repo', repoSlug];
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  for (const label of labels.add ?? []) args.push('--add-label', label);
  return gh(args);
}

interface GhPullRequestViewItem extends GhPullRequestListItem {
  state?: string;
}

/** Fetch the event-named PR directly — `gh pr view` is not subject to the label-search index lag. */
async function fetchHintedPullRequest(
  gh: GhRunner,
  opts: GitHubPullRequestWatchOptions,
  number: number,
): Promise<PullRequestWatchItem | undefined> {
  const id = `${opts.repoSlug}#${number}`;
  let view: GhPullRequestViewItem;
  try {
    view = JSON.parse(
      await gh(['pr', 'view', String(number), '--repo', opts.repoSlug, '--json', 'number,title,isDraft,author,headRefOid,labels,state']),
    ) as GhPullRequestViewItem;
  } catch (error) {
    opts.log?.(`watch-prs ${id}: hint fetch failed -> ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (view.state !== undefined && view.state !== 'OPEN') {
    opts.log?.(`watch-prs ${id}: hint skip -> state ${view.state}`);
    return undefined;
  }
  const [item] = eligiblePullRequests([view], opts.repoSlug, opts.label, opts.author);
  if (item === undefined) {
    opts.log?.(`watch-prs ${id}: hint skip -> draft, automation author, or missing "${opts.label}" label`);
    return undefined;
  }
  return item;
}

async function hasExistingReviewForHead(gh: GhRunner, item: PullRequestWatchItem, allowedAuthors?: readonly string[]): Promise<boolean> {
  if (item.headRefOid === '') return false;
  try {
    const out = await gh(['pr', 'view', String(item.number), '--repo', item.repoSlug, '--json', 'comments,reviews']);
    const view = JSON.parse(out) as GhPullRequestReviewView;
    // Only a trusted author's marker counts: anyone can post the marker text to suppress a review.
    return [...(view.comments ?? []), ...(view.reviews ?? [])].some(
      (entry) =>
        classifyAuthor(entry.author?.login ?? '', entry.authorAssociation ?? '', { allowedAuthors }) !== 'untrusted' &&
        hasPullRequestReviewMarker(entry.body ?? '', item.headRefOid),
    );
  } catch {
    return false;
  }
}

/**
 * GitHub-backed PR review watch primitives. Label state is the dedup mechanism: a PR leaves the
 * trigger label before review starts, so the same head commit is not reviewed again unless a human or
 * automation deliberately re-adds the trigger label.
 */
export function githubPullRequestWatchPrimitives(opts: GitHubPullRequestWatchOptions): PullRequestWatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  return {
    listReady: async () => {
      const listArgs = [
        'pr',
        'list',
        '--repo',
        opts.repoSlug,
        '--state',
        'open',
        '--label',
        opts.label,
        ...(opts.author !== undefined ? ['--author', opts.author] : []),
        '--limit',
        '100',
        '--json',
        'number,title,isDraft,author,headRefOid,labels',
      ];
      const candidates = eligiblePullRequests(
        JSON.parse(await gh(listArgs)) as GhPullRequestListItem[],
        opts.repoSlug,
        opts.label,
        opts.author,
      );
      if (opts.hintPr !== undefined && !candidates.some((item) => item.number === opts.hintPr)) {
        const hinted = await fetchHintedPullRequest(gh, opts, opts.hintPr);
        if (hinted !== undefined) candidates.push(hinted);
      }
      const authorGate = async (item: PullRequestWatchItem): Promise<PullRequestWatchItem | undefined> => {
        const author = await isTrustedIssueAuthor(item.repoSlug, item.number, opts.allowedAuthors, gh);
        if (author.trusted) return item;
        opts.log?.(`watch-prs ${prId(item)}: skip -> PR author ${describeIgnoredAuthor(author.author || item.author, author.association)} is not trusted`);
        return undefined;
      };
      const ready = await Promise.all(
        candidates.map(async (item): Promise<PullRequestWatchItem | undefined> => {
          // The hinted PR was deliberately (re-)labeled: review it even when this head has a verdict.
          if (item.number === opts.hintPr) return authorGate(item);
          if (await hasExistingReviewForHead(gh, item, opts.allowedAuthors)) {
            opts.log?.(`watch-prs ${prId(item)}: skip -> head ${item.headRefOid.slice(0, 7)} already reviewed`);
            return undefined;
          }
          return authorGate(item);
        }),
      );
      return ready.filter((item): item is PullRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.reviewingLabel],
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: (item) =>
      editPullRequestLabels(gh, item.repoSlug, item.number, {
        remove: [opts.reviewingLabel],
        add: [opts.label],
      }).then(() => {}),
  };
}

/** Run one PR-watch poll: list, claim, review, and mark each ready PR. */
export async function watchPullRequestsOnce(
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsOnceOptions = {},
): Promise<PullRequestWatchTick> {
  const phase = opts.phase ?? 'watch-prs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: PullRequestWatchKind }> => {
      const id = prId(item);
      try {
        await primitives.claim(item);
        opts.log?.(`${phase} ${id}: claim -> reviewing`);
      } catch {
        opts.log?.(`${phase} ${id}: skipped -> already claimed`);
        return { id, kind: 'skipped' };
      }

      try {
        await primitives.review(item);
        await primitives.markReviewed(item);
        opts.log?.(`${phase} ${id}: reviewed -> marked`);
        return { id, kind: 'reviewed' };
      } catch (error) {
        try {
          await primitives.onFailure(item, error);
        } catch (restoreError) {
          opts.log?.(`${phase} ${id}: restore failed -> manual label check (${failureReason(restoreError)})`);
        }
        opts.log?.(`${phase} ${id}: failed -> retry later (${failureReason(error)})`);
        return { id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: PullRequestWatchKind): string[] =>
    results.flatMap((outcome) => (outcome.status === 'fulfilled' && outcome.value.kind === kind ? [outcome.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // Detach on the timer path too, or a long-lived signal gains one listener per tick.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Poll GitHub PRs until stopped, running the PR review loop for each ready PR. Returns the last tick so `--once` callers can report failures truthfully. */
export async function watchPullRequests(
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsLoopOptions = {},
): Promise<PullRequestWatchTick | undefined> {
  const intervalMs = opts.intervalMs ?? 60_000;
  let last: PullRequestWatchTick | undefined;
  for (;;) {
    if (opts.signal?.aborted === true) return last;
    last = await watchPullRequestsOnce(primitives, opts);
    opts.log?.(`watch-prs: ${last.reviewed.length} reviewed, ${last.failed.length} failed, ${last.skipped.length} skipped.`);
    if (opts.once === true) return last;
    await delay(intervalMs, opts.signal);
  }
}
