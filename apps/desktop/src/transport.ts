// Transport seam between the Inspector UI and its backend. Two backends answer the same calls:
// Tauri's `invoke`/`listen` (the desktop app, and the branch vitest + dev/mockBackend.ts exercise)
// and the hub's `POST /rpc/<cmd>` + `/events` SSE stream (a browser against `vanguard hub`, no Tauri
// runtime present). Mode resolution order: the server-injected `window.__VANGUARD_HUB__` marker
// (src/hub/static.ts), then `VITE_VANGUARD_HUB=1` (the hub branch without the marker), else Tauri.
import {
  decodeResponse,
  decodeEvent,
  STREAM_RESET_EVENT,
  HUB_TOKEN_HEADER,
  HUB_TOKEN_QUERY_PARAM,
  HUB_TOKEN_FRAGMENT_PARAM,
  isHubTokenRejected,
} from './hub-wire';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

declare global {
  interface Window {
    __VANGUARD_HUB__?: boolean;
  }
}

export function isHubMode(): boolean {
  if (window.__VANGUARD_HUB__ === true) return true;
  return import.meta.env.VITE_VANGUARD_HUB === '1';
}

// Fleet spawns shell commands — remote code execution on a reachable server — so hub mode disables
// it everywhere (src/hub/rpc.ts's DISABLED_COMMANDS rejects the underlying calls too).
export function canUseFleet(): boolean {
  return !isHubMode();
}

/** A hub restart mints a fresh per-launch token (src/hub/server.ts), so the one this tab holds
 * stops working: `/rpc/*` answers 401 and `/events` answers 401, which makes the browser close the
 * `EventSource` for good instead of reconnecting. Nothing the page can do fixes that — only opening
 * the new launch URL the hub printed hands it the new token — so both signals land here and the UI
 * says so (App.tsx) rather than going quietly stale. */
const restartHandlers = new Set<() => void>();
const EVENT_SOURCE_CLOSED = 2;

const HUB_TOKEN_STORAGE_KEY = 'vanguard-hub-token';

function fragmentToken(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(HUB_TOKEN_FRAGMENT_PARAM);
}

/** Move the launch URL's `#token=…` (src/cli/hub.ts) into sessionStorage and strip it from the
 * address bar, so it is neither bookmarked nor left in history. The server never sees a fragment and
 * never serves the token, so this is the only way a browser page gets one. No-op without the
 * fragment. A fresh launch URL overwrites a stored token from an earlier hub launch. */
