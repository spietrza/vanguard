import { fanOut } from '../pipeline/fan-out.js';
import { failureReason } from '../core/errors.js';
import { defaultGlabRunner, neutralizeQuickActions } from '../tasks/gitlab.js';
import { MergeRequestReviewIncompleteError, hasMergeRequestReviewForHead } from './mr-review.js';
import { stripReviewMarkers } from './review-prompt.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import { redactForPublish } from '../core/secret-scan.js';

export interface MergeRequestWatchItem extends MergeRequestReviewTarget {
  title: string;
  draft: boolean;
  author: string;
  sha: string;
  labels: string[];
}

export interface MergeRequestWatchPrimitives {
  listReady: () => Promise<MergeRequestWatchItem[]>;
  claim: (item: MergeRequestWatchItem) => Promise<void>;
  review: (item: MergeRequestWatchItem) => Promise<void>;
  markReviewed: (item: MergeRequestWatchItem) => Promise<void>;
  onFailure: (item: MergeRequestWatchItem, error: unknown) => Promise<void>;
}

export interface MergeRequestWatchTick {
  reviewed: string[];
  failed: string[];
  skipped: string[];
}

export interface WatchMergeRequestsOnceOptions {
  concurrency?: number;
  log?: (line: string) => void;
  phase?: string;
}

export interface WatchMergeRequestsLoopOptions extends WatchMergeRequestsOnceOptions {
  intervalMs?: number;
  once?: boolean;
  signal?: AbortSignal;
}

export interface GitLabMergeRequestWatchOptions {
  project: string;
  label: string;
  reviewingLabel: string;
  reviewedLabel: string;
  /** Only review MRs opened by this GitLab username (optional). */
  author?: string;
  glab?: GlabRunner;
  log?: (line: string) => void;
  reviewOne: (item: MergeRequestWatchItem) => Promise<void>;
}

interface GlabMrListItem {
  iid?: number;
  title?: string;
  draft?: boolean;
  author?: { username?: string } | null;
  sha?: string;
  labels?: string[];
}

function mrId(item: MergeRequestWatchItem): string {
  return `${item.project}!${item.iid}`;
}

function isAutomationAuthor(username: string): boolean {
  const lower = username.toLowerCase();
  return lower.startsWith('vanguard') || lower.endsWith('[bot]') || lower === 'gitlab-ci-token';
}

function parseMrList(
  out: string,
  project: string,
  onlyAuthor?: string,
): MergeRequestWatchItem[] {
  const parsed = JSON.parse(out) as GlabMrListItem[];
  return parsed.flatMap((item) => {
    if (item.iid === undefined) return [];
    const author = item.author?.username ?? '';
    const mr: MergeRequestWatchItem = {
      project,
      iid: item.iid,
      title: item.title ?? '',
      draft: item.draft === true,
      author,
      sha: item.sha ?? '',
      labels: item.labels ?? [],
    };
    if (mr.draft) return [];
    if (isAutomationAuthor(author)) return [];
    if (onlyAuthor !== undefined && author !== onlyAuthor) return [];
    return [mr];
  });
}

function editMrLabels(
  glab: GlabRunner,
  project: string,
  iid: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['mr', 'update', String(iid), '--repo', project];
  for (const label of labels.remove ?? []) args.push('--unlabel', label);
  for (const label of labels.add ?? []) args.push('--label', label);
  return glab(args);
}

async function hasExistingReviewForHead(
  glab: GlabRunner,
  item: MergeRequestWatchItem,
  log?: (line: string) => void,
): Promise<boolean> {
  if (item.sha === '') {
    // glab mr list omitted sha — dedup disabled; MR may be re-reviewed on each poll
    log?.(`watch-mrs ${mrId(item)}: sha absent, dedup disabled`);
    return false;
  }
  try {
    return await hasMergeRequestReviewForHead(item, item.sha, glab);
  } catch (err) {
    // best-effort: transient failure → re-review rather than skip
    log?.(`watch-mrs ${mrId(item)}: dedup check failed (${String(err)}), will re-review`);
    return false;
  }
}

