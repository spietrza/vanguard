// Port of apps/desktop/src-tauri/src/active.rs — see that file for the original Rust implementation.
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENROUTER_PRICING } from '../core/openrouter-pricing.js';
import { readTextNoSymlink } from './runs.js';

export interface ActiveRun {
  taskId: string;
  sessionFile: string;
  lastActivityMs: number;
}

export interface TranscriptEntry {
  /** "assistant" (agent prose) or "tool" (a tool invocation name). */
  role: 'assistant' | 'tool';
  text: string;
}

export interface SessionRead {
  entries: TranscriptEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Live spend estimate in USD, priced per-message off each message's own model. Unknown models
   * contribute nothing, so this is a lower bound — surface it as "~$" in the UI, never as exact.
   */
  estCostUsd: number;
}

/** A session is considered "running" only if its newest line was written this recently. */
export const ACTIVE_WINDOW_MS = 120_000;

/**
 * USD per 1M tokens as [input, output, cacheRead], read straight from src/core/openrouter-pricing.ts
 * OPENROUTER_PRICING — the single source of truth also used by src/core/run-summary.ts. A hand-kept
 * second copy here previously went stale (e.g. still pricing `claude-opus-5-5` at the prior
 * generation's rate); importing the table means a price update only has to happen once.
 */
function modelPrice(model: string): [number, number, number] | undefined {
  const p = OPENROUTER_PRICING[model];
  if (p === undefined) return undefined;
  return [p.input, p.output, p.cacheRead];
}

/** A future mtime (clock skew) counts as "just now". */
function within(t: number, now: number, w: number): boolean {
  return now - t <= w;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === 'number' ? value : 0;
}

async function newestJsonl(dir: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const e of entries) {
    if (!e.name.endsWith('.jsonl')) continue;
    const path = join(dir, e.name);
    try {
      // lstat: a symlinked or non-regular `.jsonl` is never offered as a session to tail.
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (best === undefined || info.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: info.mtimeMs };
      }
    } catch {
      // skip unreadable entries
    }
  }
  return best;
}

async function newestRecordMtime(runsTaskDir: string): Promise<number | undefined> {
  let entries;
  try {
    entries = await readdir(runsTaskDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  for (const e of entries) {
    const n = e.name;
    if (!n.endsWith('.json') || n.endsWith('.proof.json') || n.endsWith('.visual-proof.json')) continue;
    try {
      const info = await stat(join(runsTaskDir, n));
      newest = newest === undefined ? info.mtimeMs : Math.max(newest, info.mtimeMs);
    } catch {
      // skip unreadable entries
    }
  }
  return newest;
}

/**
 * In-flight runs: a task whose newest session line was written within the window, and which has
 * NOT just written a completed run record (a fresh record means the run finished — show it as done).
 */
export async function listActive(repoPath: string): Promise<ActiveRun[]> {
  const sessions = join(repoPath, '.vanguard', 'sessions');
  const runs = join(repoPath, '.vanguard', 'runs');
  const now = Date.now();
  const out: ActiveRun[] = [];

  let entries;
  try {
    entries = await readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }

  for (const task of entries) {
    if (!task.isDirectory()) continue;
    const found = await newestJsonl(join(sessions, task.name));
    if (found === undefined) continue;
    const { path: file, mtimeMs } = found;
    if (!within(mtimeMs, now, ACTIVE_WINDOW_MS)) continue;
    const taskId = task.name;
    const rec = await newestRecordMtime(join(runs, taskId));
    if (rec !== undefined && within(rec, now, ACTIVE_WINDOW_MS)) {
      continue; // run just finished — belongs in the completed list, not here
    }
    out.push({ taskId, sessionFile: file, lastActivityMs: mtimeMs });
  }

  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

/**
 * Path is caller-supplied — only read Vanguard session logs
 * (`…/.vanguard/sessions/<task>/<file>.jsonl`). A substring check on "sessions"
 * would read any `.jsonl` anywhere; require the real `.vanguard/sessions` segments.
 */
export function isSessionPath(p: string): boolean {
  if (p.includes('..')) return false;
  if (!p.endsWith('.jsonl')) return false;
  const comps = p.split(/[\\/]+/).filter((c) => c.length > 0);
  for (let i = 0; i + 1 < comps.length; i += 1) {
    if (comps[i] === '.vanguard' && comps[i + 1] === 'sessions') return true;
  }
  return false;
}

/**
 * Parse a Claude session `.jsonl` into a readable stream: assistant prose + tool-invocation names.
 * Tool results, attachments and queue ops are skipped (noise for a live view).
 */
export async function readSession(sessionFile: string): Promise<SessionRead> {
  const content = await readTextNoSymlink(sessionFile);
  const entries: TranscriptEntry[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let estCostUsd = 0;

  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const obj = v as Record<string, unknown>;
    if (obj.type !== 'assistant') continue;
    const message = obj.message;
    if (typeof message !== 'object' || message === null) continue;
    const messageObj = message as Record<string, unknown>;

    const usage = messageObj.usage;
    if (typeof usage === 'object' && usage !== null) {
      const usageObj = usage as Record<string, unknown>;
      const it = numberField(usageObj, 'input_tokens');
      const ot = numberField(usageObj, 'output_tokens');
      const cr = numberField(usageObj, 'cache_read_input_tokens');
      inputTokens += it;
      outputTokens += ot;
      cacheReadTokens += cr;
      const model = messageObj.model;
      if (typeof model === 'string') {
        const price = modelPrice(model);
        if (price !== undefined) {
          const [pi, po, pc] = price;
          estCostUsd += (it * pi + ot * po + cr * pc) / 1_000_000;
        }
      }
    }

    const blocks = messageObj.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (typeof b !== 'object' || b === null) continue;
      const block = b as Record<string, unknown>;
      if (block.type === 'text') {
        const text = block.text;
        if (typeof text === 'string' && text.trim() !== '') {
          entries.push({ role: 'assistant', text });
        }
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        entries.push({ role: 'tool', text: name });
      }
    }
  }

  return { entries, inputTokens, outputTokens, cacheReadTokens, estCostUsd };
}
