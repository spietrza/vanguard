// GENERATED from src/hub-wire.ts — do not edit; run pnpm gen:wire
/**
 * The hub's wire codec: encoding and RPC response decoding for the RPC envelope, SSE frames and the hub marker, shared
 * by the server (`src/hub/*.ts`) and the browser (`apps/desktop/src/transport.ts`). See
 * docs/hub.md § Wire format.
 *
 * RULES (enforced by src/wire.test.ts):
 * - ZERO imports, static or dynamic — must be safe in both plain Node and the browser.
 * - `pnpm gen:wire` copies this file verbatim (plus a header) to apps/desktop/src/hub-wire.ts; the
 *   drift test byte-compares them. Change here ⇒ regenerate, or root CI fails naming the fix.
 */

/** Injected by `src/hub/static.ts` right after `<head>`; `apps/desktop/src/transport.ts`'s
 * `isHubMode()` reads `window.__VANGUARD_HUB__` to pick the hub (fetch/SSE) branch over Tauri's
 * invoke/listen. */
export const HUB_MARKER = '<script>window.__VANGUARD_HUB__=true</script>';

/** Per-launch auth token (src/hub/server.ts), carried on every `/rpc/*` request as this header and
 * on `/events` (an `EventSource` cannot set headers) as this query parameter. Both sides read the
 * same two names from here so they cannot drift. */
export const HUB_TOKEN_HEADER = 'x-vanguard-hub-token';
export const HUB_TOKEN_QUERY_PARAM = 'token';

/** `BadRequestError`/`FlowError`/`VanguardError` are caller-correctable (`bad-request`); anything
 * else is a real fault (`internal`) — `src/hub/rpc.ts`'s `classifyError` is the one place that maps
 * a thrown value to this vocabulary. */
export type ErrorKind = 'bad-request' | 'internal';

export interface WireError {
  message: string;
  kind: ErrorKind;
}

/** The hub's one success envelope for `POST /rpc/<cmd>`: `200 {result}` (`null` for void commands,
 * `false` survives — only `undefined` is coalesced away). */
export function encodeResult(value: unknown): { result: unknown } {
  return { result: value ?? null };
}

/**
 * The hub's one error envelope. `status` defaults from `kind` (400/500) but a caller with its own
 * HTTP status (404 not-found, 405 method-not-allowed, 413 body-too-large) passes it explicitly —
 * only the JSON body shape is fixed here.
 */
export function encodeError(error: WireError, status?: number): { status: number; body: { error: WireError } } {
  return { status: status ?? (error.kind === 'bad-request' ? 400 : 500), body: { error } };
}

/**
 * Decode one `/rpc/<cmd>` response. Throws the server's message string (never returns `undefined`):
 * a non-2xx status throws `error.message` (or a fallback naming the status), and a 2xx body without
 * a `result` key throws too — the #484 bug was a bare body silently becoming `undefined` instead.
 */
export function decodeResponse<T>(status: number, body: unknown): T {
  if (status < 200 || status >= 300) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw typeof message === 'string' ? message : `request failed with status ${status}`;
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !Object.prototype.hasOwnProperty.call(body, 'result') ||
    (body as { result: unknown }).result === undefined
  ) {
    throw 'hub response body is missing "result"';
  }
  return (body as { result: T }).result;
}

/** The one SSE event the wire carries no application payload for: a reconnect gap too large for
 * the ring buffer to replay (`src/hub/events.ts`). Clients can use it to trigger a resync. */
export const STREAM_RESET_EVENT = 'stream-reset';

/** One SSE frame, `src/hub/events.ts`'s shape: `id: <n>\nevent: <name>\ndata: <json>\n\n`. `id`
 * omitted (no `id:` line) for a frame outside the replay ring, e.g. `stream-reset`. */
export function encodeEvent(id: number | undefined, name: string, data: unknown): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type DecodedEvent = { reset: true } | { reset: false; payload: unknown };

/** Decode one SSE event's `(name, data)` pair as `EventSource` delivers it. `stream-reset` carries
 * no usable payload — the caller resyncs (re-runs its snapshot fetches) instead of reading `data`. */
export function decodeEvent(name: string, data: string): DecodedEvent {
  if (name === STREAM_RESET_EVENT) return { reset: true };
  try {
    return { reset: false, payload: JSON.parse(data) };
  } catch {
    return { reset: false, payload: data };
  }
}

