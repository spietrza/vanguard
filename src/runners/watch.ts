import { describeIgnoredAuthor, isTrustedNonAuthorComment } from '../tasks/comment-trust.js';
import { LinearCliTaskFetcher, setLinearState, commentLinearIssue } from '../tasks/linear-cli.js';
import { GitHubTaskFetcher, editGithubLabels, commentGithubIssue, defaultGhRunner, isTrustedIssueAuthor } from '../tasks/github.js';
import { GitLabTaskFetcher, editGitlabLabels, commentGitlabIssue, defaultGlabRunner } from '../tasks/gitlab.js';
import { runLinearIssue } from './linear.js';
import { runGithubIssue } from './github.js';
import { runGitlabIssue } from './gitlab.js';
import { runSpecGenerator } from './spec.js';
import { assessTaskReadiness, isVanguardSpec, SPEC_TAG } from '../tasks/triage.js';
import { fanOut } from '../pipeline/fan-out.js';
import { failureReason, formatFailureComment } from '../core/errors.js';
import { GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import { GITLAB_SECRET_BLOCKED_LABEL } from '../gitlab-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { RunLinearIssueDeps } from './linear.js';
import type { RunGithubIssueDeps } from './github.js';
import type { RunGitlabIssueDeps } from './gitlab.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import type { LinearCliRunner } from '../tasks/linear-cli.js';
import type { GhRunner } from '../tasks/github.js';
import type { GlabRunner } from '../tasks/gitlab.js';

/** Injectable spec generator (the real one boots a sandbox; tests inject a fake). */
export type GenerateSpec = (id: string, deps: RunSpecGeneratorDeps) => Promise<string>;

/** Clarification comment posted when triage flags a ticket as too vague to proceed. */
function clarifyMessage(mode: 'spec' | 'agent'): string {
  return mode === 'spec'
    ? 'Vanguard could not start: this ticket is too vague to spec. Add a clear description (what and why) and re-trigger.'
    : 'Vanguard could not start: this ticket lacks acceptance criteria or a spec. Add testable acceptance criteria (or a spec comment) and re-trigger.';
}

/**
 * Wrap a generated spec so the agent pass and triage recognise it as a spec comment. White-label
 * drops the "Vanguard" heading (a client repo must not carry automation branding); recognition is
 * keyed on the <tech_spec> tag, so triage/idempotency/conformance behave identically in both modes.
 */
export function specComment(spec: string, opts?: { whiteLabel?: boolean }): string {
  const heading = opts?.whiteLabel === true ? 'Tech spec:' : 'Vanguard tech spec:';
  return `${heading}\n\n<${SPEC_TAG}>\n${spec}\n</${SPEC_TAG}>`;
}

/** Comment posted when a genuine no-change outcome un-sticks the claimed marker. */
const NO_CHANGE_MSG =
  'Vanguard run produced no changes — no PR was opened. Cleared `vanguard:running`; re-apply the trigger label to retry. See the run log.';

/**
 * Comment posted when the secret scan withheld the PR: what the watch did with the claim and the
 * exact step that releases the hold on THIS source (the configured trigger label / status / state).
 * The adapter's masked-findings comment carries no procedure — it also serves one-shot runs.
 */
function holdMessage(claimNote: string, resume: string): string {
  return `Vanguard held this issue: the outgoing secret scan withheld the PR. ${claimNote} To retry once the secret is out of the change, ${resume}.`;
}

/** Post the no-change comment and (optionally) revert the claim — independent I/O, run concurrently. */
async function commentAndRevert(comment: Promise<void>, revert?: Promise<void>): Promise<void> {
  await Promise.all(revert === undefined ? [comment] : [comment, revert]);
}

/**
 * Outcome of one issue run as the watch loop sees it. No `prUrl` has three meanings, and only the
 * first is a genuine no-change: the agent ran and the diff was empty (`onNoChange` un-sticks the
 * claim); `parked` — the agent never ran, triage already routed the ticket elsewhere (needs-info);
 * `secretBlocked` — the diff was withheld by the outgoing secret scan and the adapter already
 * labelled/commented the issue. The last must NOT revert the claim: sources that revert to the
 * trigger state (Linear, GitHub Projects) would re-list the issue next poll, re-run it, re-hit the
 * secret and re-post the block comment forever.
 */
export interface WatchRunOutcome {
  prUrl?: string;
  parked?: boolean;
  secretBlocked?: boolean;
}

export interface WatchPrimitives {
  /** List issues currently ready to run (trigger state + label). */
  listReady: () => Promise<Array<{ id: string }>>;
  /** Claim an issue so a later poll won't pick it again (e.g. move it out of the trigger state). */
  claim: (id: string) => Promise<void>;
  /** See WatchRunOutcome: only a genuine no-change (no PR, not parked, not secret-blocked) triggers `onNoChange`. */
  runOne: (id: string) => Promise<WatchRunOutcome>;
  /** Mark an issue as in review (a PR opened). */
  review: (id: string) => Promise<void>;
  /** No PR AND not parked: undo the claim so the issue is not stuck on the claimed marker. */
  onNoChange: (id: string) => Promise<void>;
  /**
   * The secret scan withheld the PR. Mark the hold WITHOUT restoring the trigger (a revert would
   * re-list the issue next poll) and tell the human how to release it: label sources swap the
   * claimed label for the secret-blocked label; state sources keep the claimed state. Every real
   * source supplies it; absent (test doubles) the issue simply stays claimed. A rejection routes to
   * onFailure and the claim stays.
   */
  onSecretBlocked?: (id: string) => Promise<void>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface WatchTick {
  opened: string[];
  noChange: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
  /** Ready but left unclaimed for the next poll, because --max-tasks was already met. */
  deferred: string[];
  /** PR withheld by the secret scan; held for a human (never reverted to the trigger). */
  secretBlocked: string[];
}

type Kind = 'opened' | 'noChange' | 'failed' | 'skipped' | 'deferred' | 'secretBlocked';

interface WatchLogOptions {
  log?: (msg: string) => void;
  phase?: string;
}

interface WatchOnceOptions extends WatchLogOptions {
  concurrency?: number;
  /** Cap the number of ready tasks successfully claimed and processed this poll, per phase (unset: process all). */
  maxTasks?: number;
}

interface SpecOnceOptions extends WatchOnceOptions {
  /** (loop-v1) No agent pass follows the spec pass, so this watch never builds an advanced ticket. */
  specOnly?: boolean;
}

function operatorLog(opts: WatchLogOptions, msg: string): void {
  opts.log?.(msg);
}

/** Summary suffix for a capped poll; empty when --max-tasks left nothing for the next poll. */
function deferredNote(tick: { deferred: string[] }): string {
  return tick.deferred.length > 0 ? `, ${tick.deferred.length} deferred by --max-tasks` : '';
}

/** Summary suffix for runs the secret scan withheld; empty on a clean poll. */
function secretBlockedNote(tick: { secretBlocked: string[] }): string {
  return tick.secretBlocked.length > 0 ? `, ${tick.secretBlocked.length} secret-blocked` : '';
}

function logPoll(ready: number, opts: WatchOnceOptions, phase: string): void {
  const cappedNote = opts.maxTasks !== undefined && opts.maxTasks < ready ? ` (capped to ${opts.maxTasks} by --max-tasks)` : '';
  operatorLog(opts, `${phase}: poll -> ${ready} ready${cappedNote}`);
}

/** `taken`: the claim threw (another runner has it). `deferred`: --max-tasks is already met. */
type ClaimOutcome = 'claimed' | 'taken' | 'deferred';

/**
 * Claim gate for one poll. Under --max-tasks, claims run one at a time in fetcher order and only a
 * successful claim counts, so items another runner already took do not use up the cap; the rest stay
 * unclaimed for the next poll. Uncapped, claims run concurrently as before.
 */
function claimGate(maxTasks: number | undefined): (claim: () => Promise<void>) => Promise<ClaimOutcome> {
  let claimed = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (claim) => {
    const attempt = async (): Promise<ClaimOutcome> => {
      if (maxTasks !== undefined && claimed >= maxTasks) return 'deferred';
      try {
        await claim();
      } catch {
        return 'taken';
      }
      claimed += 1;
      return 'claimed';
    };
    if (maxTasks === undefined) return attempt();
    const next = queue.then(attempt);
    queue = next;
    return next;
  };
}

/**
 * One poll: claim each ready issue (skipping any that can't be claimed), run it, then move it to
 * review when a PR opens or report the failure. Pure orchestration over injected primitives, so the
 * claim-before-run ordering and dedup are unit-testable without Linear.
 */
export async function watchOnce(primitives: WatchPrimitives, opts: WatchOnceOptions = {}): Promise<WatchTick> {
  const phase = opts.phase ?? 'watch';
  const ready = await primitives.listReady();
  logPoll(ready.length, opts, phase);
  const claim = claimGate(opts.maxTasks);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: Kind }> => {
      const claimed = await claim(() => primitives.claim(item.id));
      if (claimed === 'deferred') return { id: item.id, kind: 'deferred' };
      if (claimed === 'taken') {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      operatorLog(opts, `${phase} ${item.id}: claim -> running`);
      try {
        const { prUrl, parked, secretBlocked } = await primitives.runOne(item.id);
        if (secretBlocked === true) {
          // Log first: if the hold edit below throws, the failure comment must not be the only record.
          operatorLog(opts, `${phase} ${item.id}: secret blocked -> held for a human`);
          await primitives.onSecretBlocked?.(item.id);
          return { id: item.id, kind: 'secretBlocked' };
        }
        if (prUrl === undefined) {
          if (parked !== true) await primitives.onNoChange(item.id);
          operatorLog(opts, `${phase} ${item.id}: no change -> idle`);
          return { id: item.id, kind: 'noChange' };
        }
        await primitives.review(item.id);
        operatorLog(opts, `${phase} ${item.id}: pr opened -> review`);
        return { id: item.id, kind: 'opened' };
      } catch (error) {
        await primitives.onFailure(item.id, error);
        operatorLog(opts, `${phase} ${item.id}: failed -> failure noted`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: Kind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return {
    opened: ids('opened'),
    noChange: ids('noChange'),
    failed: ids('failed'),
    skipped: ids('skipped'),
    deferred: ids('deferred'),
    secretBlocked: ids('secretBlocked'),
  };
}

export interface SpecWatchPrimitives {
  listReady: () => Promise<Array<{ id: string }>>;
  claim: (id: string) => Promise<void>;
  /**
   * Triage + (spec-gen+comment+advance) or (clarify+needs-info). Returns the outcome.
   * At-least-once: the spec comment may be posted more than once if the advance step fails, but the
   * isSpecComment guard skips regeneration on retry so a re-run is cheap and posts no duplicate spec.
   */
  runSpec: (id: string) => Promise<'advanced' | 'needs_info'>;
  onFailure: (id: string, error: unknown) => Promise<void>;
}

export interface SpecTick {
  /** Triaged ready: spec generated, posted, and advanced to the agent trigger. */
  advanced: string[];
  /** Triaged vague: a clarification was requested and the issue moved to needs-info. */
  needsInfo: string[];
  failed: string[];
  /** Could not be claimed (already taken / state moved). */
  skipped: string[];
  /** Ready but left unclaimed for the next poll, because --max-tasks was already met. */
  deferred: string[];
}

type SpecKind = 'advanced' | 'needsInfo' | 'failed' | 'skipped' | 'deferred';

/**
 * One SPEC poll: claim each ready issue (skipping any that can't be claimed), triage it, then either
 * generate+post a tech spec and advance it to the agent trigger, or request clarification and move it
 * to needs-info. Mirrors watchOnce structurally (claim-before-run, fan-out, failure isolation) but
 * with honest spec semantics instead of PR semantics — it never opens a PR.
 */
export async function specOnce(primitives: SpecWatchPrimitives, opts: SpecOnceOptions = {}): Promise<SpecTick> {
  const phase = opts.phase ?? 'spec';
  const advancedNext = opts.specOnly === true ? 'not built (--spec-only)' : 'next poll agent';
  const ready = await primitives.listReady();
  logPoll(ready.length, opts, phase);
  const claim = claimGate(opts.maxTasks);
  const results = await fanOut(
    ready,
    async (item): Promise<{ id: string; kind: SpecKind }> => {
      const claimed = await claim(() => primitives.claim(item.id));
      if (claimed === 'deferred') return { id: item.id, kind: 'deferred' };
      if (claimed === 'taken') {
        operatorLog(opts, `${phase} ${item.id}: skipped -> already claimed`);
        return { id: item.id, kind: 'skipped' };
      }
      operatorLog(opts, `${phase} ${item.id}: claim -> triage`);
      try {
        const outcome = await primitives.runSpec(item.id);
        operatorLog(
          opts,
          outcome === 'advanced'
            ? `${phase} ${item.id}: advanced -> ${advancedNext}`
            : `${phase} ${item.id}: needs info -> waiting human`,
        );
        return { id: item.id, kind: outcome === 'advanced' ? 'advanced' : 'needsInfo' };
      } catch (error) {
        await primitives.onFailure(item.id, error);
        operatorLog(opts, `${phase} ${item.id}: failed -> retry later (${failureReason(error)})`);
        return { id: item.id, kind: 'failed' };
      }
    },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  const ids = (kind: SpecKind): string[] =>
    results.flatMap((o) => (o.status === 'fulfilled' && o.value.kind === kind ? [o.value.id] : []));
  return { advanced: ids('advanced'), needsInfo: ids('needsInfo'), failed: ids('failed'), skipped: ids('skipped'), deferred: ids('deferred') };
}

export interface WatchLinearOptions {
  deps: RunLinearIssueDeps;
  label: string;
  /** Linear state TYPE to poll (triage/backlog/unstarted/started/...); default 'unstarted' (Todo-like). */
  triggerState?: string;
  /**
   * The display NAME of the same state as `triggerState` (which is a TYPE). Needed because
   * `setLinearState` takes a state NAME, not a type. Used by `onNoChange` to revert a genuine
   * no-change issue back to the trigger state so a later poll re-picks it. Absent => onNoChange
   * only comments (no state revert).
   */
  triggerStateName?: string;
  /** State NAME to move an issue to on claim, e.g. 'In Progress'. */
  claimedState: string;
  /** State NAME after a PR opens, e.g. 'In Review'. */
  reviewState: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + moved to this state and NO implement budget is spent (returns
   * no PR). Absent => behaviour is unchanged (no triage, straight to runLinearIssue).
   */
  needsInfoState?: string;
  team?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  linear?: LinearCliRunner;
}

/** Build the real Linear-backed primitives: state+label trigger, claim and review via state changes. */
export function linearWatchPrimitives(opts: WatchLinearOptions): WatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
  });
  const trigger = opts.triggerState ?? 'unstarted';
  const needsInfoState = opts.needsInfoState;
  return {
    listReady: () => fetcher.list({ labels: [opts.label], state: trigger }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runOne:
      needsInfoState === undefined
        ? (id) => runLinearIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runLinearIssue(i, opts.deps), {
              comment: (body) => commentLinearIssue(id, body, opts.linear),
              toNeedsInfo: () => setLinearState(id, needsInfoState, opts.linear),
            }, opts.deps.feedbackAuthors),
    review: (id) => setLinearState(id, opts.reviewState, opts.linear),
    onNoChange: (id) =>
      commentAndRevert(
        commentLinearIssue(id, NO_CHANGE_MSG, opts.linear),
        opts.triggerStateName !== undefined ? setLinearState(id, opts.triggerStateName, opts.linear) : undefined,
      ),
    // Linear has no blocked state and reverting to the trigger state would re-list the issue next
    // poll, so the hold keeps the claimed state; the comment names the exact state to move back to.
    // Holding is only safe while `claimedState` (a state NAME) does not resolve to the `triggerState`
    // TYPE that listReady filters on — the same assumption the claim itself and onFailure rest on.
    onSecretBlocked: (id) =>
      commentLinearIssue(
        id,
        holdMessage(
          `It stays in "${opts.claimedState}" so the watch will not re-run it.`,
          `move it back to ${opts.triggerStateName !== undefined ? `"${opts.triggerStateName}"` : 'its trigger state'}`,
        ),
        opts.linear,
      ),
    onFailure: (id, error) => commentLinearIssue(id, formatFailureComment('Vanguard run failed', error), opts.linear),
  };
}

export interface WatchLinearSpecOptions {
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  label: string;
  /** Linear state TYPE to poll for spec-ready issues (e.g. 'triage'). */
  specTriggerState?: string;
  /**
   * The display NAME of the same state as `specTriggerState` (which is a TYPE). Needed because
   * `issue update --state` takes a state NAME, not a type — this is the name the issue is reverted to
   * on failure so a later poll re-picks it. E.g. specTriggerState: 'triage', specTriggerStateName: 'Spec'.
   */
  specTriggerStateName: string;
  /** State NAME to move an issue to on claim, e.g. 'Speccing'. */
  claimedState: string;
  /** State NAME after a spec is generated — the agent-pass trigger, e.g. 'Todo'. */
  agentState: string;
  /** State NAME when triage flags the ticket as too vague, e.g. 'Needs Info'. */
  needsInfoState: string;
  team?: string;
  linear?: LinearCliRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/** Actions injected per-source into runSpecCore. */
interface RunSpecCoreActions {
  postComment: (body: string) => Promise<void>;
  advance: () => Promise<void>;
  toNeedsInfo: () => Promise<void>;
}

/**
 * Shared 3-branch spec-run logic used by both Linear and GitHub spec primitives.
 *
 * Branch (a) idempotent retry — already Vanguard-specced: advance without regenerating.
 * Branch (b) triage says needs_info: post clarification comment then move to needs-info.
 * Branch (c) normal path: generate spec, post it, then advance.
 *
 * Call order is preserved: postComment BEFORE advance/toNeedsInfo.
 */
async function runSpecCore(
  task: Task,
  id: string,
  deps: RunSpecGeneratorDeps,
  generate: GenerateSpec,
  actions: RunSpecCoreActions,
): Promise<'advanced' | 'needs_info'> {
  // (a) Idempotent retry: if a Vanguard-generated spec is already posted skip regeneration and just
  // advance — cheap, no duplicate spec comment / wasted sandbox+LLM. Issue-author trust is excluded
  // here: the reporter must not be able to skip spec generation with a forged <tech_spec>.
  if (task.comments.some((c) => isTrustedNonAuthorComment(c, { allowedAuthors: deps.feedbackAuthors }) && isVanguardSpec(c))) {
    await actions.advance();
    return 'advanced';
  }

  // (b) Triage gate: description too vague to spec.
  if (assessTaskReadiness(task, 'spec') === 'needs_info') {
    await actions.postComment(clarifyMessage('spec'));
    await actions.toNeedsInfo();
    return 'needs_info';
  }

  // (c) Normal path: generate, post, advance.
  const spec = await generate(id, deps);
  await actions.postComment(specComment(spec));
  await actions.advance();
  return 'advanced';
}

/**
 * Shared agent-pass triage gate used by both Linear and GitHub issue watch primitives.
 *
 * When the needs-info option is set: fetch the task, run assessTaskReadiness in 'agent' mode,
 * and if vague post the clarification comment and move to needs-info (returns { parked: true } so
 * watchOnce counts this as noChange but skips onNoChange — the ticket is already correctly routed,
 * no implement budget spent). Otherwise delegate to the real runner.
 *
 * When the needs-info option is absent: delegate directly without fetching (behaviour unchanged).
 */
async function triageAgentRun(
  id: string,
  fetcher: { fetch: (id: string) => Promise<Task> },
  runner: (id: string) => Promise<WatchRunOutcome>,
  action: {
    comment: (body: string) => Promise<void>;
    toNeedsInfo: () => Promise<void>;
  },
  allowedAuthors?: readonly string[],
): Promise<WatchRunOutcome> {
  const task = await fetcher.fetch(id);
  if (assessTaskReadiness(task, 'agent', { allowedAuthors }) === 'needs_info') {
    await action.comment(clarifyMessage('agent'));
    await action.toNeedsInfo();
    return { parked: true }; // no PR, already routed -> watchOnce skips onNoChange
  }
  return runner(id);
}

/**
 * Linear SPEC primitives: poll a state+label trigger, triage each issue, then either generate+post a
 * tech spec and advance the issue to the agent state, or request clarification and move it to
 * needs-info. On failure the issue is reverted to its spec-trigger state so a later poll retries it.
 */
export function linearSpecPrimitives(opts: WatchLinearSpecOptions): SpecWatchPrimitives {
  const fetcher = new LinearCliTaskFetcher({
    ...(opts.team !== undefined ? { team: opts.team } : {}),
    ...(opts.linear !== undefined ? { linear: opts.linear } : {}),
  });
  const trigger = opts.specTriggerState ?? 'triage';
  const generate = opts.generateSpec ?? runSpecGenerator;
  return {
    listReady: () => fetcher.list({ labels: [opts.label], state: trigger }),
    claim: (id) => setLinearState(id, opts.claimedState, opts.linear),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentLinearIssue(id, body, opts.linear),
        advance: () => setLinearState(id, opts.agentState, opts.linear),
        toNeedsInfo: () => setLinearState(id, opts.needsInfoState, opts.linear),
      });
    },
    onFailure: async (id, error) => {
      await commentLinearIssue(id, formatFailureComment('Vanguard spec failed', error), opts.linear);
      await setLinearState(id, opts.specTriggerStateName, opts.linear);
    },
  };
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

interface LoopControls {
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
}

interface LoopV1Controls extends LoopControls {
  /** Run only the spec pass each tick; the agent pass never lists, claims or runs. */
  specOnly?: boolean;
}

/** Poll on an interval, running each newly-ready item. Stops on signal or after one pass (once). */
async function runWatchLoop(primitives: WatchPrimitives, opts: LoopControls, log: (msg: string) => void): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const tick = await watchOnce(primitives, {
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {}),
      log,
      phase: 'watch',
    });
    log(`watch: ${tick.opened.length} PR(s), ${tick.noChange.length} no-change, ${tick.failed.length} failed, ${tick.skipped.length} skipped${deferredNote(tick)}${secretBlockedNote(tick)}.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

/** Poll Linear and run each newly-ready issue. */
export async function watchLinear(opts: WatchLinearOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(linearWatchPrimitives(opts), opts, log);
}

/**
 * Loop-v1 poll: run the SPEC pass (specOnce over specPrimitives) then the AGENT pass (watchOnce over
 * agentPrimitives) once per tick. Continuous loops defer freshly-specced tickets to the next poll,
 * giving a human a window to intervene before the agent runs. One-shot runs carry freshly-specced
 * tickets into the same invocation, which avoids relying on GitHub's eventually consistent label
 * search in GitHub Actions. With specOnly the agent pass is skipped entirely: advanced tickets move
 * to the spec pass's agent state/label (a review state in a review-window setup) and this watch
 * never builds them.
 * Pure orchestration over injected primitives; the per-source wrappers build the primitives.
 */
export async function runLoopV1(
  specPrimitives: SpecWatchPrimitives,
  agentPrimitives: WatchPrimitives,
  opts: LoopV1Controls,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const concurrency = opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {};
  const specOnly = opts.specOnly === true ? { specOnly: true } : {};
  for (;;) {
    if (opts.signal?.aborted === true) return;
    const maxTasks = opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {};
    const spec = await specOnce(specPrimitives, { ...concurrency, ...maxTasks, ...specOnly, log, phase: 'spec' });
    log(`spec: ${spec.advanced.length} advanced, ${spec.needsInfo.length} needs-info, ${spec.failed.length} failed, ${spec.skipped.length} skipped${deferredNote(spec)}.`);
    if (opts.specOnly === true) {
      if (opts.once === true) return;
      await delay(intervalMs, opts.signal);
      continue;
    }
    // GitHub's label index is eventually consistent: a label written by the spec pass may not
    // appear in listReady for several seconds. In --once mode carry just-advanced IDs directly
    // into the agent ready-set so spec→build completes in one invocation, deduping against what
    // the index already returned. In continuous mode exclude them — the next poll is the
    // human-intervention window before the agent runs.
    const listed = await agentPrimitives.listReady();
    const advancedSet = new Set(spec.advanced);
    const listedIds = new Set(listed.map((item) => item.id));
    const agentReady =
      opts.once === true
        ? [...spec.advanced.filter((id) => !listedIds.has(id)).map((id) => ({ id })), ...listed]
        : listed.filter((item) => !advancedSet.has(item.id));
    const agentThisTick: WatchPrimitives = {
      ...agentPrimitives,
      listReady: async () => agentReady,
    };
    const agent = await watchOnce(agentThisTick, { ...concurrency, ...maxTasks, log, phase: 'watch' });
    log(`watch: ${agent.opened.length} PR(s), ${agent.noChange.length} no-change, ${agent.failed.length} failed, ${agent.skipped.length} skipped${deferredNote(agent)}${secretBlockedNote(agent)}.`);
    if (opts.once === true) return;
    await delay(intervalMs, opts.signal);
  }
}

export interface WatchLinearLoopV1Options {
  /** SPEC-pass options (state+label trigger, spec-gen, advance to the agent state). */
  spec: WatchLinearSpecOptions;
  /** AGENT-pass options. Supply needsInfoState to gate vague tickets out of the implement budget. */
  agent: WatchLinearOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues move to spec.agentState and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over Linear: each poll runs the spec pass then the agent pass. */
export async function watchLinearLoopV1(opts: WatchLinearLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(linearSpecPrimitives(opts.spec), linearWatchPrimitives(opts.agent), opts, log);
}

export interface WatchGithubOptions {
  deps: RunGithubIssueDeps;
  /** Trigger label: open issues with this label are picked. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label` to be listed
   * as ready. Absent => only `label` is required (existing single-loop behaviour unchanged).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced even though
   * the routing labels (agent/spec trigger) already filter the query.
   */
  ownerLabel?: string;
  /** Label added on claim (and the trigger label removed) so re-polls skip it, e.g. 'vanguard:running'. */
  claimedLabel: string;
  /** Label added after a PR opens, e.g. 'vanguard:needs-human-review'. */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label (claimed removed) and NO implement budget
   * is spent (returns no PR). Absent => behaviour is unchanged (no triage, straight to runGithubIssue).
   */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * Drop ready GitHub issues whose author is not trusted (OWNER/MEMBER/COLLABORATOR, --feedback-authors or
 * a GitHub App bot). A label alone is not consent: issue templates can apply the trigger label to an
 * outsider's issue. Applied to both passes, so the spec pass never advances one into the agent pass.
 */
async function withTrustedIssueAuthors(
  repo: string,
  tasks: Task[],
  allowedAuthors: readonly string[] | undefined,
  gh: GhRunner | undefined,
): Promise<Task[]> {
  const verdicts = await Promise.all(tasks.map((task) => isTrustedIssueAuthor(repo, task.ref ?? task.id, allowedAuthors, gh)));
  return tasks.filter((task, i) => {
    const verdict = verdicts[i]!;
    if (verdict.trusted) return true;
    if (verdict.error !== undefined) {
      console.log(`vanguard: ${task.id} skipped -> author lookup failed: ${verdict.error}`);
      return false;
    }
    console.log(`vanguard: ${task.id} skipped -> issue author ${describeIgnoredAuthor(verdict.author || '?', verdict.association)} is not trusted (repo member or --feedback-authors)`);
    return false;
  });
}

/** GitHub-issue primitives: trigger by label, claim/review by swapping labels (issues have no states). */
export function githubIssueWatchPrimitives(opts: WatchGithubOptions): WatchPrimitives {
  const repo = opts.deps.repoSlug;
  const fetcher = new GitHubTaskFetcher(repo, opts.gh);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  // Ready issues still carrying the hold label from an earlier secret block: a human re-triggered
  // them, so the claim clears it too. Only for issues seen with the label — a blind `--remove-label`
  // makes `gh issue edit` fail in a repo that never created it.
  const heldBefore = new Set<string>();
  return {
    listReady: async () => {
      const tasks = await withTrustedIssueAuthors(repo, await fetcher.list({ labels: agentLabels }), opts.deps.feedbackAuthors, opts.gh);
      heldBefore.clear();
      for (const task of tasks) if (task.labels.includes(GITHUB_SECRET_BLOCKED_LABEL)) heldBefore.add(task.id);
      return tasks.map((task) => ({ id: task.id }));
    },
    claim: (id) =>
      editGithubLabels(
        repo,
        id,
        { remove: heldBefore.has(id) ? [opts.label, GITHUB_SECRET_BLOCKED_LABEL] : [opts.label], add: [opts.claimedLabel] },
        opts.gh,
      ),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGithubIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGithubIssue(i, opts.deps), {
              comment: (body) => commentGithubIssue(repo, id, body, opts.gh),
              toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, opts.gh),
            }, opts.deps.feedbackAuthors),
    review: (id) => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, opts.gh),
    onNoChange: (id) =>
      commentAndRevert(
        commentGithubIssue(repo, id, NO_CHANGE_MSG, opts.gh),
        editGithubLabels(repo, id, { remove: [opts.claimedLabel] }, opts.gh),
      ),
    // One edit swaps claimed -> secret-blocked, so the claim is never released without the hold
    // label landing. `gh issue edit --add-label` fails on a label the repo never created, and the
    // adapter only pre-creates it when it posts findings (not in white-label mode), so ensure it
    // here first (best-effort, the same pre-step as addPrFailureLabel). If the swap fails it throws
    // into onFailure and the claimed marker stays. The trigger label was removed on claim and is
    // not restored; the comment names the label to re-apply. Same in white-label mode: the claim
    // label is already the watch's own marker, and a white-label adapter posts no findings, so this
    // comment is the human's only signal.
    onSecretBlocked: async (id) => {
      await (opts.gh ?? defaultGhRunner)(['label', 'create', GITHUB_SECRET_BLOCKED_LABEL, '--repo', repo, '--force']).catch(() => undefined);
      await editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [GITHUB_SECRET_BLOCKED_LABEL] }, opts.gh);
      await commentGithubIssue(
        repo,
        id,
        holdMessage(`Swapped \`${opts.claimedLabel}\` for \`${GITHUB_SECRET_BLOCKED_LABEL}\`.`, `re-apply the \`${opts.label}\` label`),
        opts.gh,
      );
    },
    onFailure: (id, error) => commentGithubIssue(repo, id, formatFailureComment('Vanguard run failed', error), opts.gh),
  };
}

