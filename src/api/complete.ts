import { readFileSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';
// CompleteRequest/CompleteResponse live in src/wire.ts (the shared desktop contract — S7).
export type { CompleteRequest, CompleteResponse } from '../wire.js';
import type { CompleteRequest, CompleteResponse, CompleteAttachment } from '../wire.js';
import { MAX_INLINE_TOTAL_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES } from '../wire.js';

/** The async-iterable subset of the agent SDK's `query()` result we consume. */
type QueryStream = AsyncIterable<{ type: string; subtype?: string; result?: string }>;

/**
 * Injected so tests mock the SDK; the CLI branch wires the real `@anthropic-ai/claude-agent-sdk`.
 * `prompt` is a string for a text-only turn; when the turn carries pasted images it is instead the
 * SDK's streaming-input form (an async-iterable of one user message whose content is text + image
 * content blocks) — the same value the real `query()` accepts either way.
 */
export interface CompleteDeps {
  query: (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => QueryStream;
}

/** A `file` attachment whose text content is present — the narrowed shape the inliner and the
 * byte-total guard both operate on. */
type FileAttachment = CompleteAttachment & { content: string };

/** The `file` attachments carrying inlinable text (dropped files + `@`-mentions), content narrowed
 * to a string so callers need no fallback. */
function fileAttachments(attachments: CompleteAttachment[] | undefined): FileAttachment[] {
  return (attachments ?? []).filter((a): a is FileAttachment => a.kind === 'file' && typeof a.content === 'string');
}

/**
 * Inline `file` attachments (dropped text files + `@`-mentions) as fenced blocks tagged with the
 * filename, appended after the conversation so they read as reference material. Content is already
 * read + host-capped; this only formats it. Returns '' when there are none.
 */
export function inlineAttachments(attachments: CompleteAttachment[] | undefined): string {
  const files = fileAttachments(attachments);
  if (files.length === 0) return '';
  const blocks = files.map((f) => {
    // Fence-safe (review r5): a file whose content has a ``` line would break out of a 3-backtick
    // block. Use a fence one backtick longer than the longest run in the content.
    const longest = Math.max(0, ...[...f.content.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `\`${f.path}\`:\n${fence}\n${f.content}\n${fence}`;
  });
  return `\n\nAttached files:\n\n${blocks.join('\n\n')}`;
}

/** Total UTF-8 bytes of inlined file content — guards the per-send inline ceiling (bounded-payload AC). */
function inlineByteTotal(attachments: CompleteAttachment[] | undefined): number {
  return fileAttachments(attachments).reduce((n, a) => n + Buffer.byteLength(a.content, 'utf8'), 0);
}

/** The plain-text prompt: the transcript, then any inlined file attachments. */
function assemblePrompt(parsed: CompleteRequest): string {
  const transcript = parsed.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return transcript + inlineAttachments(parsed.attachments);
}

/**
 * Build the SDK `prompt` argument. Text-only ⇒ the plain string. With images ⇒ the streaming-input
 * form: one user message carrying the text plus a base64 image content block per pasted image (read
 * from the path `__complete` was handed). A missing/unreadable image throws — the caller's try/catch
 * turns it into an inline error, never a silently dropped attachment.
 */
function buildPrompt(parsed: CompleteRequest): string | AsyncIterable<unknown> {
  const text = assemblePrompt(parsed);
  const images = (parsed.attachments ?? []).filter((a) => a.kind === 'image');
  if (images.length === 0) return text;
  // Containment (review r1, security): image paths arrive from the webview, so an unchecked read
  // is an arbitrary-file-read primitive (~/.ssh, .env → base64'd into the prompt). Every path must
  // canonicalize under the TRUSTED assetRoot the sidecar stamped (renderer-supplied roots are
  // overwritten Rust-side, like baseUrl). No root ⇒ no image reads, ever.
  if (parsed.assetRoot === undefined) {
    throw new Error('image attachments require a trusted asset root (stamped by the sidecar)');
  }
  const root = realpathSync(parsed.assetRoot);
  const content: unknown[] = [{ type: 'text', text }];
  let imageBytes = 0;
  for (const img of images) {
    const real = realpathSync(img.path); // resolves symlinks — a link out of the root is refused
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`image attachment escapes the asset root: ${img.path}`);
    }
    const size = statSync(real).size;
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(`image attachment too large (${Math.ceil(size / 1000)}KB / ${MAX_IMAGE_BYTES / 1000}KB): ${img.path}`);
    }
    // Aggregate ceiling (review r3): each image is under the per-image cap, but N of them would
    // otherwise base64 into one unbounded prompt. Bound the whole set, not just each member.
    imageBytes += size;
    if (imageBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new Error(`images exceed the ${MAX_IMAGE_TOTAL_BYTES / 1_000_000}MB total attachment limit`);
    }
    const data = readFileSync(real).toString('base64');
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType ?? 'image/png', data },
    });
  }
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
  })();
}

/**
 * Run one plain doc-editor chat completion via the Claude Code agent SDK. Auth is inherited from the
 * environment exactly like the `claude` CLI — so a `CLAUDE_CODE_OAUTH_TOKEN` subscription token works
 * with no API key (and `ANTHROPIC_API_KEY` works too). No tools are allowed, so it behaves as a
 * completion, not an agent (no filesystem/tool access); the turn cap is only a runaway stop.
 */
