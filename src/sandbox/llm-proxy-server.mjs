#!/usr/bin/env node
// Standalone zero-dep LLM reverse-proxy for the host enclave sidecar. Holds the real Anthropic
// credential (read from a tmpfs file, never argv/env) and swaps it in for a per-run nonce, then
// forwards to api.anthropic.com. The pure auth/beta/path/compare logic is imported from the shared
// `llm-proxy-rewrite.mjs`, which the host `docker cp`'s next to this file — the SAME module the TS
// app and its tests use, so the two never drift.
//
// SECURITY: never log request/response headers, bodies, the secret, or the nonce. Inbound nonce
// check is constant-time. Locked down to POST /v1/messages and /v1/messages/count_tokens.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { UPSTREAMS, upstreamAuthHeaders, openaiAuthHeaders, isAllowedLlmPath, constantTimeEqual, upstreamPath, filterAnthropicBeta, stripEgressTools } from './llm-proxy-rewrite.mjs';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 8;
// Hop-by-hop headers must not be forwarded to the upstream.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// --- config: read MODE/SECRET/NONCE from the tmpfs file; PORT from env ---
const secretFile = process.env.LLM_PROXY_SECRET_FILE;
if (!secretFile) {
  console.error('llm-proxy: LLM_PROXY_SECRET_FILE is required');
  process.exit(1);
}
let secretText;
try {
  secretText = readFileSync(secretFile, 'utf8');
} catch {
  // Never log the error object or file contents (may carry path/secret hints).
  console.error('llm-proxy: cannot read secret file');
  process.exit(1);
}
const config = parseSecretFile(secretText);
// UPSTREAM is optional; default to anthropic so an unmodified sidecar still works.
// NB: named `upstreamKind` (not `upstream`) to avoid shadowing the per-request `upstream` socket
// bindings in the request handler / forward() — that shadowing would TDZ-crash on every request.
const upstreamKind = config.UPSTREAM ?? 'anthropic';
if (!(upstreamKind in UPSTREAMS)) {
  console.error(`llm-proxy: invalid secret file (UPSTREAM must be ${Object.keys(UPSTREAMS).join('|')})`);
  process.exit(1);
}
const spec = UPSTREAMS[upstreamKind];
// 'anthropic'-auth needs MODE (subscription|api); 'bearer'-auth (openai, zai) is just Bearer SECRET (no MODE).
if (spec.auth === 'anthropic' && config.MODE !== 'subscription' && config.MODE !== 'api') {
  console.error('llm-proxy: invalid secret file (need MODE=subscription|api for anthropic)');
  process.exit(1);
}
if (!config.SECRET || !config.NONCE) {
  console.error('llm-proxy: invalid secret file (need SECRET, NONCE)');
  process.exit(1);
}
// SECRET/NONCE are placed into HTTP headers; reject control chars to prevent header injection.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
if (CONTROL_CHARS.test(config.SECRET) || CONTROL_CHARS.test(config.NONCE)) {
  console.error('llm-proxy: secret/nonce contains control characters');
  process.exit(1);
}
const UPSTREAM_HOST = spec.host;
const PORT = Number(process.env.PORT ?? '8088');

function parseSecretFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key !== '') out[key] = value.replace(/\r$/, '');
  }
  return out;
}

const auth = { mode: config.MODE, secret: config.SECRET };
const expectedAuthorization = `Bearer ${config.NONCE}`;

// Request auth keyed by the upstream's auth STYLE (from UPSTREAMS[upstreamKind].auth), not the upstream
// name — every 'bearer' upstream (openai, zai, …) shares one builder, so adding one needs no change here.
// Thunks are lazy (only the chosen style runs per request); spec.auth is validated at boot, never misses.
const AUTH_HEADERS_BY_STYLE = {
  anthropic: (req) => upstreamAuthHeaders(auth, req.headers), // mode-aware Bearer/x-api-key (+ oauth beta merge)
  bearer: () => openaiAuthHeaders(config.SECRET), //            plain Authorization: Bearer SECRET
};

let inFlight = 0;

function finish(req, res, status, started) {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'text/plain' });
  }
  res.end();
  // No upstream body for short-circuit responses → omit the byte figure.
  log(req, status, null, started);
}

