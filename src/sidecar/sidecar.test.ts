import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { VanguardError } from '../core/errors.js';
import { assertFlowResolvable, FlowError } from '../flows/repo.js';
import { runSidecar, type SidecarDeps } from './sidecar.js';
import type { RunEvent } from '../pipeline/events.js';

async function* lines(...ls: string[]): AsyncIterable<string> {
  for (const l of ls) yield l;
}

function collect(): { write: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { write: (l) => out.push(l), out };
}

const stubDeps = (over: Partial<SidecarDeps> = {}): SidecarDeps => ({
  capabilities: () => ({ providers: ['claude'], flows: [{ name: 'default', label: 'D' }], stages: ['planner'], transports: ['github', 'gitlab', 'linear'], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } }),
  createRun: async (_params, onEvent): Promise<{ prUrl?: string }> => {
    onEvent({ type: 'stage-start', name: 'implementer', index: 0, of: 1 } as RunEvent);
    return { prUrl: 'https://example/pr/1' };
  },
  createTask: async () => ({ id: 'o/r#1', url: 'https://example/issues/1' }),
  listFlows: async () => ({ flows: [] }),
  listProviders: async () => ({ providers: [] }),
  readFlow: async () => ({ doc: { name: 'f', label: 'L', stages: [{ name: 'planner', overrides: {} }], loops: [] }, source: 'flow "f" {}' }),
  writeFlow: async () => ({ source: 'flow "f" {}' }),
  deleteFlow: async () => ({}),
  listTasks: async () => ({ tasks: [], capped: false }),
  fetchSpec: async () => ({ spec: '# t' }),
  listRepoFiles: async () => ({ files: [], capped: false }),
  readRepoFile: async () => ({ path: 'x', content: '', truncated: false }),
  listRuns: async () => [],
  readRun: async () => ({ taskId: 't', timestamp: 'ts', stages: [] }),
  ...over,
});

