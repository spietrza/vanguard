// The hub's node:http entry point (spec §2.2): wires the RPC dispatcher (rpc.ts), the SSE bus
// (events.ts) and the static SPA server (static.ts) behind one listener. Same-origin only — this
// never emits Access-Control-Allow-Origin, so a page on another origin cannot read responses even
// if it can trigger the request.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { serveStatic } from './static.js';
import { EventBus } from './events.js';
import { writeJson, jsonError } from './json-response.js';
import { dispatchRpc, classifyError, type RpcContext } from './rpc.js';
import { encodeError, encodeResult, HUB_TOKEN_HEADER, HUB_TOKEN_QUERY_PARAM, HUB_TOKEN_REJECTED } from '../hub-wire.js';
import { ProjectAllowlist, type BindOptions } from './allowlist.js';
import { WatchRegistry, type WatchOptions } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteBusyError, CompleteRegistry, type SpawnComplete } from './complete.js';
import { loadPaths } from './projects.js';
import { productionDeps } from '../sidecar/deps.js';
import type { SidecarDeps } from '../sidecar/sidecar.js';

/**
 * `write_draft_asset` ships an image's bytes as a JSON array of numbers (comma-separated decimal —
 * several times the raw byte size), so the RPC body cap must clear a few MB of raw attachment data
 * by a wide margin, not just the biggest ordinary JSON payload.
 */
export const MAX_RPC_BODY_BYTES = 32 * 1024 * 1024;

export interface HubServerOptions {
  uiDir: string;
  configDir: string;
  browseRoot: string;
  /** Additional permitted clone hosts. */
  cloneHosts?: readonly string[];
  bind: BindOptions;
  /** The `--repo` seed, always allowed even before it reaches the persisted project store. */
  seedRepoPath?: string;
  watch?: WatchOptions;
  deps?: SidecarDeps;
  spawnComplete?: SpawnComplete;
  /** Extra permitted `Host` header values (`host[:port]`, exact match, case-insensitive) beyond the
   * default — `localhost` and any IP literal, on any port (see `hostAllowed`). This is
   * `--allowed-host` / `VANGUARD_HUB_ALLOWED_HOSTS`, for the VPS / reverse-proxy deployment
   * (docs/hub.md). */
  allowedHosts?: readonly string[];
}

export interface HubServer {
  readonly server: Server;
  readonly eventBus: EventBus;
  readonly allowlist: ProjectAllowlist;
  /** Per-launch secret `/rpc/*` and `/events` require. No route serves it — not `/healthz`, not
   * the SPA: the CLI hands it to the operator's browser in the launch URL's fragment
   * (`src/cli/hub.ts`), which browsers never send to the server, and the SPA moves it into
   * sessionStorage (apps/desktop/src/transport.ts). Reaching the port is not enough to drive the
   * hub. A non-loopback bind still needs Tailscale or an authenticating reverse proxy in front
   * (docs/hub.md): this is a launch secret, not per-user authentication. */
  readonly token: string;
  listen(port: number, host: string): Promise<void>;
  /** Graceful shutdown: ends every SSE client, stops project watchers, then closes the listener. */
  close(): Promise<void>;
}

function tokenOk(candidate: string | null | undefined, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const bytes = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/** Names the fix: a named-host deployment (a reverse proxy, a container reached under its own
 * hostname) has to opt that Host in — an IP literal and loopback need no flag (docs/hub.md). */
const HOST_NOT_ALLOWED = 'Host not allowed — pass --allowed-host <host[:port]> or set VANGUARD_HUB_ALLOWED_HOSTS';

/** Split a `Host` header into hostname and port. `[::1]:7777` → `{ hostname: '::1', port: 7777 }`; a
 * missing port means 80. `undefined` for anything malformed — a bare (unbracketed) IPv6 literal or a
 * non-numeric port. Exported for `src/cli/hub.ts`, which rejects the same shapes at startup. */
export function splitHostPort(host: string): { hostname: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(host);
  if (!match) return undefined;
  const [, bracketed, bare, port] = match;
  if (bracketed === undefined ? bare === '' : isIP(bracketed) !== 6) return undefined;
  return { hostname: bracketed ?? bare!, port: port === undefined ? 80 : Number(port) };
}

/**
 * DNS rebinding works by pointing a *hostname* at this server's address, so a `Host` the browser
 * could only have produced from an IP literal it connected to directly — IPv4, or a bracketed IPv6 —
 * is safe regardless of port: `--host 0.0.0.0`, a LAN address and a Tailscale address all work with
 * no `--allowed-host` (including the URL the CLI prints and opens). `localhost` resolves to loopback
 * everywhere, so it gets the same treatment. The port is deliberately not checked against the socket
 * the hub actually bound: `docker run -p 8080:7777`, `ssh -L 8080:localhost:7777` and `kubectl
 * port-forward` all put a different port on the Host header than the one the hub listens on, and
 * none of that changes the hostname a DNS-rebinding page could have produced — the hostname check
 * alone carries the protection. Any other hostname must be opted in explicitly, matched against the
 * `Host` header exactly (case-insensitive `host[:port]`).
 */
function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  if (allowedHosts.some((allowed) => allowed.toLowerCase() === lower)) return true;
  const parsed = splitHostPort(lower);
  if (parsed === undefined) return false;
  return parsed.hostname === 'localhost' || isIP(parsed.hostname) !== 0;
}

