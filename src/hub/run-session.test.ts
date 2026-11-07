import { describe, expect, test } from 'vitest';
import { createRunSession, MAX_CONCURRENT_RUNS } from './run-session.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from '../sidecar/sidecar.js';
import type { RunEvent } from '../pipeline/events.js';

function fakeDeps(createRun: SidecarDeps['createRun']): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: unimplemented,
    createRun,
    createTask: unimplemented,
    listFlows: unimplemented,
    listProviders: unimplemented,
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: unimplemented,
    fetchSpec: unimplemented,
    listRepoFiles: unimplemented,
    readRepoFile: unimplemented,
    listRuns: unimplemented,
    readRun: unimplemented,
  };
}

function collectPublished(): { name: string; payload: unknown }[] {
  return [];
}

describe('run-session', () => {
  test('T-42 run-accepted is the first event and carries repoPath', async () => {
    const published: { name: string; payload: unknown }[] = collectPublished();
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return { prUrl: 'https://pr/1' };
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    expect(published[0]?.payload).toMatchObject({ event: { type: 'run-accepted', repoPath: '/repo' } });
  });

  test('T-43 blank/absent repoPath is rejected before a runId is minted', async () => {
    const deps = fakeDeps(async () => ({}));
    const published: unknown[] = [];
    const session = createRunSession(deps, (_n, p) => published.push(p));
    await expect(session.createRun({ issueRef: '1', repoPath: '  ' } as CreateRunParams)).rejects.toThrow(
      /repoPath is required/,
    );
    expect(published).toHaveLength(0);
    expect(session.activeRun()).toBeNull();
  });

  test('T-44 second concurrent run rejected, first unaffected', async () => {
    let resolveFirst: ((r: CreateRunResult) => void) | undefined;
    const deps = fakeDeps(
      (_params) =>
        new Promise<CreateRunResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const session = createRunSession(deps, () => {});
    const firstPromise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    // allow the first call's synchronous prologue to run
    await Promise.resolve();
    expect(session.activeRun()).not.toBeNull();
    const firstActive = session.activeRun();

    await expect(session.createRun({ issueRef: '2', repoPath: '/repo2' } as CreateRunParams)).rejects.toThrow(
      /single-in-flight/,
    );
    expect(session.activeRun()).toEqual(firstActive);

    resolveFirst?.({});
    await firstPromise;
    expect(MAX_CONCURRENT_RUNS).toBe(1);
  });

  test('T-45 success emits exactly one terminal (run-end from the stream, none synthesized)', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end', prUrl: 'https://pr/9' } as RunEvent);
      return { prUrl: 'https://pr/9' };
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const terminals = published.filter((p) => {
      const t = (p.payload as { event?: { type?: string } }).event?.type;
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
    expect(terminals).toHaveLength(1);
    expect((terminals[0]?.payload as { event: { type: string } }).event.type).toBe('run-end');
  });

  test('T-46 a thrown outcome synthesizes run-error', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async () => {
      throw new Error('boom');
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow('boom');
    const terminal = published.at(-1)?.payload as { event: { type: string; message?: string } };
    expect(terminal.event).toEqual({ type: 'run-error', message: 'boom' });
  });

  test('T-47 a cancelled run synthesizes run-cancelled', async () => {
    const published: { name: string; payload: unknown }[] = [];
    let onEventRef: ((e: RunEvent) => void) | undefined;
    const deps = fakeDeps(
      (_params, onEvent) =>
        new Promise<CreateRunResult>((_resolve, reject) => {
          onEventRef = onEvent;
          setTimeout(() => reject(new Error('aborted')), 0);
        }),
    );
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    const promise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    await Promise.resolve();
    session.cancel();
    void onEventRef;
    await expect(promise).rejects.toThrow('aborted');
    const terminal = published.at(-1)?.payload as { event: { type: string } };
    expect(terminal.event).toEqual({ type: 'run-cancelled' });
  });

  test('T-48 no second terminal after a streamed run-end followed by a teardown throw', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      throw new Error('teardown blew up after run-end');
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow();
    const terminals = published.filter((p) => {
      const t = (p.payload as { event?: { type?: string } }).event?.type;
      return t === 'run-end' || t === 'run-error' || t === 'run-cancelled';
    });
    expect(terminals).toHaveLength(1);
    expect((terminals[0]?.payload as { event: { type: string } }).event.type).toBe('run-end');
  });

  test('T-49 buffer eviction drops index 1 and retains run-accepted', async () => {
    const deps = fakeDeps(async (_params, onEvent) => {
      for (let i = 0; i < 2010; i += 1) onEvent({ type: 'cost', usdSpent: i } as unknown as RunEvent);
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, () => {});
    // Read the minted runId SYNCHRONOUSLY, right after the call: createRun runs synchronously up to
    // its first internal `await`, so `activeRun()` is already populated with no need to yield first
    // (yielding here races against the run's own completion for a deps fake with no internal awaits).
    const promise = session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    const runId = session.activeRun()?.runId ?? '';
    await promise;
    const backlog = session.backlog(runId) as { event: { type: string } }[];
    expect(backlog.length).toBe(2000);
    expect(backlog[0]?.event.type).toBe('run-accepted');
  });

  test('T-50 RETAINED_RUNS eviction of completed runs', async () => {
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, () => {});
    const runIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const promise = session.createRun({ issueRef: String(i), repoPath: '/repo' } as CreateRunParams);
      const id = session.activeRun()?.runId;
      await promise;
      if (id !== undefined) runIds.push(id);
    }
    // The first two of six runs should have been evicted (RETAINED_RUNS=4).
    expect(session.backlog(runIds[0] as string)).toEqual([]);
    expect(session.backlog(runIds[1] as string)).toEqual([]);
    expect(session.backlog(runIds[5] as string).length).toBeGreaterThan(0);
  });

  test('T-51 active is cleared on a throw', async () => {
    const deps = fakeDeps(async () => {
      throw new Error('boom');
    });
    const session = createRunSession(deps, () => {});
    await expect(session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams)).rejects.toThrow();
    expect(session.activeRun()).toBeNull();
  });

  test('T-52 a finished runs stale cancel flag cannot land on the next runs terminal', async () => {
    const published: { name: string; payload: unknown }[] = [];
    const deps = fakeDeps(async (_params, onEvent) => {
      onEvent({ type: 'run-end' } as RunEvent);
      return {};
    });
    const session = createRunSession(deps, (name, payload) => published.push({ name, payload }));
    await session.createRun({ issueRef: '1', repoPath: '/repo' } as CreateRunParams);
    // cancel() while idle must not affect the NEXT run.
    session.cancel();
    published.length = 0;
    await session.createRun({ issueRef: '2', repoPath: '/repo' } as CreateRunParams);
    const terminal = published.at(-1)?.payload as { event: { type: string } };
    expect(terminal.event.type).toBe('run-end');
  });

  test('T-53 cancel() while idle is a no-op', () => {
    const session = createRunSession(fakeDeps(async () => ({})), () => {});
    expect(() => session.cancel()).not.toThrow();
    expect(session.activeRun()).toBeNull();
  });
});

