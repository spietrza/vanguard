import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { createHubServer, splitHostPort } from '../hub/server.js';
import { injectHubMarker } from '../hub/static.js';
import { assertGitWorkTreeDir } from '../hub/allowlist.js';
import { HUB_TOKEN_FRAGMENT_PARAM } from '../hub-wire.js';
import { loadPaths, add as addProject } from '../hub/projects.js';
import type { Command } from './args.js';

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

function parseHostList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((h) => h.trim()).filter(Boolean);
}

/** `allowedHosts` is matched against the `Host` header exactly (case-insensitive `host[:port]`), so a
 * URL, a glob, or anything a `Host` header cannot hold — an unbracketed IPv6 literal, a non-numeric
 * port — would simply never match. Refuse all of those at startup instead of serving 403s the
 * operator cannot explain. */
function assertPlainHosts(hosts: readonly string[]): void {
  for (const host of hosts) {
    // A scheme and a path are rejected by `splitHostPort` too, but they are the likely mistakes —
    // check them first so the message names them rather than talking about brackets and ports.
    const requirement = /[/*]/.test(host)
      ? 'with no scheme, path or wildcard'
      : splitHostPort(host) === undefined
        ? 'with any IPv6 literal bracketed ("[::1]:7777") and a numeric port'
        : undefined;
    if (requirement !== undefined) {
      throw new Error(
        `Vanguard Hub: invalid allowed Host "${host}" — --allowed-host/VANGUARD_HUB_ALLOWED_HOSTS take a bare host[:port], ${requirement}.`,
      );
    }
  }
}

/** `src/cli/hub.ts` -> package root, whether running under tsx (src/) or built (dist/) — both
 * mirror the same two-levels-up depth from rootDir/outDir. */
function pkgRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/** Fails loudly and actionably at startup, not on the first request: an unbuilt or stale UI bundle
 * must never reach `createHubServer`, where the same failure would otherwise surface per-request. */
async function assertUiDirBuilt(uiDir: string): Promise<void> {
  const indexPath = join(uiDir, 'index.html');
  try {
    injectHubMarker(await readFile(indexPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Vanguard Hub: cannot read ${indexPath} (${reason}) — build the desktop app first: pnpm --dir apps/desktop build`,
    );
  }
}

/** The URL the CLI prints and opens: `origin/#token=<token>`. The token rides in the fragment, which
 * browsers never send to the server, so the hub never has to serve it to whoever fetches `GET /`;
 * the SPA reads it once into sessionStorage (apps/desktop/src/transport.ts). Behind a reverse proxy,
 * append the same `#token=…` to the public URL. */
export function hubLaunchUrl(origin: string, token: string): string {
  return `${origin}/#${HUB_TOKEN_FRAGMENT_PARAM}=${encodeURIComponent(token)}`;
}

const NO_AUTH_WARNING = [
  'WARNING: Vanguard Hub is bound to a non-loopback address with no authentication.',
  'Anyone who can reach this host and port can read and change every allowed project.',
  'Put it behind Tailscale or an authenticating reverse proxy — never expose it directly on a',
  'public port. See docs/hub.md.',
].join('\n');

export async function hubCommand(command: Extract<Command, { kind: 'hub' }>): Promise<void> {
  const allowedHosts = [...(command.allowedHosts ?? []), ...parseHostList(process.env.VANGUARD_HUB_ALLOWED_HOSTS)];
  assertPlainHosts(allowedHosts);

  const uiDir = resolve(command.uiDir ?? process.env.VANGUARD_HUB_UI_DIR ?? join(pkgRoot(), 'apps/desktop/dist'));
  await assertUiDirBuilt(uiDir);

  const { version } = JSON.parse(await readFile(join(pkgRoot(), 'package.json'), 'utf8')) as { version: string };
  const configDir =
    process.env.VANGUARD_HUB_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'vanguard-hub');
  const isLoopback = LOOPBACK_HOSTS.includes(command.host);

  // Seed the project store with --repo, same rule add_project uses: must be a git work tree, and
  // only persisted once (a restart must not keep re-adding an already-removed project).
  let seededRepoPath: string | undefined;
  try {
    await assertGitWorkTreeDir(command.repoPath);
    seededRepoPath = command.repoPath;
  } catch {
    seededRepoPath = undefined;
  }
  if (seededRepoPath !== undefined) {
    const existing = await loadPaths(configDir);
    if (!existing.includes(seededRepoPath)) {
      await addProject(configDir, seededRepoPath);
    }
  }

  const hub = createHubServer({
    uiDir,
    allowedHosts,
    configDir,
    browseRoot: process.env.VANGUARD_HUB_BROWSE_ROOT ?? homedir(),
    ...(process.env.VANGUARD_HUB_CLONE_HOSTS ? { cloneHosts: parseHostList(process.env.VANGUARD_HUB_CLONE_HOSTS) } : {}),
    bind: {
      isLoopback,
      allowAdd: process.env.VANGUARD_HUB_ALLOW_ADD === '1',
    },
    ...(seededRepoPath !== undefined ? { seedRepoPath: seededRepoPath } : {}),
    version,
    watch: {
      forcePoll: process.env.VANGUARD_HUB_WATCH_POLL === '1',
      ...(Number(process.env.VANGUARD_HUB_WATCH_INTERVAL_MS) > 0
        ? { pollIntervalMs: Number(process.env.VANGUARD_HUB_WATCH_INTERVAL_MS) }
        : {}),
    },
  });

  try {
    await hub.listen(command.port, command.host);
  } catch (error) {
    await hub.close();
    throw error;
  }

  const shutdown = (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    void hub.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Print the socket's actual bound port (relevant when command.port is 0, e.g. in tests) rather
  // than echoing the requested value back.
  const address = hub.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : command.port;
  const hostForUrl = command.host.includes(':') ? `[${command.host}]` : command.host;
  const url = hubLaunchUrl(`http://${hostForUrl}:${boundPort}`, hub.token);
  console.log(`Vanguard Hub → ${url}`);

  const projects = await loadPaths(configDir);
  if (projects.length > 0) {
    console.log('Projects:');
    for (const p of projects) console.log(`  ${p}`);
  } else {
    console.log('Projects: (none yet — add one with add_project, or pass --repo)');
  }

  if (!isLoopback) {
    console.error(NO_AUTH_WARNING);
  }

  if (command.open) {
    const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    void execa(program, [url]).catch(() => console.error(`Open ${url} in your browser.`));
  }
}
