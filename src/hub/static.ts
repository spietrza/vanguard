// Serves the built apps/desktop/dist SPA, injecting the hub marker into index.html so the browser
// bundle's transport.ts picks the hub (fetch/SSE) branch instead of Tauri's invoke/listen.
import { readFile, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonError } from './json-response.js';
import { isWithinRoot } from './browse.js';
import { HUB_MARKER } from '../hub-wire.js';

/** Inject the hub marker (and, when given, the per-launch auth token) immediately after `<head>`.
 * Pure string function (its own test target). Throws if no insertion point is found — a silent
 * no-op here means the browser silently takes the Tauri branch and every call throws, which must
 * fail loudly at startup instead. `token` is omitted by the CLI's startup build-check (it only
 * verifies `<head>` exists, before a token has been generated). */
export function injectHubMarker(html: string, token?: string): string {
  const idx = html.indexOf('<head>');
  if (idx === -1) throw new Error('index.html has no <head> — cannot inject the hub marker');
  const insertAt = idx + '<head>'.length;
  const tokenScript = token !== undefined ? `<script>window.__VANGUARD_HUB_TOKEN__=${JSON.stringify(token)}</script>` : '';
  return html.slice(0, insertAt) + HUB_MARKER + tokenScript + html.slice(insertAt);
}

export interface StaticOptions {
  uiDir: string;
  /** Injected into `index.html` for `transport.ts` to read back and send on `/rpc/*` and `/events`. */
  token?: string;
}

/** `index.html` carries a live per-launch token, so no other page may frame it: a framed hub page
 * would run on the hub's own origin and could be driven by clickjacking. Sent with every static
 * response (both headers — `X-Frame-Options` for anything that predates `frame-ancestors`). */
const FRAME_DENY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
} as const;

/**
 * Handle one static GET request. Returns true if it handled (and ended) the response, false if the
 * caller should try another route (e.g. this wasn't a GET, or isn't a path this server owns — never
 * happens here since everything non-/rpc,/events falls through to the SPA, but kept for composability).
 */
export async function serveStatic(opts: StaticOptions, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Decoded (and query-stripped) once, before any URL-level dot-segment normalization could hide a
  // literal `..` segment from this check — e.g. a request for `/../etc/passwd` must 404, not get
  // silently resolved to `/etc/passwd` by a later normalization step.
  let rawPath: string;
  try {
    rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (rawPath.includes('\0') || rawPath.split(/[\\/]/).includes('..')) throw new Error('invalid path');
  } catch {
    jsonError(res, 404, 'not found', 'bad-request');
    return true;
  }

  const hasExtension = extname(rawPath) !== '';
  if (hasExtension && rawPath !== '/index.html') {
    const filePath = join(opts.uiDir, rawPath);
    try {
      const root = await realpath(opts.uiDir);
      const resolved = await realpath(filePath);
      if (!isWithinRoot(root, resolved)) throw new Error('outside UI directory');
      // No separate `stat`/isFile check: `readFile` on a directory throws EISDIR, which the catch
      // below turns into the same 404 a missing or disallowed file gets.
      const body = await readFile(resolved);
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'public, max-age=31536000, immutable',
        ...FRAME_DENY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      jsonError(res, 404, 'not found', 'bad-request');
      return true;
    }
  }

  // SPA fallback: any extensionless path (including `/`) serves index.html with the hub marker.
  try {
    const raw = await readFile(join(opts.uiDir, 'index.html'), 'utf8');
    const html = injectHubMarker(raw, opts.token);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...FRAME_DENY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  } catch {
    jsonError(
      res,
      500,
      `cannot read ${join(opts.uiDir, 'index.html')} — build the desktop app first: pnpm --dir apps/desktop build`,
      'internal',
    );
    return true;
  }
}

function contentType(filePath: string): string {
  const ext = extname(filePath);
  switch (ext) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ico':
      return 'image/x-icon';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}
