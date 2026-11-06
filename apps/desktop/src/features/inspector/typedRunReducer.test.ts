import { describe, expect, it } from 'vitest';
import { foldLiveEvent, initialTypedRun, reduceTypedRun } from './typedRunReducer';

const ev = (runId: string, event: unknown): Parameters<typeof reduceTypedRun>[1] =>
  ({ runId, event }) as Parameters<typeof reduceTypedRun>[1];

describe('reduceTypedRun', () => {
  it('adopts runId/taskId/stages and steps stage phases last-wins', () => {
    let s = initialTypedRun();
    s = reduceTypedRun(s, ev('r1', { type: 'run-accepted' }));
    expect(s.runId).toBe('r1');
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'default', provider: 'claude', stages: ['implementer', 'reviewer'] }));
    expect(s.taskId).toBe('t1');
    expect(s.stages).toEqual(['implementer', 'reviewer']);
    expect(s.stageState).toEqual({});
    s = reduceTypedRun(s, ev('r1', { type: 'stage-start', name: 'implementer', index: 0, of: 2 }));
    expect(s.stageState[0]).toBe('running');
    s = reduceTypedRun(s, ev('r1', { type: 'stage-end', name: 'implementer', index: 0, of: 2, outcome: 'completed' }));
    expect(s.stageState[0]).toBe('done');
  });

  it('cost is last-wins (cumulative), not summed', () => {
    let s = reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' }));
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.02 }));
    s = reduceTypedRun(s, ev('r1', { type: 'cost', usdSpent: 0.05 }));
    expect(s.usdSpent).toBe(0.05);
  });

  it('warnings accumulate rather than last-wins', () => {
    let s = reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' }));
    s = reduceTypedRun(s, ev('r1', { type: 'warning', message: 'first' }));
    s = reduceTypedRun(s, ev('r1', { type: 'warning', message: 'second' }));
    expect(s.warnings).toEqual(['first', 'second']);
  });

  // S8 item 4 — the narrowed adoption rule: accept-time filtering alone was insufficient because
  // ANY first event used to adopt a runId into a virgin strip.
  it('a virgin strip refuses every event except run-accepted (foreign mid-flight events cannot seed it)', () => {
    const virgin = initialTypedRun();
    for (const e of [
      { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] },
      { type: 'stage-start', name: 'a', index: 0, of: 1 },
      { type: 'cost', usdSpent: 1 },
      { type: 'run-end' },
    ] as const) {
      expect(reduceTypedRun(virgin, ev('rA', e as never))).toBe(virgin);
    }
    expect(reduceTypedRun(virgin, ev('rA', { type: 'run-accepted' })).runId).toBe('rA');
  });

  it("a run-accepted for ANOTHER project's repoPath does not adopt when the strip is scoped", () => {
    const virgin = initialTypedRun();
    const foreign = reduceTypedRun(virgin, ev('rA', { type: 'run-accepted', repoPath: '/other' }), '/mine');
    expect(foreign).toBe(virgin);
    const ours = reduceTypedRun(virgin, ev('rA', { type: 'run-accepted', repoPath: '/mine' }), '/mine');
    expect(ours.runId).toBe('rA');
  });

  it('is idempotent on replay (backlog + live overlap)', () => {
    const seq = [
      ev('r1', { type: 'run-accepted' }),
      ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }),
      ev('r1', { type: 'stage-start', name: 'a', index: 0, of: 1 }),
      ev('r1', { type: 'cost', usdSpent: 0.03 }),
    ];
    let s = initialTypedRun();
    for (const e of seq) s = reduceTypedRun(s, e);
    let s2 = initialTypedRun();
    for (const e of [...seq, ...seq]) s2 = reduceTypedRun(s2, e);
    expect(s2).toEqual(s);
  });

  it('drops payloads from a different runId', () => {
    let s = reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' }));
    s = reduceTypedRun(s, ev('r1', { type: 'run-start', taskId: 't1', flow: 'f', provider: 'p', stages: ['a'] }));
    s = reduceTypedRun(s, ev('r2', { type: 'cost', usdSpent: 99 }));
    expect(s.usdSpent).toBe(0);
  });

  it('maps every terminal', () => {
    const t = (event: unknown): TypedRunTerminal =>
      reduceTypedRun(reduceTypedRun(initialTypedRun(), ev('r1', { type: 'run-accepted' })), ev('r1', event)).terminal;
    expect(t({ type: 'run-end', prUrl: 'x' })).toEqual({ kind: 'success', prUrl: 'x' });
    expect(t({ type: 'run-end', secretBlocked: true })).toEqual({ kind: 'secret-blocked' });
    expect(t({ type: 'run-end' })).toEqual({ kind: 'no-changes' });
    expect(t({ type: 'run-error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(t({ type: 'run-cancelled' })).toEqual({ kind: 'cancelled' });
  });
});

type TypedRunTerminal = ReturnType<typeof reduceTypedRun>['terminal'];

// S7: run-accepted stays a desktop extension of the wire RunEvent — this pins the TYPE accepts it
// (the runtime folds above already exercise it).
import type { AppRunEvent } from './typedRunReducer';
const _accepted: AppRunEvent = { type: 'run-accepted' };
void _accepted;

// r3 blocking: a foreign event must not MATERIALIZE an empty strip out of null — that hides the
// foreign-run note and renders a blank panel (the bleed in blank form).
it('foldLiveEvent keeps null null when the reducer declines to adopt', () => {
  expect(foldLiveEvent(null, ev('rA', { type: 'stage-start', name: 'a', index: 0, of: 1 }), '/mine')).toBeNull();
  expect(foldLiveEvent(null, ev('rA', { type: 'run-accepted', repoPath: '/other' }), '/mine')).toBeNull();
  const adopted = foldLiveEvent(null, ev('rA', { type: 'run-accepted', repoPath: '/mine' }), '/mine');
  expect(adopted?.runId).toBe('rA');
  // and a non-null strip keeps folding normally
  const stepped = foldLiveEvent(adopted, ev('rA', { type: 'cost', usdSpent: 1 }), '/mine');
  expect(stepped?.usdSpent).toBe(1);
});