export function captureHubToken(): void {
  const token = fragmentToken();
  if (token === null) return;
  try {
    window.sessionStorage.setItem(HUB_TOKEN_STORAGE_KEY, token);
  } catch {
    return; // Storage blocked: keep the fragment, `hubToken()` reads it from there instead.
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete(HUB_TOKEN_FRAGMENT_PARAM);
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${rest === '' ? '' : `#${rest}`}`);
}

/** This tab's token, or '' when it has none — the hub answers 401 either way, which is the signal
 * below. */
function hubToken(): string {
  captureHubToken();
  const fromFragment = fragmentToken();
  if (fromFragment !== null) return fromFragment;
  try {
    return window.sessionStorage.getItem(HUB_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function notifyHubRestarted(): void {
  for (const h of restartHandlers) h();
}

/** Register a callback for "this page's hub token is dead, reload". No-op under Tauri. */
export function onHubRestart(handler: () => void): Promise<UnlistenFn> {
  if (!isHubMode()) return Promise.resolve(() => {});
  restartHandlers.add(handler);
  return Promise.resolve(() => {
    restartHandlers.delete(handler);
  });
}

async function hubInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/rpc/${cmd}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HUB_TOKEN_HEADER]: hubToken() },
      body: JSON.stringify(args ?? {}),
    });
  } catch (err) {
    // Network failure (server unreachable, CORS, etc.) — reject with a string, like Tauri's Err(String).
    throw err instanceof Error ? err.message : String(err);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw err instanceof Error ? err.message : String(err);
  }
  // Only the hub's own 401 envelope means "this page's token is dead"; a reverse proxy's 401 is a
  // different problem, and telling the operator to reload would be wrong (docs/hub.md).
  if (response.status === 401 && isHubTokenRejected(body)) notifyHubRestarted();
  return decodeResponse<T>(response.status, body);
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isHubMode() ? hubInvoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

/** One lazily created `EventSource('/events?token=…')` shared by every `subscribe()` call, routed by
 * event name. Module-level so every caller — regardless of which component mounted first — shares it. */
let hubSource: EventSource | undefined;
interface HubSubscription {
  listener: (ev: MessageEvent) => void;
  handlers: Set<(event: { payload: unknown }) => void>;
}
const hubSubscriptions = new Map<string, HubSubscription>();

/** Callbacks re-run on `stream-reset` (src/hub/events.ts): a reconnect gap too large for the ring
 * buffer to replay, so the realtime stream alone can no longer be trusted — each callback re-fetches
 * its own snapshot (e.g. listRuns/listActive) to recover whatever the gap may have dropped (#491). */
const resyncHandlers = new Set<() => void>();

/** Create the shared `EventSource` on first use and wire its one `stream-reset` listener — attached
 * once per instance, independent of which named subscriptions come and go. */
function ensureHubSource(): EventSource {
  if (hubSource) return hubSource;
  const source = new EventSource(`/events?${HUB_TOKEN_QUERY_PARAM}=${encodeURIComponent(hubToken())}`);
  source.addEventListener(STREAM_RESET_EVENT, () => {
    for (const h of resyncHandlers) h();
  });
  // An `error` on a live stream is a transient drop the browser retries on its own; CLOSED means it
  // gave up, which is what the restarted hub's 401 on `/events` looks like from here.
  source.addEventListener('error', () => {
    if (source.readyState === EVENT_SOURCE_CLOSED) notifyHubRestarted();
  });
  hubSource = source;
  return source;
}

/** Close the shared `EventSource` once nothing — named subscription or resync callback — still needs it. */
function closeHubSourceIfIdle(): void {
  if (hubSubscriptions.size === 0 && resyncHandlers.size === 0 && hubSource) {
    hubSource.close();
    hubSource = undefined;
  }
}

function hubSubscribe<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  const source = ensureHubSource();
  let sub = hubSubscriptions.get(name);
  if (!sub) {
    const handlers = new Set<(event: { payload: unknown }) => void>();
    const listener = (ev: MessageEvent): void => {
      const decoded = decodeEvent(name, ev.data);
      if (decoded.reset) return; // handled by the dedicated stream-reset listener, never reached here
      const event = { payload: decoded.payload };
      for (const h of handlers) h(event);
    };
    sub = { listener, handlers };
    hubSubscriptions.set(name, sub);
    source.addEventListener(name, listener);
  }
  sub.handlers.add(handler as (event: { payload: unknown }) => void);

  const unlisten: UnlistenFn = () => {
    sub!.handlers.delete(handler as (event: { payload: unknown }) => void);
    if (sub!.handlers.size === 0) {
      hubSource?.removeEventListener(name, sub!.listener);
      hubSubscriptions.delete(name);
    }
    closeHubSourceIfIdle();
  };
  return Promise.resolve(unlisten);
}

export function subscribe<T>(name: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  return isHubMode() ? hubSubscribe<T>(name, handler) : tauriListen<T>(name, handler);
}

/**
 * Register a callback to re-run when the hub's SSE stream reports a `stream-reset` (#491) — a
 * reconnect gap the replay ring couldn't cover. No-op under Tauri, which has no SSE gap to resync.
 */
export function onStreamReset(handler: () => void): Promise<UnlistenFn> {
  if (!isHubMode()) return Promise.resolve(() => {});
  ensureHubSource();
  resyncHandlers.add(handler);
  const unlisten: UnlistenFn = () => {
    resyncHandlers.delete(handler);
    closeHubSourceIfIdle();
  };
  return Promise.resolve(unlisten);
}