function notFound(res: ServerResponse): void {
  jsonError(res, 404, 'not found', 'bad-request');
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  const encoded = encodeError({ message: 'method not allowed', kind: 'bad-request' }, 405);
  writeJson(res, encoded.status, encoded.body, { allow });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Same-origin check for mutating routes: no Origin header (curl, same-process tooling) is allowed
 * through; a present Origin must match the request's own Host, or the request is cross-origin. This
 * guards against cross-site requests by host, not by scheme, so an HTTPS reverse proxy in front of
 * the hub (the VPS deployment) works with no extra configuration: the browser's `https://` Origin
 * still matches the `Host` header the hub sees, provided the proxy preserves the public Host. */
function sameOriginOk(req: IncomingMessage): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}

/**
 * Reads the full body before deciding, even once over `maxBytes` (dropping further chunks rather
 * than buffering them): destroying the socket mid-upload would race the client's own write and can
 * surface as a connection-reset instead of the 413 response. Draining to `end` lets the 413 (or any
 * other response) always reach the client cleanly.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new BodyTooLargeError('request body too large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function respondBodyTooLarge(res: ServerResponse): void {
  const encoded = encodeError({ message: 'request body too large', kind: 'bad-request' }, 413);
  writeJson(res, encoded.status, encoded.body, { connection: 'close' }, () => res.socket?.destroy());
}

async function handleRpcRequest(ctx: RpcContext, req: IncomingMessage, res: ServerResponse, cmd: string): Promise<void> {
  if (!sameOriginOk(req)) {
    jsonError(res, 400, 'cross-origin request rejected', 'bad-request');
    return;
  }
  const contentType = singleHeader(req.headers['content-type']);
  if (contentType === undefined || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    jsonError(res, 400, 'Content-Type must be application/json', 'bad-request');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_RPC_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondBodyTooLarge(res);
      return;
    }
    jsonError(res, 400, 'invalid JSON body', 'bad-request');
    return;
  }

  try {
    const result = await dispatchRpc(ctx, cmd, body);
    // Spec §2.3: success is `{ result }` (null for void commands); apps/desktop/src/transport.ts reads
    // `body.result`. A bare body here left the UI with `undefined` projects on first paint.
    writeJson(res, 200, encodeResult(result));
  } catch (err) {
    const classified = classifyError(err);
    const status = classified.notFound
      ? 404
      : err instanceof CompleteBusyError
        ? 429
        : classified.kind === 'bad-request'
          ? 400
          : 500;
    jsonError(res, status, classified.message, classified.kind);
  }
}

async function handleRequest(
  ctx: RpcContext,
  eventBus: EventBus,
  opts: HubServerOptions,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!hostAllowed(req.headers.host, opts.allowedHosts ?? [])) {
    jsonError(res, 403, HOST_NOT_ALLOWED, 'bad-request');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    // Unauthenticated on purpose — the container HEALTHCHECK (docker/hub.Dockerfile) has no token —
    // so the body is a constant: it says the port answers, nothing about which build is behind it.
    writeJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/events') {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    if (!tokenOk(url.searchParams.get(HUB_TOKEN_QUERY_PARAM), token)) {
      jsonError(res, 401, HUB_TOKEN_REJECTED, 'bad-request');
      return;
    }
    eventBus.subscribe(req, res);
    res.flushHeaders();
    return;
  }

  if (pathname.startsWith('/rpc/')) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!tokenOk(singleHeader(req.headers[HUB_TOKEN_HEADER]), token)) {
      jsonError(res, 401, HUB_TOKEN_REJECTED, 'bad-request');
      return;
    }
    await handleRpcRequest(ctx, req, res, pathname.slice('/rpc/'.length));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notFound(res);
    return;
  }

  const handled = await serveStatic({ uiDir: opts.uiDir }, req, res);
  if (!handled) notFound(res);
}

/** Build (but do not start) the hub's HTTP server. `listen`/`close` drive its lifecycle. */
export function createHubServer(opts: HubServerOptions): HubServer {
  const token = randomBytes(32).toString('hex');
  const deps = opts.deps ?? productionDeps();
  const eventBus = new EventBus();
  eventBus.startKeepalive();
  const watchRegistry = new WatchRegistry(opts.watch);
  const publish = (name: string, payload: unknown): void => eventBus.publish(name, payload);
  const runSession = createRunSession(deps, publish);
  const completeRegistry = new CompleteRegistry(opts.spawnComplete);
  const allowlist = new ProjectAllowlist(() => loadPaths(opts.configDir), opts.seedRepoPath);

  const ctx: RpcContext = {
    allowlist,
    watchRegistry,
    runSession,
    completeRegistry,
    deps,
    configDir: opts.configDir,
    browseRoot: opts.browseRoot,
    ...(opts.cloneHosts !== undefined ? { cloneHosts: opts.cloneHosts } : {}),
    bind: opts.bind,
    publish,
  };

  const server = createServer((req, res) => {
    void handleRequest(ctx, eventBus, opts, token, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else jsonError(res, 500, 'internal server error', 'internal');
    });
  });

  return {
    server,
    token,
    eventBus,
    allowlist,
    listen: (port, host) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        watchRegistry.closeAll();
        eventBus.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