describe('runSidecar', () => {
  it('answers capabilities with a correlated result line', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'c1', method: 'capabilities' })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0].id).toBe('c1');
    expect(parsed[0].result.providers).toEqual(['claude']);
  });

  it('streams events then a result for createRun', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'r1', method: 'createRun', params: { issueRef: 'gh-1', repoPath: '/repo', flow: 'default', provider: 'claude' } })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ id: 'r1', event: { type: 'stage-start' } });
    expect(parsed[1]).toMatchObject({ id: 'r1', result: { prUrl: 'https://example/pr/1' } });
  });

  it('returns an error line for malformed JSON, does not throw', async () => {
    const { write, out } = collect();
    await runSidecar(lines('{not json'), write, stubDeps());
    expect(JSON.parse(out[0]!).error.kind).toBe('bad-request');
  });

  it('returns an error line for an unknown method', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'x', method: 'nope' })), write, stubDeps());
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'x', error: { kind: 'bad-request' } });
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'rejects inherited method %s as unknown', async (method) => {
      const { write, out } = collect();
      await runSidecar(lines(JSON.stringify({ id: 'x', method })), write, stubDeps());
      expect(JSON.parse(out[0]!)).toEqual({
        id: 'x', error: { kind: 'bad-request', message: 'unknown method: ' + method },
      });
    },
  );

  it.each([null, [], 1, { id: 'x', method: { toString: null } }, { id: 'x', method: ['capabilities'] }])(
    'rejects malformed request %j and keeps serving requests', async (request) => {
      const { write, out } = collect();
      await runSidecar(
        lines(JSON.stringify(request), JSON.stringify({ id: 'next', method: 'capabilities' })),
        write, stubDeps(),
      );
      expect(out).toHaveLength(2);
      expect(JSON.parse(out[0]!).error.kind).toBe('bad-request');
      expect(JSON.parse(out[1]!)).toMatchObject({ id: 'next', result: { providers: ['claude'] } });
    },
  );

  it('dispatches deleteFlow through the validator (absolute repoPath + flow-file grammar)', async () => {
    const { write, out } = collect();
    let deleted: unknown = null;
    const deps = stubDeps({
      deleteFlow: async (params): Promise<Record<string, never>> => {
        deleted = params;
        return {};
      },
    });
    await runSidecar(
      lines(
        JSON.stringify({ id: 'd1', method: 'deleteFlow', params: { repoPath: '/repo', file: 'x.hcl' } }),
        JSON.stringify({ id: 'd2', method: 'deleteFlow', params: { repoPath: 'relative', file: 'x.hcl' } }),
        JSON.stringify({ id: 'd3', method: 'deleteFlow', params: { repoPath: '/repo', file: '../evil.hcl' } }),
      ),
      write,
      deps,
    );
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ id: 'd1', result: {} });
    expect(deleted).toEqual({ repoPath: '/repo', file: 'x.hcl' });
    expect(parsed[1]).toMatchObject({ id: 'd2', error: { kind: 'bad-request' } });
    expect(parsed[2]).toMatchObject({ id: 'd3', error: { kind: 'bad-request' } });
  });

  // S6 churn: provider is shape-checked only at the protocol boundary (repo customs are legal
  // values this sync validator cannot see); unknown-NAME rejection now lives in the createRun dep
  // (resolveRunChoice — deps.test.ts asserts it fires before beginRun). Blank still dies here.
  it('rejects a blank provider as bad-request, without invoking createRun', async () => {
    const { write, out } = collect();
    let called = false;
    const deps = stubDeps({
      createRun: async (): Promise<{ prUrl?: string }> => {
        called = true;
        return {};
      },
    });
    await runSidecar(lines(JSON.stringify({ id: 'p', method: 'createRun', params: { issueRef: 'gh-1', repoPath: '/repo', provider: '  ' } })), write, deps);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'p', error: { kind: 'bad-request' } });
    expect(called).toBe(false);
  });

  it.each([
    ['unknown transport', { issueRef: 'gh-1', repoPath: '/repo', transport: 'gitub' }],
    ['blank flow', { issueRef: 'gh-1', repoPath: '/repo', flow: '  ' }],
    ['non-string flow', { issueRef: 'gh-1', repoPath: '/repo', flow: 7 }],
    ['non-numeric maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: 'abc' }],
    ['non-positive maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: -5 }],
    ['fractional maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: 2.5 }],
    ['non-string baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: 42 }],
    ['blank baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: '  ' }],
    ['option-like baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: '--upload-pack=false' }],
    ['refspec baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: 'feature:main' }],
    ['force-refspec baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: '+main' }],
    ['empty issueRef', { issueRef: '' }],
    ['whitespace issueRef', { issueRef: '  \n ' }],
    ['missing issueRef', {}],
    ['missing repoPath', { issueRef: 'gh-1' }],
    ['blank repoPath', { issueRef: 'gh-1', repoPath: '  ' }],
  ])('rejects %s as bad-request', async (_label, params) => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'b', method: 'createRun', params })), write, stubDeps());
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'b', error: { kind: 'bad-request' } });
  });

  it('names only the type of a non-string baseBranch, not its value', async () => {
    const { write, out } = collect();
    const params = { issueRef: 'gh-1', repoPath: '/repo', baseBranch: Array.from({ length: 1000 }, () => 'x') };
    await runSidecar(lines(JSON.stringify({ id: 'b', method: 'createRun', params })), write, stubDeps());
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'b', error: { kind: 'bad-request', message: 'baseBranch must be a string, got array' } });
  });

  // Flow validation moved out of the sync validator (repo .hcl flows are legal values it cannot
  // see): resolvability is the dep's FIRST act, before any run machinery. Composed here exactly
  // like productionDeps composes it, with tmpdir() as a real repo that has no flows.
  it.each([
    ['an unknown flow', 'nope'],
    ['a prototype-key flow (Object.hasOwn regression)', 'toString'],
  ])('createRun with %s is bad-request and never reaches the run body', async (_label, flow) => {
    let reached = false;
    const deps = stubDeps({
      createRun: async (params): Promise<{ prUrl?: string }> => {
        if (params.flow !== undefined) await assertFlowResolvable(params.flow, params.repoPath);
        reached = true; // stands in for beginRun() + the sandbox — nothing below the assert may run
        return {};
      },
    });
    const { write, out } = collect();
    await runSidecar(
      lines(JSON.stringify({ id: 'ff', method: 'createRun', params: { issueRef: 'gh-1', repoPath: tmpdir(), flow } })),
      write,
      deps,
    );
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'ff', error: { kind: 'bad-request' } });
    expect(JSON.parse(out[0]!).error.message).toMatch(new RegExp(`unknown flow "${flow}"`));
    expect(reached).toBe(false);
  });
});

