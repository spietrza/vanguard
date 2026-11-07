import type { BoardTask } from '../wire.js';
import type { Task } from './fetcher.js';

/**
 * The board read path (S9) — ported 1:1 from the retired Rust implementation
 * (apps/desktop/src-tauri/src/tasks.rs + taskid.rs), because the column mapping encodes Vanguard's
 * label vocabulary (src/github-labels.ts / src/gitlab-labels.ts), which lives in core: leaving it
 * in Rust was the split-brain this subsystem killed. Test table ported verbatim.
 */

export type BoardSource = 'github' | 'gitlab' | 'linear';

/**
 * True if `word` appears in `t` as a whole token (bounded by non-alphanumerics), not a substring.
 * Keeps `incomplete` out of `complete`, `preview` out of `review`, `inspection` out of `spec`.
 * Hyphens/colons/spaces are boundaries, so `vanguard::verify-failed` yields `verify` and `failed`.
 */
function hasWord(t: string, word: string): boolean {
  return t.split(/[^a-z0-9]+/).includes(word);
}

/**
 * The human-applied triggers a watch loop polls for (`--spec-label` / `--agent-label` defaults,
 * src/cli/args.ts:362-363). Separator-tolerant so `ready-for-spec` reads the same; bounded both
 * sides so `ready for speccing` is NOT a trigger.
 */
const TRIGGER_SOURCE = String.raw`(?<![a-z0-9])ready[^a-z0-9]+for[^a-z0-9]+(?:spec|agent)(?![a-z0-9])`;
const TRIGGER_STRIP = new RegExp(TRIGGER_SOURCE, 'g'); // replace() — never .test() (lastIndex)
const TRIGGER_MATCH = new RegExp(TRIGGER_SOURCE); // predicate — no /g, so stateless

/** True if `label` is one of the factory trigger labels (`ready for agent` / `ready for spec`). */
export function isTriggerLabel(label: string): boolean {
  return TRIGGER_MATCH.test(label.toLowerCase());
}

/**
 * Best-effort mapping of a task's state/labels to a board column, following Vanguard's real label
 * vocabulary (`vanguard:running`, `vanguard::verify-failed`, `vanguard:speccing`,
 * `vanguard::secret-blocked`, Linear states). A TERMINAL state wins first: a closed issue whose
 * active label was never cleared (`"vanguard:running closed"`) belongs in Done, not Running.
 * `secret-blocked` stays a qualified `includes` so a generic dependency-`blocked` label is ignored.
 */
export function columnFor(text: string): 'queued' | 'claimed' | 'running' | 'verify-failed' | 'review' | 'done' {
  // Trigger labels are a HUMAN request, not a claim: drop them before the word scan, or
  // `ready for spec` matches the `spec` rule meant for `vanguard:speccing` and a waiting task
  // reads as taken. Lifecycle labels and terminal states still win — they survive the strip.
  const t = text.toLowerCase().replace(TRIGGER_STRIP, ' ');
  const w = (word: string): boolean => hasWord(t, word);
  if (w('done') || w('closed') || w('merged') || w('complete') || w('completed')) return 'done';
  if (w('running')) return 'running';
  if (w('verify') || w('failed') || t.includes('secret-blocked')) return 'verify-failed';
  // `reviewing`/`reviewed` are real GitLab MR labels — whole-word `review` alone would miss them.
  if (w('review') || w('reviewing') || w('reviewed') || t.includes('needs-human') || t.includes('needs human')) {
    return 'review';
  }
  if (w('spec') || w('speccing') || w('claim') || w('claimed') || w('doing') || t.includes('in progress') || t.includes('in-progress')) {
    return 'claimed';
  }
  return 'queued';
}

/** Mint the board id from source + provider-native ref: `gh-904` / `gl-42` / `linear-dev-639`. */
export function mintBoardId(source: BoardSource, ref: string): string {
  if (source === 'linear') return `linear-${ref.toLowerCase()}`;
  return `${source === 'github' ? 'gh' : 'gl'}-${ref}`;
}

/** A board/run-record taskId resolved back to its source and the ref the provider CLI wants. */
export interface ResolvedTaskRef {
  source: BoardSource;
  reference: string;
}

function trailingNumber(s: string): string | undefined {
  const m = /(\d+)$/.exec(s);
  return m?.[1];
}

/**
 * Resolve a taskId to `(source, ref)` using the prefix conventions the runners mint. TRAILING-NUMBER
 * semantics, not strict `source+ref` (S9 spec §2.4): run records mint `gh-<sanitized full id>`
 * (`gh-owner-repo-904`), and RunDetail's spec tab passes THOSE ids — both forms must resolve.
 * `linear-dev-639` → DEV-639 (runners lowercase the identifier on the way in).
 */
export function resolveTaskRef(taskId: string): ResolvedTaskRef | undefined {
  const lower = taskId.toLowerCase();
  if (lower.startsWith('linear-')) {
    const rest = lower.slice('linear-'.length);
    if (rest === '') return undefined;
    return { source: 'linear', reference: rest.toUpperCase() };
  }
  if (lower.startsWith('gh-')) {
    const n = trailingNumber(taskId);
    return n === undefined ? undefined : { source: 'github', reference: n };
  }
  if (lower.startsWith('gl-')) {
    const n = trailingNumber(taskId);
    return n === undefined ? undefined : { source: 'gitlab', reference: n };
  }
  return undefined;
}

/**
 * Map a fetched core Task to its board card. The chip ("display state") rule is PER-PROVIDER
 * (S9 spec §2.6): github/gitlab show the first label else the provider state; Linear ALWAYS shows
 * the workflow state, even with labels present. The column folds labels + state either way
 * (a vanguard lifecycle label overrides Linear's workflow state for the column).
 */
export function toBoardTask(source: BoardSource, task: Task): BoardTask {
  const state = task.state ?? '';
  const combined = `${task.labels.join(' ')} ${state}`;
  const column = columnFor(combined);
  // Waiting = a human asked for the factory and nothing has claimed it yet. LABEL-sourced, not
  // state-sourced: the flag answers "is this queued for a trigger-label watch loop".
  const waiting = column === 'queued' && task.labels.some(isTriggerLabel);
  return {
    id: mintBoardId(source, task.ref ?? task.id),
    title: task.title,
    column,
    state: source === 'linear' ? state : (task.labels[0] ?? state),
    ...(waiting ? { waiting: true } : {}),
  };
}

/** Join board ids and run-record task ids using the existing provider reference rules. */
export function taskRefKey(taskId: string): string {
  const ref = resolveTaskRef(taskId);
  return ref === undefined ? taskId.toLowerCase() : mintBoardId(ref.source, ref.reference);
}
