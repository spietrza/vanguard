import { execa } from 'execa';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hubCommand } from './hub.js';
import { loadPaths } from '../hub/projects.js';
import type { Command } from './args.js';

vi.mock('execa', () => ({ execa: vi.fn(() => Promise.resolve({})) }));

type HubCommand = Extract<Command, { kind: 'hub' }>;

let uiDir: string;
let repo: string;
let configDir: string;
let browseRoot: string;
const envKeys = [
  'VANGUARD_HUB_UI_DIR',
  'VANGUARD_HUB_CONFIG_DIR',
  'VANGUARD_HUB_BROWSE_ROOT',
  'VANGUARD_HUB_ALLOW_ADD',
  'VANGUARD_HUB_WATCH_POLL',
  'VANGUARD_HUB_WATCH_INTERVAL_MS',
  'VANGUARD_HUB_ALLOWED_HOSTS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
  uiDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-cli-ui-'));
  repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-cli-repo-'));
  configDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-cli-cfg-'));
  browseRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-cli-browse-'));
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(uiDir, 'index.html'), '<html><head></head><body>hi</body></html>');
  process.env.VANGUARD_HUB_CONFIG_DIR = configDir;
  process.env.VANGUARD_HUB_BROWSE_ROOT = browseRoot;
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(uiDir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(browseRoot, { recursive: true, force: true });
});

function command(overrides: Partial<HubCommand> = {}): HubCommand {
  return { kind: 'hub', repoPath: repo, host: '127.0.0.1', port: 0, uiDir, open: true, ...overrides };
}

/** GET `path` from a URL the CLI printed, sending that URL's authority as the `Host` header — what
 * the browser the CLI opens sends. The connection itself goes over loopback (a `0.0.0.0` bind
 * accepts it there too), because `fetch` rewrites `Host` and some sandboxes intercept connections to
 * non-loopback addresses. */
