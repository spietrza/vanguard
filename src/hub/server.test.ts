import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createHubServer, MAX_RPC_BODY_BYTES, type HubServer } from './server.js';
import { listRunSummaries, defaultRunsRoot } from './runs.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';

function unimplementedDeps(): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: () => ({
      providers: ['claude'],
      flows: [],
      stages: [],
      transports: ['github'],
      defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
    }),
    createRun: unimplemented,
    createTask: unimplemented,
    listFlows: async () => ({ flows: [] }),
    listProviders: async () => ({ providers: [] }),
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: async () => ({ tasks: [], capped: false }),
    fetchSpec: unimplemented,
    listRepoFiles: async () => ({ files: [], capped: false }),
    readRepoFile: unimplemented,
  };
}

let repo: string;
let configDir: string;
let browseRoot: string;
let uiDir: string;
let hub: HubServer;
let baseUrl: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-server-repo-'));
  configDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-server-cfg-'));
  browseRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-server-browse-'));
  uiDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-server-ui-'));
  await writeFile(join(uiDir, 'index.html'), '<html><head></head><body>hi</body></html>');

  hub = createHubServer({
    uiDir,
    configDir,
    browseRoot,
    bind: { isLoopback: true, allowAdd: false },
    seedRepoPath: repo,
    version: '0.0.0-test',
    deps: unimplementedDeps(),
    allowedHosts: ['Hub.Example'],
  });
  await hub.listen(0, '127.0.0.1');
  const { port } = hub.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await hub.close();
  await rm(repo, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(browseRoot, { recursive: true, force: true });
  await rm(uiDir, { recursive: true, force: true });
});

