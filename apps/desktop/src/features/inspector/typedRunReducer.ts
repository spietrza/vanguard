// RunEvent comes from the generated wire contract (S7 — no more hand-mirror). Re-exported because
// Inspector imports it from here.
import type { RunEvent } from '../../wire';
export type { RunEvent } from '../../wire';

type StagePhase = 'pending' | 'running' | 'done' | 'failed';

export interface TypedRunState {
  runId?: string;
  taskId?: string;
  flow?: string;
  provider?: string;
  stages: string[];
  stageState: Record<number, StagePhase>;
  usdSpent: number;
  /** Non-fatal advisories (e.g. a credential the LLM proxy doesn't cover) — accumulated, deduplicated, never cleared. */
  warnings: string[];
  terminal?: { kind: 'success' | 'no-changes' | 'secret-blocked' | 'error' | 'cancelled'; prUrl?: string; message?: string };
}

/** `run-accepted` is Rust-minted (sidecar.rs) and never core-emitted, so it is a DESKTOP extension
 *  of the wire union, not part of it. It carries the run's repoPath so a strip can refuse a run
 *  that belongs to another project (S8 item 4). */
export type AppRunEvent = RunEvent | { type: 'run-accepted'; repoPath?: string };
type Incoming = AppRunEvent;

export function initialTypedRun(): TypedRunState {
  return { stages: [], stageState: {}, usdSpent: 0, warnings: [] };
}

/**
 * Fold one `{runId, event}` payload, last-write-wins per key. Foreign runIds are dropped.
 * `repoPath` (when given) scopes the strip to one project: only a `run-accepted` whose repoPath
 * matches may ADOPT a runId into a virgin state — any other event on a virgin state is dropped.
 * Without this a foreign run's mid-flight `stage-start` would seed a strip in the wrong project
 * even with the backlog fold skipped (S8 item 4 — accept-time filtering alone is insufficient).
 */
export function reduceTypedRun(
  state: TypedRunState,
  payload: { runId: string; event: Incoming },
  repoPath?: string,
): TypedRunState {
  const e = payload.event;
  if (state.runId === undefined) {
    // Virgin state: only an accepted marker for OUR project may seed it. A scoped strip also
    // rejects an accepted marker with NO repoPath — Rust always stamps it, so an unstamped one is
    // a stale/foreign source, not a legitimate run (defensive, review #343 obs 3).
    if (e.type !== 'run-accepted') return state;
    if (repoPath !== undefined && e.repoPath !== repoPath) return state;
    return { ...state, runId: payload.runId };
  }
  if (payload.runId !== state.runId) return state;
  const runId = state.runId;
  switch (e.type) {
    case 'run-accepted':
      return { ...state, runId };
    case 'run-start':
      return { ...state, runId, taskId: e.taskId, flow: e.flow, provider: e.provider, stages: e.stages };
    case 'stage-start':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: 'running' } };
    case 'stage-end':
      return { ...state, runId, stageState: { ...state.stageState, [e.index]: e.outcome === 'completed' ? 'done' : 'failed' } };
    case 'cost':
      return { ...state, runId, usdSpent: e.usdSpent }; // cumulative — last wins, never sum
    case 'warning':
      // Idempotent: backlog and live events overlap on re-attach, so the same warning can arrive twice.
      if (state.warnings.includes(e.message)) return { ...state, runId };
      return { ...state, runId, warnings: [...state.warnings, e.message] };
    case 'run-end':
      return {
        ...state,
        runId,
        terminal:
          e.prUrl !== undefined
            ? { kind: 'success', prUrl: e.prUrl }
            : e.secretBlocked === true
              ? { kind: 'secret-blocked' }
              : { kind: 'no-changes' },
      };
    case 'run-error':
      return { ...state, runId, terminal: { kind: 'error', message: e.message } };
    case 'run-cancelled':
      return { ...state, runId, terminal: { kind: 'cancelled' } };
    default:
      return state;
  }
}

/**
 * Fold one LIVE event into a possibly-absent strip. Distinct from reduceTypedRun because the
 * component's state is `TypedRunState | null` and null must STAY null when the reducer declines
 * to adopt (foreign/non-accepted event on a virgin strip): materializing `initialTypedRun()`
 * anyway would hide the foreign-run note and render an empty strip — the bleed in blank form
 * (review #343 round 3, blocking).
 */
export function foldLiveEvent(
  prev: TypedRunState | null,
  payload: { runId: string; event: Incoming },
  repoPath?: string,
): TypedRunState | null {
  const next = reduceTypedRun(prev ?? initialTypedRun(), payload, repoPath);
  return prev === null && next.runId === undefined ? prev : next;
}