// `bytes` is the upstream content-length (number) when known, else null → omit the byte figure.
function log(req, status, bytes, started) {
  const ms = Date.now() - started;
  const path = (req.url ?? '').split('?')[0] ?? '';
  // ONLY method, path, status, byte count, duration — never headers/body/secret/nonce.
  const size = bytes === null ? '' : `${bytes}B, `;
  console.log(`${req.method} ${path} -> ${status} (${size}${ms}ms)`);
}

const server = createServer((req, res) => {
  const started = Date.now();

  if (!isAllowedLlmPath(req.method, req.url, upstreamKind)) {
    finish(req, res, 404, started);
    req.resume();
    return;
  }

  const authorization = req.headers['authorization'] ?? '';
  if (!constantTimeEqual(authorization, expectedAuthorization)) {
    finish(req, res, 401, started);
    req.resume();
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    finish(req, res, 503, started);
    req.resume();
    return;
  }

  // We are now holding a concurrency slot; EVERY exit path must funnel through cleanup() exactly
  // once so inFlight is released and sockets are torn down. `done` makes cleanup() idempotent.
  inFlight += 1;
  let done = false;
  let upstream = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (upstream && !upstream.destroyed) upstream.destroy();
    if (!res.writableEnded) res.destroy();
  };

  // Buffer the request body with a hard size cap.
  const chunks = [];
  let size = 0;
  let overflow = false;

  req.on('data', (chunk) => {
    if (done || overflow) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      overflow = true;
      finish(req, res, 413, started);
      req.destroy();
      cleanup();
      return;
    }
    chunks.push(chunk);
  });

  // Client abort during buffering emits 'aborted'/'close' (not always 'error'); cover all of them.
  req.on('error', cleanup);
  req.on('aborted', cleanup);
  req.on('close', () => {
    // If the body never completed (no forward started yet), release the slot.
    if (!done && upstream === null) cleanup();
  });

  req.on('end', () => {
    if (done || overflow) return;
    // An encoded body could not be inspected for egress-capable tools: refuse it rather than pass it on.
    const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity') {
      finish(req, res, 415, started);
      cleanup();
      return;
    }
    const body = stripEgressTools(Buffer.concat(chunks, size));
    forward(req, res, body, started, (up) => {
      upstream = up;
    }, cleanup, () => done);
  });
});

function forward(req, res, body, started, setUpstream, cleanup, isDone) {
  // Strip inbound auth + hop-by-hop + host; then apply upstream auth headers.
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'anthropic-beta') {
      // Every upstream, not just anthropic-auth ones: drop beta families that open upstream-side egress.
      const beta = filterAnthropicBeta(value);
      if (beta !== undefined) headers[lower] = beta;
      continue;
    }
    if (value !== undefined) headers[lower] = value;
  }

  const applied = AUTH_HEADERS_BY_STYLE[spec.auth](req);
  for (const [key, value] of Object.entries(applied)) headers[key] = value;
  headers['content-length'] = String(body.length);

  const path = upstreamPath(upstreamKind, req.url);
  let responded = false;

  const upstream = httpsRequest(
    { host: UPSTREAM_HOST, port: 443, method: 'POST', path, headers },
    (upRes) => {
      responded = true;
      const outHeaders = {};
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (value !== undefined) outHeaders[key] = value;
      }
      // Byte count for the access log comes from the upstream content-length when present (no
      // per-chunk tallying); streaming responses (SSE) have none → omit the figure.
      const cl = upRes.headers['content-length'];
      const clNum = Array.isArray(cl) ? Number(cl[0]) : Number(cl);
      const bytes = cl !== undefined && Number.isFinite(clNum) ? clNum : null;
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
      upRes.on('end', () => {
        log(req, upRes.statusCode ?? 502, bytes, started);
        cleanup();
      });
      upRes.on('error', cleanup);
    },
  );
  setUpstream(upstream);

  upstream.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!responded && !res.headersSent) {
      finish(req, res, 504, started);
    }
    cleanup();
  });

  upstream.on('error', () => {
    if (!responded && !res.headersSent && !isDone()) {
      finish(req, res, 502, started);
    }
    cleanup();
  });

  // Client hung up after we started forwarding — abort upstream and release.
  res.on('close', cleanup);

  upstream.end(body);
}

server.listen(PORT, () => console.log(`llm-proxy on ${PORT}; upstream=${upstreamKind}`));
