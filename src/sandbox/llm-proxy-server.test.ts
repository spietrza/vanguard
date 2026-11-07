// Boots the real standalone sidecar (llm-proxy-server.mjs) as a child process and exercises ONLY the
// short-circuit paths (404 disallowed-path gate, 401 wrong-nonce) so no real upstream is contacted.
// This is the regression guard for the module-level `upstreamKind` binding: if it shadowed the
// per-request `upstream` socket again, the request handler would TDZ-crash and the 404 assertion
// (which runs the line-~108 gate) would fail with a connection reset instead of a clean 404.
import { describe, it, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'llm-proxy-server.mjs');

// Spawn the sidecar with the test secret file + port. Wrapped so `Child` below captures the exact
// execa generic (its options literal) — typing the field as bare `ResultPromise` clashes under
// exactOptionalPropertyTypes.
function spawnServer(secretFile: string, port: number) {
  return execa('node', [serverPath], {
    env: { LLM_PROXY_SECRET_FILE: secretFile, PORT: String(port) },
    stdio: 'pipe',
    reject: false,
  });
}
type Child = ReturnType<typeof spawnServer>;

type Started = { port: number; child: Child; dir: string };

/** GET an ephemeral port that is almost certainly free by binding :0 via a throwaway listener. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Fire one HTTP request to the sidecar and resolve with the status code (body ignored). */
function hit(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolve true if a bare TCP connect to the port succeeds (listener is up); false otherwise. */
async function tcpUp(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const sock = connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll (bare TCP, no HTTP — so this probe never runs the path gate and can't itself trip the bug)
 * until the child server is listening. The TDZ crash, if present, surfaces later in the test body's
 * HTTP calls as a connection reset → a clear assertion failure rather than this helper hanging.
 */
async function waitUntilUp(port: number, child: Child, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // If the child dies during boot, surface that immediately instead of timing out.
  let exited = false;
  child.catch(() => {
    exited = true;
  });
  for (;;) {
    if (exited) throw new Error('llm-proxy child exited during boot');
    if (await tcpUp(port)) return;
    if (Date.now() > deadline) throw new Error('llm-proxy did not start listening in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startServer(secretBody: string): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'vg-llm-proxy-test-'));
  const secretFile = join(dir, 'secret');
  await writeFile(secretFile, secretBody, 'utf8');
  const port = await freePort();
  const child = spawnServer(secretFile, port);
  await waitUntilUp(port, child);
  return { port, child, dir };
}

describe('llm-proxy-server (booted child)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  function track(s: Started): Started {
    cleanups.push(async () => {
      s.child.kill('SIGKILL');
      await s.child.catch(() => {});
      await rm(s.dir, { recursive: true, force: true });
    });
    return s;
  }

  it('anthropic: 404 on disallowed path and 401 on wrong nonce (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=anthropic\nMODE=api\nSECRET=sk-ant-test\nNONCE=real-nonce\n'));
    // Disallowed path runs the path gate (the line that TDZ-crashed under the shadowing bug).
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    expect(await hit(s.port, 'GET', '/nope')).toBe(404);
    // Allowed path but wrong nonce → 401, short-circuits before any forward.
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('refuses an encoded body it cannot inspect for egress tools with 415 (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=anthropic\nMODE=api\nSECRET=sk-ant-test\nNONCE=real-nonce\n'));
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer real-nonce', 'content-encoding': 'gzip' }),
    ).toBe(415);
  }, 60_000);

  it('openai: 404 on disallowed path and 401 on wrong nonce (no upstream contacted)', async () => {
    const s = track(await startServer('UPSTREAM=openai\nSECRET=sk-openai-test\nNONCE=real-nonce\n'));
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/messages')).toBe(404); // openai rejects anthropic path
    expect(
      await hit(s.port, 'POST', '/v1/responses', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);

  it('zai: allows the anthropic-compatible /v1/messages path, rejects openai paths and wrong nonce', async () => {
    const s = track(await startServer('UPSTREAM=zai\nSECRET=zai-test-key\nNONCE=real-nonce\n'));
    // z.ai's coding endpoint is Anthropic-Messages-compatible: /v1/messages is allowed, /v1/responses is not.
    expect(await hit(s.port, 'POST', '/v1/responses')).toBe(404);
    expect(await hit(s.port, 'POST', '/v1/models')).toBe(404);
    // Allowed path but wrong nonce -> 401, short-circuits before any forward to api.z.ai.
    expect(
      await hit(s.port, 'POST', '/v1/messages', { authorization: 'Bearer wrong-nonce' }),
    ).toBe(401);
  }, 60_000);
});


describe('llm-proxy-server (execa 10 handle)', () => {
  it('exposes the Node ChildProcess via nodeChildProcess and reports a SIGKILL teardown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-handle-'));
    const secretFile = join(dir, 'secret');
    await writeFile(secretFile, 'nonce\n');
    const child = spawnServer(secretFile, await freePort());
    try {
      expect(child.nodeChildProcess.pid).toBe(child.pid);
      expect(child.nodeChildProcess.exitCode).toBeNull();
      child.kill('SIGKILL');
      const result = await child;
      expect(result.isTerminated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