export interface WatchGithubSpecOptions {
  /** Deps for the spec generator (no PR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** owner/repo the issues live in (the spec deps' fetcher is used to read them). */
  repoSlug: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel` to be
   * listed as ready for the spec pass. Absent => only `specLabel` is required (existing behaviour).
   * Used in loop-v1 so the `--label` (e.g. 'vanguard') ownership requirement is enforced on top of
   * the spec-trigger routing label. Claim/advance/needs-info are unaffected — they swap only the
   * routing labels, leaving the ownership label intact on the issue.
   */
  ownerLabel?: string;
  /** Label added on claim (and the spec label removed) so re-polls skip it, e.g. 'vanguard:speccing'. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger, e.g. 'vanguard'. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague, e.g. 'vanguard:needs-info'. */
  needsInfoLabel: string;
  gh?: GhRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitHub-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it. (Issues have no states; everything is labels.)
 */
export function githubSpecPrimitives(opts: WatchGithubSpecOptions): SpecWatchPrimitives {
  const repo = opts.repoSlug;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () =>
      (await withTrustedIssueAuthors(repo, await fetcher.list({ labels: specLabels }), opts.deps.feedbackAuthors, opts.gh)).map((task) => ({ id: task.id })),
    claim: (id) => editGithubLabels(repo, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, opts.gh),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGithubIssue(repo, id, body, opts.gh),
        advance: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, opts.gh),
        toNeedsInfo: () => editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, opts.gh),
      });
    },
    onFailure: async (id, error) => {
      await commentGithubIssue(repo, id, formatFailureComment('Vanguard spec failed', error), opts.gh);
      await editGithubLabels(repo, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, opts.gh);
    },
  };
}

/** Poll GitHub Issues and run each newly-ready (labeled) issue. */
export async function watchGithub(opts: WatchGithubOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubIssueWatchPrimitives(opts), opts, log);
}

export interface WatchGithubLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGithubSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGithubOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues get spec.agentLabel and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Loop v1 over GitHub Issues: each poll runs the spec pass then the agent pass. */
export async function watchGithubLoopV1(opts: WatchGithubLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(githubSpecPrimitives(opts.spec), githubIssueWatchPrimitives(opts.agent), opts, log);
}

export interface WatchGithubProjectOptions {
  deps: RunGithubIssueDeps;
  projectNumber: number;
  /** Owner of the project (default: first segment of deps.repoSlug). */
  owner?: string;
  /** Only pick up board items with this label (optional). */
  label?: string;
  /** Status option name for ready-to-run items (e.g. 'Todo'). */
  triggerStatus: string;
  /** Status option name set on claim so re-polls skip the item. */
  claimedStatus: string;
  /** Status option name set after a PR opens. */
  reviewStatus: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  gh?: GhRunner;
}

/**
 * GitHub Projects v2 primitives: trigger by Status field value, claim/review by updating the Status
 * field via `gh project item-edit`. Field and option IDs are resolved once via `gh project field-list`
 * and `gh project view` and then cached for the lifetime of the primitives object.
 *
 * The Status option names (triggerStatus / claimedStatus / reviewStatus) must match the exact names
 * configured on the project's Status field — find them with:
 *   gh project field-list <projectNumber> --owner <owner> --format json
 */
interface ProjectMeta {
  projectNodeId: string;
  statusFieldId: string;
  statusOptionIds: Map<string, string>;
}

export function githubProjectWatchPrimitives(opts: WatchGithubProjectOptions): WatchPrimitives {
  const gh = opts.gh ?? defaultGhRunner;
  const owner = opts.owner ?? (opts.deps.repoSlug.split('/')[0] as string);
  const repo = opts.deps.repoSlug;
  const projectNumber = String(opts.projectNumber);

  // Populated on each listReady call; claim/review look up the project item node ID here.
  const itemNodeIds = new Map<string, string>();
  // Ready items still carrying the hold label from an earlier secret block; cleared on claim.
  const heldBefore = new Set<string>();

  // Single cached promise: fetches project node ID and Status field in parallel, resolved once.
  let projectMeta: Promise<ProjectMeta> | undefined;

  function getProjectMeta(): Promise<ProjectMeta> {
    if (projectMeta === undefined) {
      projectMeta = Promise.all([
        gh(['project', 'view', projectNumber, '--owner', owner, '--format', 'json'])
          .then((out) => (JSON.parse(out) as { id: string }).id),
        gh(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']).then((out) => {
          const parsed = JSON.parse(out) as {
            fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
          };
          const field = parsed.fields.find((f) => f.name === 'Status');
          if (field === undefined) throw new Error(`GitHub project ${opts.projectNumber} has no "Status" field`);
          return { fieldId: field.id, optionIds: new Map(field.options?.map((o) => [o.name, o.id] as [string, string]) ?? []) };
        }),
      ]).then(([projectNodeId, { fieldId: statusFieldId, optionIds: statusOptionIds }]) => ({
        projectNodeId,
        statusFieldId,
        statusOptionIds,
      }));
    }
    return projectMeta;
  }

  async function setStatus(issueRef: string, statusName: string): Promise<void> {
    const { projectNodeId, statusFieldId, statusOptionIds } = await getProjectMeta();
    const nodeId = itemNodeIds.get(issueRef);
    if (nodeId === undefined) throw new Error(`Project item for ${issueRef} not in cache; call listReady first`);
    const optionId = statusOptionIds.get(statusName);
    if (optionId === undefined) throw new Error(`Status option "${statusName}" not found in project ${opts.projectNumber}`);
    await gh(['project', 'item-edit', '--id', nodeId, '--project-id', projectNodeId, '--field-id', statusFieldId, '--single-select-option-id', optionId]);
  }

  return {
    listReady: async () => {
      const out = await gh(['project', 'item-list', projectNumber, '--owner', owner, '--format', 'json', '--limit', '1000']);
      const parsed = JSON.parse(out) as {
        items: Array<{
          id: string;
          status?: string;
          content?: { type?: string; number?: number; repository?: string; labels?: string[] };
        }>;
      };
      itemNodeIds.clear();
      heldBefore.clear();
      const ready: Array<{ id: string }> = [];
      for (const item of parsed.items) {
        const content = item.content;
        if (content === undefined || content.type !== 'Issue' || content.number === undefined) continue;
        const itemRepo = content.repository ?? repo;
        // The run path (runGithubIssue) is pinned to the watched repo: a foreign item would run
        // <repo>#<number>, an issue nobody selected. Skip it and say so.
        if (itemRepo.toLowerCase() !== repo.toLowerCase()) {
          if (item.status === opts.triggerStatus) console.warn(`vanguard: project item ${itemRepo}#${content.number} belongs to another repository than ${repo}; skipped`);
          continue;
        }
        const issueRef = `${itemRepo}#${content.number}`;
        itemNodeIds.set(issueRef, item.id);
        if (item.status !== opts.triggerStatus) continue;
        if (opts.label !== undefined && !(content.labels ?? []).includes(opts.label)) continue;
        if ((content.labels ?? []).includes(GITHUB_SECRET_BLOCKED_LABEL)) heldBefore.add(issueRef);
        ready.push({ id: issueRef });
      }
      return ready;
    },
    // A re-triggered item (moved back to the trigger status by a human) sheds the hold label from
    // its earlier secret block; only for items listReady saw carrying it (see githubIssueWatchPrimitives).
    // The cleanup is cosmetic and runs after the status move, so it must not throw: claimGate reads
    // any throw as "already claimed" and the item would sit in the claimed status with no run and
    // no comment. The edit goes to the issue's own repo — a board can hold issues from other repos.
    claim: async (id) => {
      await setStatus(id, opts.claimedStatus);
      if (heldBefore.has(id)) {
        await editGithubLabels(id.slice(0, id.indexOf('#')), id, { remove: [GITHUB_SECRET_BLOCKED_LABEL] }, gh).catch(() => undefined);
      }
    },
    runOne: (id) => runGithubIssue(id, opts.deps),
    review: (id) => setStatus(id, opts.reviewStatus),
    onNoChange: (id) => commentAndRevert(commentGithubIssue(repo, id, NO_CHANGE_MSG, gh), setStatus(id, opts.triggerStatus)),
    // The only configured statuses are trigger/claimed/review and reverting to the trigger status
    // would re-list the item next poll, so the hold keeps the claimed status; the comment names the
    // status to move back to. The adapter already added the secret-blocked label + masked findings.
    onSecretBlocked: (id) =>
      commentGithubIssue(
        repo,
        id,
        holdMessage(`It stays in "${opts.claimedStatus}" so the watch will not re-run it.`, `move it back to "${opts.triggerStatus}"`),
        gh,
      ),
    onFailure: (id, error) => commentGithubIssue(repo, id, formatFailureComment('Vanguard run failed', error), gh),
  };
}