/**
 * GitLab-backed MR review watch primitives. Scoped labels (`vanguard::reviewing`,
 * `vanguard::reviewed`) replace each other automatically on the GitLab side.
 */
export function gitlabMergeRequestWatchPrimitives(
  opts: GitLabMergeRequestWatchOptions,
): MergeRequestWatchPrimitives {
  const glab = opts.glab ?? defaultGlabRunner;
  const log = opts.log;
  return {
    listReady: async () => {
      const listArgs = [
        'mr', 'list',
        '--repo', opts.project,
        '--state', 'opened',
        '--label', opts.label,
        '--output', 'json',
      ];
      if (opts.author !== undefined) listArgs.push('--author', opts.author);
      const candidates = parseMrList(await glab(listArgs), opts.project, opts.author);
      // glab mr list may omit sha; enrich from mr view so dedup works correctly.
      const enriched = await Promise.all(
        candidates.map(async (item): Promise<MergeRequestWatchItem> => {
          if (item.sha !== '') return item;
          try {
            const view = JSON.parse(
              await glab(['mr', 'view', String(item.iid), '--repo', opts.project, '--output', 'json']),
            ) as { sha?: string };
            return { ...item, sha: view.sha ?? '' };
          } catch {
            return item;
          }
        }),
      );
      const ready = await Promise.all(
        enriched.map(async (item): Promise<MergeRequestWatchItem | undefined> =>
          (await hasExistingReviewForHead(glab, item, log)) ? undefined : item,
        ),
      );
      return ready.filter((item): item is MergeRequestWatchItem => item !== undefined);
    },
    claim: (item) =>
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.label],
        add: [opts.reviewingLabel],
      }).then(() => {}),
    review: (item) => opts.reviewOne(item),
    markReviewed: (item) =>
      // Explicitly remove reviewingLabel for robustness when non-scoped labels are configured.
      editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        add: [opts.reviewedLabel],
      }).then(() => {}),
    onFailure: async (item, error) => {
      // An incomplete review (no verdict after two passes — output truncation or a genuinely oversized diff) would fail the same way on every
      // poll, at two agent runs each. Leave the trigger label off so it waits for a human to re-add it, but
      // only once the note that tells them so is posted; otherwise the MR would sit with no label and no note.
      let terminal = error instanceof MergeRequestReviewIncompleteError;
      try {
        await glab([
          'mr', 'note', 'create',
          String(item.iid),
          '--repo', item.project,
          // This note is written by the glab user, so a marker quoted in the error would count for the dedupe.
          '-m', neutralizeQuickActions(`Vanguard MR review failed: ${redactForPublish(stripReviewMarkers(String(error)))}${terminal ? ` Re-add the "${opts.label}" label to retry.` : ''}`),
        ]);
      } catch {
        // note posting is best-effort; always fix the labels
        terminal = false;
      }
      await editMrLabels(glab, item.project, item.iid, {
        remove: [opts.reviewingLabel],
        ...(terminal ? {} : { add: [opts.label] }),
      });
    },
  };
}

type MrWatchKind = 'reviewed' | 'failed' | 'skipped';

/** Run one MR-watch poll: list, claim, review, and mark each ready MR. */
export async function watchMergeRequestsOnce(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsOnceOptions = {},
): Promise<MergeRequestWatchTick> {
  const phase = opts.phase ?? 'watch-mrs';
  const ready = await primitives.listReady();
  opts.log?.(`${phase}: poll -> ${ready.length} ready`);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: MrWatchKind }> => {
      const id = mrId(item);
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
  const ids = (kind: MrWatchKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { reviewed: ids('reviewed'), failed: ids('failed'), skipped: ids('skipped') };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    // Detach on the timer path too, or a long-lived signal gains one listener per tick.
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Poll GitLab MRs until stopped, running the MR review loop for each ready MR. */
export async function watchMergeRequests(
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchMergeRequestsOnce(primitives, opts);
    opts.log?.(
      `watch-mrs: ${tick.reviewed.length} reviewed, ${tick.failed.length} failed, ${tick.skipped.length} skipped.`,
    );
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}
