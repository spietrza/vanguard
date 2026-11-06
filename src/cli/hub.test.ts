import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
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

describe('hubCommand', () => {
  test('passes CLI and environment allowed Hosts to the server', async () => {
    process.env.VANGUARD_HUB_ALLOWED_HOSTS = ' env.example, ';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await hubCommand(command({ allowedHosts: ['cli.example'] }));
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('Vanguard Hub → '))!;
      const url = line.slice('Vanguard Hub → '.length);
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

  test('an allowed Host carrying a scheme, a path or a wildcard is a startup error', async () => {
    for (const bad of ['https://hub.example', 'hub.example/ui', '*.example']) {
      await expect(hubCommand(command({ allowedHosts: [bad] }))).rejects.toThrow(/bare host\[:port\]/);
      process.env.VANGUARD_HUB_ALLOWED_HOSTS = `ok.example,${bad}`;
      await expect(hubCommand(command())).rejects.toThrow(/bare host\[:port\]/);
      delete process.env.VANGUARD_HUB_ALLOWED_HOSTS;
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
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  test('GET /healthz answers with the package version, and SIGINT shuts the server down', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    try {
      await hubCommand(command());
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Vanguard Hub → '));
      expect(line).toBeDefined();
      const url = line!.replace('Vanguard Hub → ', '');
      const res = await fetch(`${url}/healthz`);
      expect(await res.json()).toEqual({ ok: true, version: pkg.version });

      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 50));
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});