/** Poll GitHub Projects v2 and run each item in the trigger Status. */
export async function watchGithubProject(opts: WatchGithubProjectOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(githubProjectWatchPrimitives(opts), opts, log);
}

export interface WatchGitlabOptions {
  deps: RunGitlabIssueDeps;
  /** Trigger label: open issues carrying this label are picked for running. */
  label: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `label`.
   * Absent => only `label` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (trigger label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after an MR opens (claimed label auto-removed by GitLab scoped-label rule when same scope). */
  reviewLabel: string;
  /**
   * Loop-v1 agent-pass triage gate (optional). When set, runOne first triages the ticket in 'agent'
   * mode; a vague ticket is commented + swapped to this label and NO implement budget is spent.
   * Absent => behaviour is unchanged (no triage, straight to runGitlabIssue).
   */
  needsInfoLabel?: string;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  signal?: AbortSignal;
  /** Injectable runner for tests. Defaults to `defaultGlabRunner`. */
  gl?: GlabRunner;
}

/** GitLab issue primitives: trigger by label, claim/review by swapping scoped labels. */
export function gitlabWatchPrimitives(opts: WatchGitlabOptions): WatchPrimitives {
  const project = opts.deps.project;
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = new GitLabTaskFetcher(project, glab);
  const needsInfoLabel = opts.needsInfoLabel;
  const agentLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.label] : [opts.label];
  // Ready issues still carrying the hold label from an earlier secret block (re-triggered by a
  // human): the claim clears it too. See githubIssueWatchPrimitives.
  const heldBefore = new Set<string>();
  return {
    listReady: async () => {
      const tasks = await fetcher.list({ labels: agentLabels });
      heldBefore.clear();
      for (const task of tasks) if (task.labels.includes(GITLAB_SECRET_BLOCKED_LABEL)) heldBefore.add(task.id);
      return tasks.map((task) => ({ id: task.id }));
    },
    claim: (id) =>
      // Explicitly remove trigger label so future polls don't pick it up again.
      // GitLab scoped :: only auto-removes within the same scope prefix.
      editGitlabLabels(
        project,
        id,
        { remove: heldBefore.has(id) ? [opts.label, GITLAB_SECRET_BLOCKED_LABEL] : [opts.label], add: [opts.claimedLabel] },
        glab,
      ),
    runOne:
      needsInfoLabel === undefined
        ? (id) => runGitlabIssue(id, opts.deps)
        : (id) =>
            triageAgentRun(id, fetcher, (i) => runGitlabIssue(i, opts.deps), {
              comment: (body) => commentGitlabIssue(project, id, body, glab),
              toNeedsInfo: () =>
                editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [needsInfoLabel] }, glab),
            }, opts.deps.feedbackAuthors),
    review: (id) =>
      // Explicitly remove claimedLabel for robustness when non-scoped labels are configured.
      editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [opts.reviewLabel] }, glab),
    onNoChange: async (id) => {
      await commentGitlabIssue(project, id, NO_CHANGE_MSG, glab);
      await editGitlabLabels(project, id, { remove: [opts.claimedLabel] }, glab);
    },
    // One edit swaps claimed -> secret-blocked so the claim is never released without the hold
    // label landing. `glab issue update --label` is a silent no-op on a project lacking the label
    // (the `--unlabel` in the same call still lands, releasing the claim with no hold), and the
    // adapter only pre-creates it when it posts findings (not in white-label mode), so ensure it
    // here first (best-effort, as addMrFailureLabel does). A failing swap throws into onFailure
    // and the claimed marker stays. Trigger label not restored (removed on claim); the note names
    // the label to re-apply. Same in white-label mode (see githubIssueWatchPrimitives).
    onSecretBlocked: async (id) => {
      await glab(['label', 'create', '--repo', project, '--name', GITLAB_SECRET_BLOCKED_LABEL]).catch(() => undefined);
      await editGitlabLabels(project, id, { remove: [opts.claimedLabel], add: [GITLAB_SECRET_BLOCKED_LABEL] }, glab);
      await commentGitlabIssue(
        project,
        id,
        holdMessage(`Swapped \`${opts.claimedLabel}\` for \`${GITLAB_SECRET_BLOCKED_LABEL}\`.`, `re-apply the \`${opts.label}\` label`),
        glab,
      );
    },
    onFailure: (id, error) =>
      commentGitlabIssue(project, id, formatFailureComment('Vanguard run failed', error), glab),
  };
}

