import { readFileSync } from 'node:fs';
import { githubPullRequestWatchPrimitives, watchPullRequests } from '../runners/pr-watch.js';
import { reviewPrCommand } from './review-pr.js';
import type { Command } from './args.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchPrimitives, PullRequestWatchTick, WatchPullRequestsLoopOptions } from '../runners/pr-watch.js';

type WatchPrsCommand = Extract<Command, { kind: 'watch-prs' }>;
type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;

export type ReviewPrCommandRunner = (cmd: ReviewPrCommand) => Promise<void>;
export type WatchPullRequestsRunner = (
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsLoopOptions,
) => Promise<PullRequestWatchTick | undefined>;

interface PullRequestEventPayload {
  action?: string;
  label?: { name?: string };
  pull_request?: { number?: number };
}

/** A caller labels a just-opened or just-readied factory PR in an earlier job, then reviews it here. */
const READY_ACTIONS = new Set(['opened', 'ready_for_review']);

/**
 * PR number from the Actions event that triggered this run. The label-filtered scan is search-backed
 * and eventually consistent — a PR labeled seconds before the run can be invisible to it, turning the
 * run into a silent no-op. Only trusts the payload when its label matches the trigger label, or when the
 * PR was just opened or marked ready; either way the hinted PR is fetched live and must carry the label.
 */
export function eventPullRequestHint(
  label: string,
  eventPath: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number | undefined {
  if (eventPath === undefined || eventPath === '') return undefined;
  try {
    const payload = JSON.parse(readFile(eventPath)) as PullRequestEventPayload;
    if (payload.label?.name !== label && !READY_ACTIONS.has(payload.action ?? '')) return undefined;
    const number = payload.pull_request?.number;
    return typeof number === 'number' && Number.isInteger(number) && number >= 1 ? number : undefined;
  } catch {
    return undefined;
  }
}

export interface WatchPrsCommandDeps {
  gh?: GhRunner;
  reviewPr?: ReviewPrCommandRunner;
  watchPullRequests?: WatchPullRequestsRunner;
  log?: (line: string) => void;
}

/** Poll GitHub pull requests by label and run Vanguard's non-blocking review on each claimed PR. */
export async function watchPrsCommand(cmd: WatchPrsCommand, deps: WatchPrsCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const reviewPr = deps.reviewPr ?? ((reviewCmd: ReviewPrCommand) => reviewPrCommand(reviewCmd));
  const runWatchPullRequests = deps.watchPullRequests ?? watchPullRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const hintPr = cmd.pr ?? eventPullRequestHint(cmd.label, process.env.GITHUB_EVENT_PATH);
  const primitives = githubPullRequestWatchPrimitives({
    repoSlug: cmd.repoSlug,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    log,
    ...(hintPr !== undefined ? { hintPr } : {}),
    ...(cmd.author !== undefined ? { author: cmd.author } : {}),
    ...(cmd.feedbackAuthors !== undefined ? { allowedAuthors: cmd.feedbackAuthors } : {}),
    ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
    reviewOne: (item) =>
      reviewPr({
        kind: 'review-pr',
        prRef: String(item.number),
        repoSlug: item.repoSlug,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
        ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
        ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
      }),
  });

  log(`watch-prs[github]: polling every ${cmd.intervalMs / 1000}s for PRs labeled "${cmd.label}". Ctrl-C to stop.`);
  if (hintPr !== undefined) {
    log(`watch-prs[github]: ${cmd.repoSlug}#${hintPr} pinned from ${cmd.pr !== undefined ? '--pr' : 'the label event'} — reviewed even if the label scan misses it.`);
  }
  try {
    const tick = await runWatchPullRequests(primitives, {
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal: controller.signal,
      log,
    });
    // --once is the CI mode: a failed review must fail the step (the trigger label was restored and
    // the next sweep retries) instead of reporting green with nothing posted.
    if (cmd.once && tick !== undefined && tick.failed.length > 0) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
