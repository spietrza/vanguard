// Port of the doc-chat one-shot completion path in apps/desktop/src-tauri/src/sidecar.rs
// (api_complete / api_cancel_complete / set_base_url / set_asset_root / complete_exchange) — minus
// the Tauri wrapper. Kept as a per-turn CHILD PROCESS (`vanguard __complete`), not an in-process call:
// src/api/complete.ts's `runComplete` takes no AbortSignal, so in-process cancellation would require
// editing it; the proven per-turn child + registry gives Stop-button cancellation for free.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { readAppConfig } from './app-config.js';
import { BadRequestError } from '../sidecar/sidecar.js';

/** Allowlist, deliberately not an Omit<> of some wider type: every field here is one the caller is
 * permitted to send. A new field must be added HERE to cross the RPC boundary (mirrors ipc.ts's
 * CompleteParams and the same rule stated there — a denylist would auto-expose it). */
export interface CompleteParams {
  system?: unknown;
  messages: unknown;
  model: string;
  attachments?: unknown;
}

export interface CompleteResult {
  text?: string;
  error?: { message: string };
}

/** Wall-clock cap on one doc-chat turn — mirrors sidecar.rs's COMPLETE_TIMEOUT. */
export const COMPLETE_TIMEOUT_MS = 180_000;

export type SpawnComplete = () => ChildProcess;

// ponytail: at most 3 doc-chat turns in flight per hub — each is a child process holding a model
// call for up to COMPLETE_TIMEOUT_MS, so an unbounded caller could fork without limit.
export const MAX_CONCURRENT_COMPLETES = 3;

/** A doc-chat turn refused because MAX_CONCURRENT_COMPLETES are already running; the server maps it
 * to HTTP 429 (src/hub/server.ts). */
export class CompleteBusyError extends BadRequestError {
  constructor() {
    super(`too many doc chat requests in flight (max ${MAX_CONCURRENT_COMPLETES}) — wait for one to finish and retry`);
  }
}

/** Resolve the `vanguard __complete` entry point without assuming `vanguard` is on PATH: the hub may
 * run from `dist/cli/index.js` or under `tsx`, so re-invoke the current process's own entry script.
 * Falls back to `vanguard` on PATH when the current script path is unknown (e.g. a REPL). */
function defaultSpawnComplete(): ChildProcess {
  const selfScript = process.argv[1];
  if (selfScript !== undefined) {
    return spawn(process.execPath, [selfScript, '__complete'], { stdio: ['pipe', 'pipe', 'inherit'] });
  }
  return spawn('vanguard', ['__complete'], { stdio: ['pipe', 'pipe', 'inherit'] });
}

function exchange(child: ChildProcess, req: unknown, timeoutMs: number): Promise<CompleteResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`doc chat timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref?.();

    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString('utf8');
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line !== '') {
          try {
            const parsed = JSON.parse(line) as CompleteResult;
            settled = true;
            clearTimeout(timer);
            resolve(parsed);
            return;
          } catch {
            // Not the JSON response line (stray noise) — keep reading.
          }
        }
        idx = buf.indexOf('\n');
      }
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('vanguard __complete produced no response'));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.stdin?.write(`${JSON.stringify(req)}\n`);
    child.stdin?.end();
  });
}

/**
 * Registry of in-flight `__complete` children, keyed by the caller's opaque `callId` — so the doc
 * chat's Stop button can kill exactly its own turn's child, never the run child, never an arbitrary
 * caller-supplied pid. An unknown/finished id is a silent no-op.
 */
export class CompleteRegistry {
  private readonly children = new Map<string, ChildProcess>();
  private inFlight = 0;

  constructor(
    private readonly spawnComplete: SpawnComplete = defaultSpawnComplete,
    private readonly timeoutMs: number = COMPLETE_TIMEOUT_MS,
    private readonly maxConcurrent: number = MAX_CONCURRENT_COMPLETES,
  ) {}

  async complete(repoPath: string, params: CompleteParams, callId?: string): Promise<CompleteResult> {
    if (this.inFlight >= this.maxConcurrent) throw new CompleteBusyError();
    // Spawn + register BEFORE any await: a Stop click racing this call must always find the child it
    // is trying to cancel, so registration cannot wait on an async read (readAppConfig below).
    const child = this.spawnComplete();
    this.inFlight += 1;
    if (callId !== undefined) {
      this.children.set(callId, child);
    }
    try {
      // Trust rules (same discipline as api_create_task's source/team/label): the caller cannot choose
      // where the credential goes (baseUrl) or the image-containment root (assetRoot) — both are
      // substituted from the trusted side, never read from the caller's params object. Building the
      // request object field-by-field is itself the CompleteParams allowlist enforcement.
      const trusted = (await readAppConfig(repoPath)).chatBaseUrl;
      const req: Record<string, unknown> = {
        ...(params.system !== undefined ? { system: params.system } : {}),
        messages: params.messages,
        model: params.model,
        ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
        ...(trusted !== undefined ? { baseUrl: trusted } : {}),
        assetRoot: join(repoPath, '.vanguard', 'drafts'),
      };
      return await exchange(child, req, this.timeoutMs);
    } finally {
      this.inFlight -= 1;
      if (callId !== undefined) this.children.delete(callId);
      child.kill();
    }
  }

  /** Kill the in-flight `__complete` child for a doc-chat call id — the Stop button. */
  cancel(callId: string): void {
    const child = this.children.get(callId);
    if (child !== undefined) {
      this.children.delete(callId);
      child.kill();
    }
  }
}