export interface WatchGitlabSpecOptions {
  /** Deps for the spec generator (no MR is opened in the spec pass). */
  deps: RunSpecGeneratorDeps;
  /** GitLab project path, e.g. `group/project`. */
  project: string;
  /** Trigger label: open issues with this label are picked for speccing. */
  specLabel: string;
  /**
   * Ownership label (optional). When set, issues must carry BOTH this label AND `specLabel`.
   * Absent => only `specLabel` is required.
   */
  ownerLabel?: string;
  /** Label added on claim (spec label removed) so re-polls skip it. */
  claimedLabel: string;
  /** Label added after a spec is generated — the agent-pass trigger. */
  agentLabel: string;
  /** Label added when triage flags the ticket as too vague. */
  needsInfoLabel: string;
  gl?: GlabRunner;
  /** Injected for tests so the spec pass runs without a sandbox. Defaults to the real generator. */
  generateSpec?: GenerateSpec;
}

/**
 * GitLab-issue SPEC primitives: trigger by label, triage each issue, then either generate+post a tech
 * spec and swap to the agent label, or request clarification and swap to needs-info. On failure the
 * trigger label is restored so a later poll retries it.
 */
export function gitlabSpecPrimitives(opts: WatchGitlabSpecOptions): SpecWatchPrimitives {
  const glab = opts.gl ?? defaultGlabRunner;
  const fetcher = opts.deps.fetcher;
  const generate = opts.generateSpec ?? runSpecGenerator;
  const specLabels = opts.ownerLabel !== undefined ? [opts.ownerLabel, opts.specLabel] : [opts.specLabel];
  return {
    listReady: async () => (await fetcher.list({ labels: specLabels })).map((task) => ({ id: task.id })),
    claim: (id) =>
      editGitlabLabels(opts.project, id, { remove: [opts.specLabel], add: [opts.claimedLabel] }, glab),
    runSpec: async (id) => {
      const task = await fetcher.fetch(id);
      return runSpecCore(task, id, opts.deps, generate, {
        postComment: (body) => commentGitlabIssue(opts.project, id, body, glab),
        advance: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.agentLabel] }, glab),
        toNeedsInfo: () =>
          editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.needsInfoLabel] }, glab),
      });
    },
    onFailure: async (id, error) => {
      await commentGitlabIssue(opts.project, id, formatFailureComment('Vanguard spec failed', error), glab);
      // Restore spec label so next poll retries
      await editGitlabLabels(opts.project, id, { remove: [opts.claimedLabel], add: [opts.specLabel] }, glab);
    },
  };
}