export async function runComplete(req: unknown, deps: CompleteDeps): Promise<CompleteResponse> {
  const parsed = validate(req);
  if ('error' in parsed) return parsed;

  // Re-check the total inline budget at the trust boundary: the webview is expected to block over-limit
  // sends, but mention/attachment content arrives from it and cannot be trusted to be within cap.
  const inlineTotal = inlineByteTotal(parsed.attachments);
  if (inlineTotal > MAX_INLINE_TOTAL_BYTES) {
    return { error: { message: `attached files exceed the ${MAX_INLINE_TOTAL_BYTES}-byte inline limit (${inlineTotal} bytes)` } };
  }

  // baseUrl comes from the project's `.vanguard/app.json` (repo content) and the inherited credential
  // follows it, so only an origin the operator allowed in their own environment may receive it.
  if (parsed.baseUrl !== undefined) {
    const refused = baseUrlRefusal(parsed.baseUrl, process.env[CHAT_ALLOWED_ORIGINS_ENV]);
    if (refused !== undefined) return { error: { message: refused } };
  }

  try {
    const stream = deps.query({
      prompt: buildPrompt(parsed),
      options: {
        allowedTools: [], // completion, not an agent — no filesystem/tool access
        settingSources: [], // don't load project/user CLAUDE.md or settings
        // NOT 1 (dogfood 2026-07-14): the SDK counts internal assistant steps (thinking, a
        // hallucinated tool call it then refuses) as turns, so maxTurns:1 intermittently dies
        // with error_max_turns before any text lands. With zero tools allowed the extra turns
        // can't act — this stays a completion, the cap is only a runaway stop.
        maxTurns: 8,
        ...(parsed.system !== undefined ? { systemPrompt: parsed.system } : {}),
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.baseUrl !== undefined ? { env: withBaseUrl(parsed.baseUrl) } : {}),
      },
    });
    for await (const msg of stream) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && typeof msg.result === 'string') return { text: msg.result };
        return { error: { message: `doc chat failed: ${msg.subtype ?? 'unknown error'}` } };
      }
    }
    return { error: { message: 'no result from the model' } };
  } catch (err) {
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Operator-local allowlist (comma-separated origins) for a non-Anthropic `chatBaseUrl`. */
export const CHAT_ALLOWED_ORIGINS_ENV = 'VANGUARD_CHAT_ALLOWED_ORIGINS';

/** The origin the inherited Anthropic credential may always be sent to. */
const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

/**
 * Why `baseUrl` may not receive the inherited credential, or undefined when it may. Allowed: the
 * Anthropic API origin, or an origin listed in `allowList` (VANGUARD_CHAT_ALLOWED_ORIGINS, the
 * operator's own environment — never repo content, which is where `chatBaseUrl` comes from).
 */
export function baseUrlRefusal(baseUrl: string, allowList: string | undefined): string | undefined {
  const origin = originOf(baseUrl);
  if (origin === undefined) return `doc chat refused: chatBaseUrl "${baseUrl}" is not an absolute http(s) URL`;
  if (origin === ANTHROPIC_ORIGIN) return undefined;
  const allowed = (allowList ?? '')
    .split(',')
    .map((entry) => originOf(entry.trim()))
    .filter((o): o is string => o !== undefined);
  if (allowed.includes(origin)) return undefined;
  return (
    `doc chat refused: chatBaseUrl origin ${origin} is not allowed to receive your Anthropic credential. ` +
    `To allow it, add it to ${CHAT_ALLOWED_ORIGINS_ENV} (comma-separated origins) in the environment Vanguard runs in.`
  );
}

/** The `scheme://host[:port]` of an absolute http(s) URL, or undefined for anything else. */
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve the inherited env (incl. the auth token) and point the SDK at a custom Anthropic-compatible base URL. */
function withBaseUrl(baseUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env['ANTHROPIC_BASE_URL'] = baseUrl;
  return env;
}

function validate(req: unknown): CompleteRequest | { error: { message: string } } {
  if (req === null || typeof req !== 'object') return { error: { message: 'invalid request' } };
  const r = req as Record<string, unknown>;
  if (!Array.isArray(r['messages']) || r['messages'].length === 0) {
    return { error: { message: 'messages must be a non-empty array' } };
  }
  for (const m of r['messages'] as unknown[]) {
    if (m === null || typeof m !== 'object') return { error: { message: 'each message must be an object' } };
    const role = (m as Record<string, unknown>)['role'];
    const content = (m as Record<string, unknown>)['content'];
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return { error: { message: 'each message needs role user|assistant and string content' } };
    }
  }
  return {
    messages: r['messages'] as CompleteRequest['messages'],
    ...(typeof r['system'] === 'string' ? { system: r['system'] } : {}),
    ...(typeof r['model'] === 'string' ? { model: r['model'] } : {}),
    ...(typeof r['baseUrl'] === 'string' ? { baseUrl: r['baseUrl'] } : {}),
    ...(Array.isArray(r['attachments']) ? { attachments: coerceAttachments(r['attachments']) } : {}),
    ...(typeof r['assetRoot'] === 'string' ? { assetRoot: r['assetRoot'] } : {}),
  };
}

/** Keep only well-formed attachment entries (kind + string path); malformed ones are dropped, never
 * fatal — a bad attachment must not sink an otherwise valid turn. */
function coerceAttachments(raw: unknown[]): CompleteAttachment[] {
  const out: CompleteAttachment[] = [];
  for (const a of raw) {
    if (a === null || typeof a !== 'object') continue;
    const rec = a as Record<string, unknown>;
    const kind = rec['kind'];
    const path = rec['path'];
    if ((kind !== 'image' && kind !== 'file') || typeof path !== 'string') continue;
    out.push({
      kind,
      path,
      ...(typeof rec['mediaType'] === 'string' ? { mediaType: rec['mediaType'] } : {}),
      ...(typeof rec['content'] === 'string' ? { content: rec['content'] } : {}),
    });
  }
  return out;
}
