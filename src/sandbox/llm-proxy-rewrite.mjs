// Pure rewrite/lockdown logic for the host LLM reverse-proxy sidecar.
// Authored as plain ESM `.mjs` so BOTH the strict-TS app and the zero-dep sidecar
// (`llm-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `llm-proxy-rewrite.d.mts`. The sidecar gets this file
// `docker cp`'d next to it so the relative `import './llm-proxy-rewrite.mjs'` resolves.
import { timingSafeEqual } from 'node:crypto';

export const OAUTH_BETA = 'oauth-2025-04-20';

/** Coerce a node header value (string | string[] | undefined) to a single comma-joined string. */
function betaToString(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * anthropic-beta feature families the sidecar refuses to forward: each lets the upstream reach third-party
 * servers on the sandbox's behalf (MCP connector, web fetch, tunnels) or keep state/run code outside the
 * run (files, code execution, skills, batches, hosted agents/environments) — egress the sandbox
 * allowlist cannot see. Prefix-matched on whole name segments, so re-dated, undated and extended
 * variants (`code-execution-web-tools-…`, `mcp-anything`) are dropped too. A denylist rather than an
 * allowlist on purpose: Claude Code ships dozens of betas and adds new ones each release, and dropping
 * an unknown one turns its request fields into upstream 400s.
 */
const BLOCKED_BETA_PREFIXES = [
  'mcp',
  'web-fetch',
  'code-execution',
  'files-api',
  'skills',
  'message-batches',
  'managed-agents',
  'environments',
  'ccr',
];

/** Whether a beta value belongs to a blocked family: equal to a prefix or continuing it with `-`. */
function isBlockedBeta(value) {
  return BLOCKED_BETA_PREFIXES.some((p) => value === p || value.startsWith(`${p}-`));
}

// Server tools that make the upstream fetch URLs, run code or call MCP servers for the sandbox.
// web_search stays: Claude Code's WebSearch tool depends on it.
const BLOCKED_TOOL_TYPE = /^(web_fetch|code_execution|mcp)/i;

/**
 * The request body with egress-capable server tools removed from `tools[]` and the MCP-connector
 * `mcp_servers` parameter dropped. Returns the input Buffer untouched when there is nothing to strip or
 * it is not a JSON object (the upstream rejects a malformed body itself).
 */
export function stripEgressTools(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  let changed = false;
  if ('mcp_servers' in parsed) {
    delete parsed.mcp_servers;
    changed = true;
  }
  if (Array.isArray(parsed.tools)) {
    const kept = parsed.tools.filter((t) => !(t !== null && typeof t === 'object' && typeof t.type === 'string' && BLOCKED_TOOL_TYPE.test(t.type)));
    if (kept.length !== parsed.tools.length) {
      parsed.tools = kept;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(parsed), 'utf8') : body;
}

/**
 * The request's anthropic-beta with blocked families removed (trimmed, comma-joined); undefined when
 * nothing is left, so the caller omits the header.
 */
export function filterAnthropicBeta(incoming) {
  const kept = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !isBlockedBeta(s.toLowerCase()));
  return kept.length > 0 ? kept.join(',') : undefined;
}

/** Merge request anthropic-beta with an extra value, preserving order and deduping. */
export function mergeAnthropicBeta(incoming, extra) {
  const parts = (betaToString(incoming) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!parts.includes(extra)) parts.push(extra);
  return parts.join(',');
}

/**
 * Headers to apply upstream for the chosen auth mode. Returns lowercase keys to set; caller deletes any
 * conflicting inbound auth headers first. Subscription => Authorization: Bearer + oauth beta merged;
 * api => x-api-key, no oauth beta.
 */
export function upstreamAuthHeaders(auth, reqHeaders) {
  const beta = filterAnthropicBeta(reqHeaders['anthropic-beta']);
  if (auth.mode === 'subscription') {
    return { authorization: `Bearer ${auth.secret}`, 'anthropic-beta': mergeAnthropicBeta(beta, OAUTH_BETA) };
  }
  // api mode: x-api-key, no oauth beta; pass through the request's (filtered) anthropic-beta if present.
  return { 'x-api-key': auth.secret, ...(beta !== undefined ? { 'anthropic-beta': beta } : {}) };
}

/**
 * Single source of truth for every upstream the sidecar can proxy, keyed by the UPSTREAM value in the
 * secret file. Add an upstream here and every consumer follows: host routing + allowlist drop
 * (UPSTREAMS[k].host), POST-path lockdown (.paths), auth scheme (.auth), and boot validation (`k in UPSTREAMS`).
 *
 * - host:  where the sidecar forwards (and the host dropped from the sandbox egress allowlist).
 * - paths: the ONLY POST paths tunnelled through (query string ignored, no wildcards) — the lockdown.
 * - auth:  how the real credential is presented upstream. 'anthropic' = mode-aware x-api-key OR
 *          Bearer+oauth-beta (upstreamAuthHeaders). 'bearer' = plain Authorization: Bearer SECRET
 *          (openaiAuthHeaders). z.ai/OpenRouter are Anthropic-Messages-compatible on the WIRE (same
 *          paths) but authenticate with plain bearer keys, so they pair anthropic paths with bearer auth.
 */
export const UPSTREAMS = {
  anthropic: { host: 'api.anthropic.com', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'anthropic' },
  openai: { host: 'api.openai.com', paths: ['/v1/responses'], auth: 'bearer' },
  // basePath: keep in sync with ZAI_BASE_URL in src/agents/zai.ts
  zai: { host: 'api.z.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'bearer', basePath: '/api/coding/paas/v4' },
  // basePath: keep in sync with OPENROUTER_BASE_URL in src/agents/openrouter.ts
  openrouter: { host: 'openrouter.ai', paths: ['/v1/messages', '/v1/messages/count_tokens'], auth: 'bearer', basePath: '/api' },
};

/** Whether the request is an allowed POST to the chosen upstream's endpoint(s) (query string ignored). */
export function isAllowedLlmPath(method, path, upstream = 'anthropic') {
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  const spec = UPSTREAMS[upstream];
  if (spec === undefined) return false;
  const p = (path ?? '').split('?')[0] ?? '';
  return spec.paths.includes(p);
}

/** Headers to apply upstream for plain-Bearer providers (OpenAI, z.ai, OpenRouter): just Bearer SECRET (no anthropic-beta, no x-api-key). */
export function openaiAuthHeaders(secret) {
  return { authorization: `Bearer ${secret}` };
}

/** Outbound upstream path: the upstream's base path prefix + the inbound request path (query kept). */
export function upstreamPath(upstream, reqUrl) {
  const spec = UPSTREAMS[upstream];
  return `${spec?.basePath ?? ''}${reqUrl ?? '/'}`;
}

/** Constant-time string compare (length-safe). */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // compare against self to keep timing independent of which arg differs, then return false
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