describe('flow-file methods over the protocol (S5)', () => {
  const req = (method: string, params: Record<string, unknown>): string => JSON.stringify({ id: 'f', method, params });
  const DOC = { name: 'my-flow', label: 'Mine', stages: [{ name: 'planner', overrides: {} }], loops: [] };

  it('listFlows/readFlow/writeFlow answer with correlated results', async () => {
    const { write, out } = collect();
    await runSidecar(
      lines(
        req('listFlows', { repoPath: '/abs' }),
        req('readFlow', { repoPath: '/abs', file: 'my-flow.hcl' }),
        req('writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: DOC }),
      ),
      write,
      stubDeps(),
    );
    expect(JSON.parse(out[0]!)).toEqual({ id: 'f', result: { flows: [] } });
    expect(JSON.parse(out[1]!).result.doc.name).toBe('f');
    expect(JSON.parse(out[2]!).result.source).toContain('flow');
  });

  it('passes the COERCED doc to the dep — the clean rebuild is what gets emitted', async () => {
    let received: unknown;
    const deps = stubDeps({
      writeFlow: async ({ doc }): Promise<{ source: string }> => {
        received = doc;
        return { source: 's' };
      },
    });
    const { write } = collect();
    await runSidecar(lines(req('writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: DOC })), write, deps);
    expect(received).toEqual(DOC);
  });

  it.each([
    ['a relative repoPath', 'listFlows', { repoPath: 'repo' }],
    ['a blank repoPath', 'listFlows', { repoPath: ' ' }],
    ['a traversal filename', 'readFlow', { repoPath: '/abs', file: '../x.hcl' }],
    ['an uppercase filename', 'readFlow', { repoPath: '/abs', file: 'My.hcl' }],
    ['a non-hcl filename', 'readFlow', { repoPath: '/abs', file: 'x.md' }],
    ['an unknown stage key (silent-drop class)', 'writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: { ...DOC, stages: [{ name: 'planner', overrides: {}, timeoutMs: 5 }] } }],
    ['an unknown override key', 'writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: { ...DOC, stages: [{ name: 'planner', overrides: { foo: 1 } }] } }],
    ['a zero-stage doc', 'writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: { ...DOC, stages: [] } }],
    ['an unknown stage name', 'writeFlow', { repoPath: '/abs', file: 'my-flow.hcl', doc: { ...DOC, stages: [{ name: 'nope', overrides: {} }] } }],
    ['a filename ≠ flow name', 'writeFlow', { repoPath: '/abs', file: 'other.hcl', doc: DOC }],
    ['a built-in name collision', 'writeFlow', { repoPath: '/abs', file: 'plan.hcl', doc: { ...DOC, name: 'plan' } }],
  ])('rejects %s as bad-request without invoking the dep', async (_label, method, params) => {
    let called = false;
    const deps = stubDeps({
      listFlows: async (): Promise<{ flows: [] }> => ((called = true), { flows: [] }),
      readFlow: async (): Promise<never> => {
        called = true;
        throw new Error('unreachable');
      },
      writeFlow: async (): Promise<never> => {
        called = true;
        throw new Error('unreachable');
      },
    });
    const { write, out } = collect();
    await runSidecar(lines(req(method, params)), write, deps);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'f', error: { kind: 'bad-request' } });
    expect(called).toBe(false);
  });

  it('classifies FlowError and VanguardError as bad-request and other errors as internal', async () => {
    const { write, out } = collect();
    await runSidecar(
      lines(req('readFlow', { repoPath: '/abs', file: 'a.hcl' }), req('readFlow', { repoPath: '/abs', file: 'b.hcl' }), req('readFlow', { repoPath: '/abs', file: 'c.hcl' })),
      write,
      stubDeps({
        readFlow: async ({ file }): Promise<never> => {
          if (file === 'a.hcl') throw new FlowError('expected exactly one flow block, found none');
          if (file === 'c.hcl') throw new VanguardError('unknown provider');
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    expect(JSON.parse(out[0]!).error).toEqual({ message: 'expected exactly one flow block, found none', kind: 'bad-request' });
    expect(JSON.parse(out[1]!).error.kind).toBe('internal');
    expect(JSON.parse(out[2]!).error).toEqual({ message: 'unknown provider', kind: 'bad-request' });
  });
});

describe('createTask over the protocol', () => {
  const req = (params: Record<string, unknown>): string => JSON.stringify({ id: 't', method: 'createTask', params });

  it('creates and returns the ref + url', async () => {
    const { write, out } = collect();
    await runSidecar(lines(req({ source: 'github', repoPath: '/repo', title: 'T', body: 'B' })), write, stubDeps());
    expect(JSON.parse(out[0] as string)).toEqual({ id: 't', result: { id: 'o/r#1', url: 'https://example/issues/1' } });
  });

  it('rejects a bad request WITHOUT creating anything — this write cannot be undone', async () => {
    let created = 0;
    const deps = stubDeps({
      createTask: async () => {
        created++;
        return { id: 'x', url: 'y' };
      },
    });
    const { write, out } = collect();
    await runSidecar(
      lines(
        req({ source: 'nope', repoPath: '/r', title: 'T', body: 'B' }), // unknown transport
        req({ source: 'github', repoPath: '/r', title: '  ', body: 'B' }), // blank title
        req({ source: 'linear', repoPath: '/r', title: 'T', body: 'B' }), // linear with no team
      ),
      write,
      deps,
    );
    for (const line of out) expect(JSON.parse(line).error.kind).toBe('bad-request');
    expect(created).toBe(0); // nothing reached the transport
  });
});

describe('run-store protocol', () => {
  it.each(['listRuns', 'readRun'] as const)('%s forwards params and returns a correlated result', async (method) => {
    const params = method === 'listRuns' ? { repoPath: '/repo' } : { repoPath: '/repo', taskId: 't', timestamp: 'ts' };
    const result = method === 'listRuns' ? [{ taskId: 't', timestamp: 'ts', stages: [], totalCostUsd: 0, anyFailed: false }] : { taskId: 't', timestamp: 'ts', stages: [] };
    const dep = vi.fn(async () => result);
    const deps = stubDeps({ [method]: dep });
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'run', method, params })), write, deps);
    expect(dep).toHaveBeenCalledWith(params);
    expect(out.map((line) => JSON.parse(line))).toEqual([{ id: 'run', result }]);
  });

  const invalid = [
    ...[undefined, '', ' ', 'relative'].flatMap((repoPath) => [
      { method: 'listRuns', params: { repoPath } },
      { method: 'readRun', params: { repoPath, taskId: 't', timestamp: 'ts' } },
    ]),
    ...['../other', '..', 'a/b', 'a\\b', '', '/abs', undefined].map((taskId) => ({
      method: 'readRun', params: { repoPath: '/repo', taskId, timestamp: 'ts' },
    })),
    ...[undefined, '', ' '].map((timestamp) => ({
      method: 'readRun', params: { repoPath: '/repo', taskId: 't', timestamp },
    })),
  ];
  it.each(invalid)('rejects $method $params before dispatch', async ({ method, params }) => {
    const dep = vi.fn();
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'bad', method, params })), write, stubDeps({ [method]: dep }));
    expect(dep).not.toHaveBeenCalled();
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'bad', error: { kind: 'bad-request' } });
  });
});