/** `fetch` rewrites the `Host` header from the URL; node:http sends the one it is handed verbatim. */
function withHost(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(baseUrl + path, { headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('hub server', () => {
  test('rejects untrusted Hosts before disclosing the SPA token, allows explicit proxy Hosts', async () => {
    for (const path of ['/', '/healthz', '/rpc/list_runs', '/events']) {
      const res = await withHost(path, 'evil.example');
      expect(res.status).toBe(403);
      expect(res.body).not.toContain(hub.token);
    }
    expect((await withHost('/', 'hub.example')).status).toBe(200);
    expect((await withHost('/', 'hub.example:1234')).status).toBe(403);
  });

  test('an IP-literal Host on the bound port needs no --allowed-host (DNS rebinding cannot make one)', async () => {
    const { port } = hub.server.address() as AddressInfo;
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `0.0.0.0:${port}`, // what the browser sends for the URL `--host 0.0.0.0` prints and opens
      `192.168.7.5:${port}`, // a LAN / Tailscale address reached directly
      `[::1]:${port}`,
    ]) {
      const res = await withHost('/', host);
      expect(res.status, host).toBe(200);
      expect(res.body, host).toContain(hub.token);
    }
    for (const host of [
      `127.0.0.1:${port + 1}`, // right address, not the port this socket is bound to
      '127.0.0.1',
      '::1', // an IPv6 literal must be bracketed to be a Host
      `hub.internal:${port}`, // a hostname — only an explicit --allowed-host carries one
      `127.0.0.1:${port}x`,
    ]) {
      expect((await withHost('/', host)).status, host).toBe(403);
    }
  });

  test('requires the per-launch token for RPC and SSE, and only embeds it in the SPA', async () => {
    expect(hub.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await fetch(baseUrl)).text()).toContain(JSON.stringify(hub.token));
    expect(await (await fetch(baseUrl + '/healthz')).text()).not.toContain(hub.token);
    for (const token of ['', 'wrong', 'x'.repeat(64)]) {
      const rpc = await fetch(baseUrl + '/rpc/list_runs', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-vanguard-hub-token': token }, body: '{}',
      });
      expect(rpc.status).toBe(401);
      expect((await fetch(baseUrl + '/events?token=' + token)).status).toBe(401);
    }
    expect((await fetch(baseUrl + '/rpc/list_runs', { method: 'POST' })).status).toBe(401);
    expect((await fetch(baseUrl + '/events')).status).toBe(401);
    expect(hub.eventBus.clientCount).toBe(0);
  });

  test('serves the SPA and survives malformed URL escapes', async () => {
    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('__VANGUARD_HUB__');
    expect((await fetch(baseUrl + '/%ZZ')).status).toBe(404);
    expect((await fetch(baseUrl + '/healthz')).status).toBe(200);
  });

  test('rejects lookalike JSON media types', async () => {
    const response = await fetch(baseUrl + '/rpc/list_runs', {
      method: 'POST', headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/jsonp' }, body: '{}',
    });
    expect(response.status).toBe(400);
  });

  test('same-origin check compares host, not scheme: accepts a matching Host, rejects non-HTTP schemes, garbage, and mismatched hosts', async () => {
    const { host, port } = new URL(baseUrl);
    const cases: Array<[origin: string, expectedStatus: number]> = [
      [baseUrl.replace('http:', 'https:'), 200],
      ['null', 400],
      ['not a URL', 400],
      [`ftp://${host}`, 400],
      [`ws://${host}`, 400],
      [`https://127.0.0.1:${Number(port) === 65535 ? 65534 : Number(port) + 1}`, 400],
    ];
    for (const [origin, expectedStatus] of cases) {
      const res = await fetch(baseUrl + '/rpc/list_runs', {
        method: 'POST',
        headers: { 'x-vanguard-hub-token': hub.token, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: repo }),
      });
      expect(res.status, origin).toBe(expectedStatus);
      if (expectedStatus === 400) {
        expect(await res.json()).toMatchObject({ error: { message: 'cross-origin request rejected' } });
      }
    }
  });

  test('T-80 GET /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.0.0-test' });
  });

  test('T-81 POST /rpc/list_runs matches calling the reader directly', async () => {
    const taskDir = join(repo, '.vanguard', 'runs', 'task-1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      join(taskDir, '2026-07-06T19-12-02-123Z-implement.json'),
      JSON.stringify({
        taskId: 'task-1',
        completed: true,
        exitReason: 'completed',
        turns: 3,
        worktreePath: '/tmp/wt',
        worktreePreserved: false,
        finalText: 'ok',
        costUsd: 0.1,
        timestamp: '2026-07-06T19:12:02.123Z',
        stage: 'implement',
      }),
    );

    const res = await fetch(`${baseUrl}/rpc/list_runs`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: repo }),
    });
    expect(res.status).toBe(200);
    const viaHttp = await res.json();
    const direct = await listRunSummaries(defaultRunsRoot(repo));
    // The `{ result }` envelope is what apps/desktop/src/transport.ts unwraps (spec §2.3).
    expect(viaHttp).toEqual({ result: direct });
  });

  test('T-81b a void command answers `{ result: null }`, never a bare body', async () => {
    const res = await fetch(`${baseUrl}/rpc/unwatch_project`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: repo }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: null });
  });

  test('T-81c a `false` result survives the envelope (api_repo_ok on a path outside the allowlist)', async () => {
    const res = await fetch(`${baseUrl}/rpc/api_repo_ok`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: '/definitely/not/allowlisted' }),
    });
    expect(res.status).toBe(200);
    // Pins `result ?? null`: a `result || null` refactor would turn this into `{ result: null }`.
    expect(await res.json()).toEqual({ result: false });
  });

  test('T-82 an oversized body is rejected with 413', async () => {
    const res = await fetch(`${baseUrl}/rpc/list_runs`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json', 'content-length': String(MAX_RPC_BODY_BYTES + 1) },
      body: 'x'.repeat(MAX_RPC_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  test('T-83 wrong method on a known path -> 405', async () => {
    const rpcRes = await fetch(`${baseUrl}/rpc/list_runs`, { method: 'GET' });
    expect(rpcRes.status).toBe(405);

    const healthRes = await fetch(`${baseUrl}/healthz`, { method: 'POST' });
    expect(healthRes.status).toBe(405);

    const eventsRes = await fetch(`${baseUrl}/events`, { method: 'POST' });
    expect(eventsRes.status).toBe(405);
  });

  test('T-84 a cross-origin request is rejected; a missing Content-Type is rejected', async () => {
    const crossOrigin = await fetch(`${baseUrl}/rpc/list_runs`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ repoPath: repo }),
    });
    expect(crossOrigin.status).toBe(400);

    const noContentType = await fetch(`${baseUrl}/rpc/list_runs`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token },
      body: JSON.stringify({ repoPath: repo }),
    });
    expect(noContentType.status).toBe(400);

    // Same-origin (matching Host) is accepted.
    const sameOrigin = await fetch(`${baseUrl}/rpc/list_runs`, {
      method: 'POST',
      headers: { 'x-vanguard-hub-token': hub.token, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ repoPath: repo }),
    });
    expect(sameOrigin.status).toBe(200);
  });

  test('T-85 an unmatched route 404s with the standard shape; Access-Control-Allow-Origin is never set', async () => {
    const res = await fetch(`${baseUrl}/no/such/thing.unknownext`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: 'not found', kind: 'bad-request' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('T-85 close() ends connected SSE clients and shuts the server down', async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/events?token=${hub.token}`, { signal: controller.signal });
    expect(sseRes.status).toBe(200);
    expect(hub.eventBus.clientCount).toBe(1);

    await hub.close();
    expect(hub.eventBus.clientCount).toBe(0);
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
    controller.abort();

  });
});
