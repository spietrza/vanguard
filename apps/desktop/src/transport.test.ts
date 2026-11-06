import { test, expect, afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { invoke, isHubMode, subscribe, onStreamReset, onHubRestart, onHubConnectionIssue } from './transport';

/** Minimal fake EventSource — jsdom doesn't implement one. Tracks every instance so a test can
 * assert how many were actually constructed (the "one shared EventSource" guarantee). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closed = false;
  readyState = 1; // OPEN; 2 is CLOSED — the browser gave up reconnecting (e.g. a 401 on /events)
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }
  removeEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(cb);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data: unknown): void {
    const payload = { data: JSON.stringify(data) } as MessageEvent;
    for (const cb of this.listeners.get(name) ?? []) cb(payload);
  }
}

afterEach(() => {
  clearMocks();
  delete window.__VANGUARD_HUB__;
  delete window.__VANGUARD_HUB_TOKEN__;
  FakeEventSource.instances = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('T-89 mode resolution: window.__VANGUARD_HUB__ === true selects hub mode', () => {
  window.__VANGUARD_HUB__ = true;
  expect(isHubMode()).toBe(true);
});

test('T-89 mode resolution: the marker absent selects the Tauri branch', async () => {
  expect(isHubMode()).toBe(false);
  const captured: Record<string, unknown> = {};
  mockIPC((cmd, args) => {
    Object.assign(captured, { cmd, args });
    return { ok: true };
  });
  await invoke('list_runs', { repoPath: '/repo' });
  expect(captured.cmd).toBe('list_runs');
  expect(captured.args).toEqual({ repoPath: '/repo' });
});

test('T-90 hub invoke POSTs to /rpc/<cmd> with the args object and resolves result', async () => {
  window.__VANGUARD_HUB_TOKEN__ = 'test-token';
  window.__VANGUARD_HUB__ = true;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: { runs: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const result = await invoke('list_runs', { repoPath: '/repo' });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('/rpc/list_runs');
  expect(calls[0].init.method).toBe('POST');
  expect((calls[0].init.headers as Record<string, string>)['x-vanguard-hub-token']).toBe('test-token');
  expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  expect(JSON.parse(calls[0].init.body as string)).toEqual({ repoPath: '/repo' });
  expect(result).toEqual({ runs: [] });
});

test('T-91 an error body rejects with the message string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'repoPath is required', kind: 'bad-request' } }), { status: 400 }),
    ),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBe('repoPath is required');
  expect(typeof err).toBe('string');
  expect(String(err)).toBe('repoPath is required'); // matches Tauri's Err(String) rendering
});

test('T-92 a network failure rejects with a string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
  expect(err).toContain('Failed to fetch');
});

test('T-92b a non-JSON response also rejects with a string', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>not json</html>', { status: 200 })),
  );
  const err = await invoke('list_runs', {}).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(typeof err).toBe('string');
});

test('T-93 one shared EventSource, handlers routed by event name', async () => {
  window.__VANGUARD_HUB_TOKEN__ = 'a&b';
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const aEvents: unknown[] = [];
  const bEvents: unknown[] = [];
  const unlistenA = await subscribe<{ x: number }>('event-a', (e) => aEvents.push(e.payload));
  const unlistenB = await subscribe<{ y: number }>('event-b', (e) => bEvents.push(e.payload));

  expect(FakeEventSource.instances).toHaveLength(1); // shared, not one per subscriber
  const es = FakeEventSource.instances[0]!;
  expect(es.url).toBe('/events?token=a%26b');
  es.emit('event-a', { x: 1 });
  es.emit('event-b', { y: 2 });
  expect(aEvents).toEqual([{ x: 1 }]);
  expect(bEvents).toEqual([{ y: 2 }]);

  unlistenA();
  unlistenB();
});

test('T-94 unsubscribe closes the source when the last handler leaves', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const unlistenA = await subscribe('event-a', () => {});
  const unlistenB = await subscribe('event-b', () => {});
  const es = FakeEventSource.instances[0]!;

  unlistenA();
  expect(es.closed).toBe(false); // event-b's handler still live

  unlistenB();
  expect(es.closed).toBe(true);
});

test.each([null, {}, { projects: [] }])('hub invoke rejects malformed success body %j', async (body) => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  await expect(invoke('list_projects')).rejects.toBe('hub response body is missing "result"');
});

test.each([false, 0, '', null])('hub invoke preserves result %j', async (result) => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 })));
  await expect(invoke('list_projects')).resolves.toBe(result);
});

test('T-95 a stream-reset frame triggers every registered resync callback (#491)', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const calls: string[] = [];
  const unlistenA = await onStreamReset(() => calls.push('a'));
  const unlistenB = await onStreamReset(() => calls.push('b'));

  const es = FakeEventSource.instances[0]!;
  es.emit('stream-reset', {});
  expect(calls).toEqual(['a', 'b']);

  unlistenA();
  unlistenB();
});

test('T-96 a stream-reset also reaches a named subscription\'s resync sibling, not its own handler', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  const changed: unknown[] = [];
  const resyncs: number[] = [];
  const unlistenChanged = await subscribe<string>('vanguard:changed', (e) => changed.push(e.payload));
  const unlistenReset = await onStreamReset(() => resyncs.push(1));

  expect(FakeEventSource.instances).toHaveLength(1); // still one shared source
  const es = FakeEventSource.instances[0]!;
  es.emit('stream-reset', {});
  expect(resyncs).toEqual([1]);
  expect(changed).toEqual([]); // stream-reset never reaches a named handler as a payload

  es.emit('vanguard:changed', '/repo');
  expect(changed).toEqual(['/repo']);

  unlistenChanged();
  unlistenReset();
});

test('a permanently closed SSE stream probes before deciding: the hub\'s own token rejection notifies onHubRestart', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 }),
    ),
  );
  const restarts: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenSub = await subscribe('event-a', () => {});
  const es = FakeEventSource.instances[0]!;

  es.emit('error', {}); // still OPEN: a transient drop the browser retries on its own
  expect(restarts).toEqual([]);

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(restarts).toEqual([1]);

  unlistenSub();
  unlistenRestart();
});

test('a 403 on /events (the Host check, not the hub\'s own token) notifies onHubConnectionIssue, not onHubRestart', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Host not allowed', kind: 'bad-request' } }), { status: 403 }),
    ),
  );
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('event-a', () => {});
  const es = FakeEventSource.instances[0]!;

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);

  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('a network error probing /events (a proxy 502, connection dropped) notifies onHubConnectionIssue, not onHubRestart', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network error'); }));
  const restarts: number[] = [];
  const issues: number[] = [];
  const unlistenRestart = await onHubRestart(() => restarts.push(1));
  const unlistenIssue = await onHubConnectionIssue(() => issues.push(1));
  const unlistenSub = await subscribe('event-a', () => {});
  const es = FakeEventSource.instances[0]!;

  es.readyState = 2;
  es.emit('error', {});
  await new Promise((r) => setTimeout(r, 0));
  expect(issues).toEqual([1]);
  expect(restarts).toEqual([]);

  unlistenSub();
  unlistenIssue();
  unlistenRestart();
});

test('onHubConnectionIssue is a no-op outside hub mode', async () => {
  const unlisten = await onHubConnectionIssue(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});

test('a 401 from /rpc/<cmd> also notifies onHubRestart, and still rejects with the message', async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid hub token', kind: 'bad-request' } }), { status: 401 }),
    ),
  );
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));

  await expect(invoke('list_runs', {})).rejects.toBe('invalid hub token');
  expect(restarts).toEqual([1]);

  unlisten();
});

test("a 401 that isn't the hub's own envelope (a reverse proxy's) does not claim the hub restarted", async () => {
  window.__VANGUARD_HUB__ = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Unauthorized', kind: 'bad-request' } }), { status: 401 })),
  );
  const restarts: number[] = [];
  const unlisten = await onHubRestart(() => restarts.push(1));

  await expect(invoke('list_runs', {})).rejects.toBe('Unauthorized');
  expect(restarts).toEqual([]);

  unlisten();
});

test('onHubRestart is a no-op outside hub mode', async () => {
  const unlisten = await onHubRestart(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});

test('T-97 onStreamReset is a no-op outside hub mode', async () => {
  const unlisten = await onStreamReset(() => {
    throw new Error('must not be called under Tauri');
  });
  expect(() => unlisten()).not.toThrow();
});