export interface WatchGitlabLoopV1Options {
  /** SPEC-pass options (label trigger, spec-gen, swap to the agent label). */
  spec: WatchGitlabSpecOptions;
  /** AGENT-pass options. Supply needsInfoLabel to gate vague tickets out of the implement budget. */
  agent: WatchGitlabOptions;
  concurrency?: number;
  intervalMs?: number;
  once?: boolean;
  /** Cap the number of ready tasks claimed and processed per poll (unset: process all). */
  maxTasks?: number;
  /** Run only the spec pass each poll; advanced issues get spec.agentLabel and are not built by this watch. */
  specOnly?: boolean;
  signal?: AbortSignal;
}

/** Poll GitLab Issues and run each newly-ready (labeled) issue. */
export async function watchGitlab(opts: WatchGitlabOptions, log: (msg: string) => void = console.log): Promise<void> {
  await runWatchLoop(gitlabWatchPrimitives(opts), opts, log);
}

/** Loop v1 over GitLab Issues: each poll runs the spec pass then the agent pass. */
export async function watchGitlabLoopV1(opts: WatchGitlabLoopV1Options, log: (msg: string) => void = console.log): Promise<void> {
  await runLoopV1(gitlabSpecPrimitives(opts.spec), gitlabWatchPrimitives(opts.agent), opts, log);
}