function httpGet(printedUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { host, port } = new URL(printedUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('hubCommand', () => {
  test('passes CLI and environment allowed Hosts to the server', async () => {
    process.env.VANGUARD_HUB_ALLOWED_HOSTS = ' env.example, ';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command({ allowedHosts: ['cli.example'] }));
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('Vanguard Hub → '))!;
      const url = new URL(line.slice('Vanguard Hub → '.length)).origin;
      for (const host of ['cli.example', 'env.example']) {
        // node:http preserves an explicit Host (fetch implementations may replace it).
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = request(url + '/healthz', { headers: { host } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject);
          req.end();
        });
        expect(status).toBe(200);
      }
    } finally {
      logSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('a non-loopback bind serves the URL it prints, with no --allowed-host (an IP-literal Host)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the no-auth warning
    try {
      await hubCommand(command({ host: '0.0.0.0' }));
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('Vanguard Hub → '))!;
      const url = line.slice('Vanguard Hub → '.length);
      expect(url).toMatch(/^http:\/\/0\.0\.0\.0:\d+\/#token=[a-f0-9]{64}$/);
      const page = await httpGet(url, '/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('__VANGUARD_HUB__');
      expect(page.body).not.toContain(new URL(url).hash.slice('#token='.length));
      expect((await httpGet(url, '/healthz')).status).toBe(200);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('--host <hostname> seeds the allowlist, so the URL it prints and opens is not refused', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = hostname();
    try {
      await hubCommand(command({ host }));
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('Vanguard Hub → '))!;
      const url = line.slice('Vanguard Hub → '.length);
      expect(url).toMatch(new RegExp(`^http://${host}:\\d+/#token=[0-9a-f]+$`));
      // The hub actually bound to this machine's own hostname (a real address on the sandbox's
      // interface), so — unlike the `127.0.0.1`-bound tests — connect to the hostname itself, not
      // to loopback, to reach the socket the printed URL names.
      // `agent: false` (a fresh per-request agent, not the global one): under Node's
      // `NODE_USE_ENV_PROXY`, the global agent sends any non-`NO_PROXY` destination — this hostname
      // included — to `HTTP_PROXY`, which answers 405 instead of the hub.
      const { port } = new URL(url);
      // Its own agent, so the connection goes straight to the socket: a sandbox that exports
      // HTTP_PROXY + NODE_USE_ENV_PROXY=1 (loopback-only NO_PROXY) otherwise sends this request —
      // the one test here that dials a non-loopback address — through that proxy, which answers
      // for itself and never reaches the hub.
      const agent = new Agent();
      const get = (path: string): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = request({ host, port, path, agent }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          });
          req.on('error', reject);
          req.end();
        });
      const page = await get('/');
      expect(page.status).toBe(200);
      expect(page.body).not.toContain('__VANGUARD_HUB_TOKEN__'); // the token only travels in the launch URL fragment
      expect((await get('/healthz')).status).toBe(200);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('an allowed Host carrying a scheme, a path or a wildcard is a startup error', async () => {
    for (const bad of ['https://hub.example', 'hub.example/ui', '*.example']) {
      await expect(hubCommand(command({ allowedHosts: [bad] }))).rejects.toThrow(/bare host\[:port\]/);
      process.env.VANGUARD_HUB_ALLOWED_HOSTS = `ok.example,${bad}`;
      await expect(hubCommand(command())).rejects.toThrow(/bare host\[:port\]/);
      delete process.env.VANGUARD_HUB_ALLOWED_HOSTS;
    }
  });

  test('an allowed Host no Host header could carry — a bare IPv6 literal, empty brackets, a non-numeric port — is a startup error', async () => {
    for (const bad of ['::1', 'fe80::1', 'hub.example:http', 'hub.example:8080x', ':8080', '[]', '[]:80']) {
      await expect(hubCommand(command({ allowedHosts: [bad] }))).rejects.toThrow(
        /bare host\[:port\], with any IPv6 literal bracketed .* and a numeric port/,
      );
      process.env.VANGUARD_HUB_ALLOWED_HOSTS = `ok.example,${bad}`;
      await expect(hubCommand(command())).rejects.toThrow(/any IPv6 literal bracketed/);
      delete process.env.VANGUARD_HUB_ALLOWED_HOSTS;
    }
  });

  test('an allowed Host with a port outside 1-65535 is a startup error', async () => {
    for (const bad of ['hub.example:0', 'hub.example:65536', 'hub.example:99999']) {
      await expect(hubCommand(command({ allowedHosts: [bad] }))).rejects.toThrow(
        /bare host\[:port\], with a port between 1 and 65535/,
      );
    }
  });

  test('--allowed-host values are trimmed the same way VANGUARD_HUB_ALLOWED_HOSTS values are', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command({ allowedHosts: [' hub.example ', ''] }));
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('Vanguard Hub → '))!;
      const url = line.slice('Vanguard Hub → '.length);
      // Untrimmed, "Host: hub.example" (what a browser actually sends) would never match the stored
      // " hub.example " string.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url + '/healthz', { headers: { host: 'hub.example' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
    } finally {
      logSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('a bracketed IPv6 literal with a port is a valid allowed Host', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(hubCommand(command({ allowedHosts: ['[2001:db8::1]:8080', 'hub.example'] }))).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('a missing/unbuilt uiDir fails loudly, naming the build command', async () => {
    const emptyUiDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-cli-empty-'));
    await expect(hubCommand(command({ uiDir: emptyUiDir }))).rejects.toThrow(/pnpm --dir apps\/desktop build/);
    await rm(emptyUiDir, { recursive: true, force: true });
  });

  test('seeds the project store with --repo (a git work tree) and prints the startup line + projects', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command());
      expect(await loadPaths(configDir)).toContain(repo);
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith('Vanguard Hub → http://127.0.0.1:'))).toBe(true);
      expect(lines).toContain('Projects:');
      expect(lines.some((l) => l.trim() === repo)).toBe(true);
    } finally {
      logSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('does not re-add a project the user already removed from the store', async () => {
    await mkdir(join(configDir), { recursive: true });
    await writeFile(join(configDir, 'projects.json'), JSON.stringify([]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command());
      // Seeded fresh the first time.
      expect(await loadPaths(configDir)).toContain(repo);
      // Simulate the user removing it, then restarting the hub: it must stay removed.
      await writeFile(join(configDir, 'projects.json'), JSON.stringify([]));
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
      await hubCommand(command());
      expect(await loadPaths(configDir)).toContain(repo);
    } finally {
      logSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('a non-loopback bind prints the no-auth warning on stderr and skips opening a browser', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await hubCommand(command({ host: '0.0.0.0', open: false }));
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('WARNING'))).toBe(true);
      expect(execa).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('a loopback bind prints no warning and opens the browser', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await hubCommand(command({ open: true }));
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('WARNING'))).toBe(false);
      expect(execa).toHaveBeenCalled();
      // The browser opens the launch URL: the token rides in the fragment, which is never sent to
      // the server, and it is the token that authorizes `/rpc/*`.
      const openArgs = vi.mocked(execa).mock.calls[0]![1] as readonly string[];
      const opened = new URL(openArgs[0]!);
      expect(opened.pathname).toBe('/');
      expect(opened.search).toBe('');
      const token = new URLSearchParams(opened.hash.slice(1)).get('token')!;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      const rpc = (t: string): Promise<Response> =>
        fetch(`${opened.origin}/rpc/list_projects`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-vanguard-hub-token': t, origin: opened.origin }, body: '{}',
        });
      expect((await rpc(token)).status).toBe(200);
      expect((await rpc('')).status).toBe(401);
      expect(await (await fetch(opened.origin + '/')).text()).not.toContain(token);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('GET /healthz answers with a constant body, and SIGINT shuts the server down', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command());
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Vanguard Hub → '));
      expect(line).toBeDefined();
      const url = new URL(line!.replace('Vanguard Hub → ', '')).origin;
      const res = await fetch(`${url}/healthz`);
      expect(await res.json()).toEqual({ ok: true });

      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 50));
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});
