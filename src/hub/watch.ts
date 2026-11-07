// Port of apps/desktop/src-tauri/src/watch.rs — see that file for the original Rust implementation; adds a polling fallback for Docker bind mounts.
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRunsRoot, fnv1a, runsFingerprint } from './runs.js';

const DEBOUNCE_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Shape of `node:fs`'s `watch`, narrowed to the overload this module calls — injectable so tests
 * can drive deterministic fake events instead of racing the platform's real file-watching backend
 * (FSEvents on macOS delivers extra/coalesced events compared to inotify on Linux). */
export type WatchFn = (
  target: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => FSWatcher;

export interface WatchOptions {
  /** Force polling even when fs.watch works (VANGUARD_HUB_WATCH_POLL=1). */
  forcePoll?: boolean;
  /** Polling interval in ms (VANGUARD_HUB_WATCH_INTERVAL_MS, default 2000). */
  pollIntervalMs?: number;
  /** Injectable replacement for `fs.watch`, for tests. Defaults to the real `fs.watch`. */
  watchFn?: WatchFn;
}

/**
 * True for paths under `<repo>/.vanguard/drafts/` — matched structurally (adjacent components)
 * so a repo directory that happens to be NAMED `drafts` elsewhere is not filtered.
 */
export function isDraftPath(p: string): boolean {
  const comps = p.split(/[/\\]/).filter((c) => c.length > 0);
  for (let i = 0; i < comps.length; i += 1) {
    if (comps[i] === '.vanguard') {
      return comps[i + 1] === 'drafts';
    }
  }
  return false;
}

/**
 * Cheap, order-independent, stat-only change-detector for a sessions tree: folds each file's
 * path (relative to root) + mtime together without reading contents. Missing/empty tree -> 0.
 */
async function sessionsFingerprint(sessionsRoot: string): Promise<number> {
  let fp = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        let mtimeMs = 0;
        try {
          const info = await stat(path);
          mtimeMs = info.mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        fp = (fp + fnv1a(`${path}:${mtimeMs}`)) >>> 0;
      }
    }
  }

  await walk(sessionsRoot);
  return fp;
}

interface WatchEntry {
  dispose: () => void;
}

/**
 * Watch a repo's `.vanguard/` (or the repo root, non-recursively, if `.vanguard` doesn't exist yet)
 * for changes, debounced 300ms, calling `onChange(repoPath)` once per debounced burst.
 */
export class WatchRegistry {
  private readonly forcePoll: boolean;
  private readonly pollIntervalMs: number;
  private readonly watchFn: WatchFn;
  private readonly entries = new Map<string, WatchEntry>();

  constructor(opts?: WatchOptions) {
    this.forcePoll = opts?.forcePoll ?? false;
    this.pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.watchFn = opts?.watchFn ?? watch;
  }

  /** Start (or replace) a watcher for repoPath. */
  watchProject(repoPath: string, onChange: (repoPath: string) => void): void {
    // Replace any existing watcher for this path (idempotent re-entry).
    this.unwatchProject(repoPath);

    if (this.forcePoll) {
      this.entries.set(repoPath, this.startPolling(repoPath, onChange));
      return;
    }

    const vanguardDir = join(repoPath, '.vanguard');
    const recursive = existsSync(vanguardDir);
    const target = recursive ? vanguardDir : repoPath;

    try {
      const entry = this.startWatching(target, recursive, repoPath, onChange);
      this.entries.set(repoPath, entry);
    } catch {
      // Synchronous setup failure (unsupported recursive watch on this platform, ENOSPC from
      // inotify limits, target doesn't exist yet) — fall back to polling instead of throwing.
      this.entries.set(repoPath, this.startPolling(repoPath, onChange));
    }
  }

  /** Stop watching repoPath (no-op if not watched). */
  unwatchProject(repoPath: string): void {
    const entry = this.entries.get(repoPath);
    if (entry === undefined) return;
    entry.dispose();
    this.entries.delete(repoPath);
  }

  /** Dispose every active watcher (server shutdown). */
  closeAll(): void {
    for (const repoPath of [...this.entries.keys()]) {
      this.unwatchProject(repoPath);
    }
  }

  private startWatching(
    target: string,
    recursive: boolean,
    repoPath: string,
    onChange: (repoPath: string) => void,
  ): WatchEntry {
    let timer: NodeJS.Timeout | undefined;
    let sawNonDraft = false;
    let sawAny = false;

    const flush = (): void => {
      timer = undefined;
      if (sawAny && !sawNonDraft) {
        // Every path recorded since the last emit was a draft path — mirrors Rust:
        // "event.paths.iter().all(is_draft_path)" skips the whole event.
        sawAny = false;
        return;
      }
      sawAny = false;
      sawNonDraft = false;
      onChange(repoPath);
    };

    // Wrapped in try/catch by the caller to detect synchronous setup failure.
    const fsWatcher: FSWatcher = this.watchFn(target, { recursive }, (_event, filename) => {
      sawAny = true;
      if (filename === null || filename === undefined) {
        // Node doesn't guarantee `filename` on every platform — fail open so a real change is
        // never silently dropped.
        sawNonDraft = true;
      } else if (!isDraftPath(join(target, filename))) {
        // `filename` is relative to the watched root, which in recursive mode IS `.vanguard`
        // itself — rejoin against `target` so the structural `.vanguard`/`drafts` check (which
        // mirrors the Rust version's full absolute paths) sees that path component at all.
        sawNonDraft = true;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });

    // fs.watch can also fail AFTER setup succeeds (ENOSPC from inotify limits, the watched path
    // being removed, etc.) — that arrives as an async 'error' event, not a throw, and an
    // EventEmitter with no 'error' listener crashes the whole process. Fall back to polling here
    // too, the same way the synchronous setup failure does in watchProject's catch.
    fsWatcher.on('error', () => {
      if (timer !== undefined) clearTimeout(timer);
      fsWatcher.close();
      this.entries.set(repoPath, this.startPolling(repoPath, onChange));
    });

    return {
      dispose: (): void => {
        if (timer !== undefined) clearTimeout(timer);
        fsWatcher.close();
      },
    };
  }

  private startPolling(repoPath: string, onChange: (repoPath: string) => void): WatchEntry {
    const runsRoot = defaultRunsRoot(repoPath);
    const sessionsRoot = join(repoPath, '.vanguard', 'sessions');

    let prevRuns = 0;
    let prevSessions = 0;
    let initialized = false;
    let polling = false;

    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const [runs, sessions] = await Promise.all([runsFingerprint(runsRoot), sessionsFingerprint(sessionsRoot)]);
        if (!initialized) {
          prevRuns = runs;
          prevSessions = sessions;
          initialized = true;
          return;
        }
        if (runs !== prevRuns || sessions !== prevSessions) {
          prevRuns = runs;
          prevSessions = sessions;
          onChange(repoPath);
        }
      } finally {
        polling = false;
      }
    };

    // Seed the baseline immediately so the first real interval tick can detect a change.
    void poll();

    const interval = setInterval(() => {
      void poll();
    }, this.pollIntervalMs);

    return {
      dispose: (): void => {
        clearInterval(interval);
      },
    };
  }
}
