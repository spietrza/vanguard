import { useEffect, useState } from 'react';
import { Button, Chip } from '@/ui';
import { Minus, Plus } from 'lucide-react';
import { subscribe as listen } from '../../transport';
import { spawnRun, killRun, listSpawns, listTasks, SPAWN_OUTPUT_EVENT, SPAWN_EXIT_EVENT } from '../../ipc';
import { useAppConfig, useAsync } from '../../hooks';
import { watchArgv } from '../../command';
import { boardCountLabels } from '../board/counts';
import { LaunchPanel, type Spawn } from '../inspector/LaunchPanel';
import type { ActiveRun } from '../../vanguard-output';

export function Fleet({ project, active }: { project: string; active: ActiveRun[] }) {
  const [cfg] = useAppConfig(project);
  const [concurrency, setConcurrency] = useState(3);
  const [loopV1, setLoopV1] = useState(false);
  const [source, setSource] = useState('github');
  const [spawn, setSpawn] = useState<Spawn | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fleet reads the board itself, once per project (no polling): a count handed down from the last
  // board visit is stale the moment the factory claims a task, and Fleet is reachable without ever
  // opening the board. Null while it loads or if it fails — nothing is honest there, `0` is not.
  const board = useAsync(() => listTasks(project), [project]);
  const waiting = boardCountLabels(board.data)?.waiting ?? null;

  // Seed the editable controls from saved config once it loads.
  useEffect(() => {
    if (cfg.concurrency) setConcurrency(cfg.concurrency);
    if (cfg.source) setSource(cfg.source);
  }, [cfg]);

  // On mount, reconcile against the backend spawn registry so the toggle survives navigation.
  useEffect(() => {
    listSpawns()
      .then((spawns) => {
        const existing = spawns.find(
          (s) => s.cwd === project && s.command.includes('vanguard watch'),
        );
        if (existing) {
          setSpawn((prev) =>
            // Only restore if we don't already have a live entry for this pid.
            prev && prev.pid === existing.pid ? prev : { pid: existing.pid, command: existing.command, lines: [] },
          );
        }
      })
      .catch(() => {
        /* ignore — backend not available yet */
      });
  }, [project]);

  // Stream output and exit events for the current watch spawn.
  useEffect(() => {
    const unOut = listen<{ pid: number; line: string }>(SPAWN_OUTPUT_EVENT, (e) => {
      setSpawn((prev) =>
        prev && prev.pid === e.payload.pid
          ? { ...prev, lines: [...prev.lines.slice(-499), e.payload.line] }
          : prev,
      );
    });
    const unExit = listen<{ pid: number; code: number | null }>(SPAWN_EXIT_EVENT, (e) => {
      setSpawn((prev) =>
        prev && prev.pid === e.payload.pid ? { ...prev, exit: e.payload.code } : prev,
      );
    });
    return () => {
      void unOut.then((f) => f());
      void unExit.then((f) => f());
    };
  }, []);

  const running = spawn !== null && spawn.exit === undefined;

  const start = async (): Promise<void> => {
    // The argv is built from repo config: watchArgv validates source/provider (throws), and
    // spawn_run runs it without a shell, so no config value can become shell syntax.
    let argv: string[];
    try {
      argv = watchArgv(cfg, { source, concurrency, loopV1 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    try {
      const pid = await spawnRun(project, argv);
      setSpawn({ pid, command: argv.join(' '), lines: [] });
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async (): Promise<void> => {
    if (spawn && spawn.exit === undefined) {
      await killRun(spawn.pid);
      // Optimistically mark stopped so the UI is never permanently stuck if spawn:exit is missed.
      // spawn:exit will overwrite this with the real exit code when it arrives.
      setSpawn((prev) => (prev && prev.exit === undefined ? { ...prev, exit: null } : prev));
    }
  };

  const slots = Array.from({ length: concurrency }, (_, i) => active[i] ?? null);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Fleet</h2>
        {running && (
          <Button className="ml-auto" variant="outlined" color="destructive" onClick={stop}>
            Stop all
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border p-5">
        <div className="flex items-center gap-2">
          <span className="font-medium">Watch Loop</span>
          <Chip color={running ? 'success' : 'secondary'} variant="outlined">
            {running ? 'running' : 'stopped'}
          </Chip>
          <button
            onClick={running ? stop : start}
            aria-label="Toggle watch loop"
            className={`relative ml-auto h-6 w-11 rounded-full transition-colors ${running ? 'bg-success' : 'bg-muted'}`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${running ? 'left-[22px]' : 'left-0.5'}`}
            />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          list ready Tasks → Claim → Run, autonomously, until stopped
        </p>

        <div className="flex flex-wrap items-center gap-8 border-t border-border pt-4">
          <div>
            <div className="text-sm">Concurrency</div>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => setConcurrency((c) => Math.max(1, c - 1))}
                disabled={running}
                className="grid size-7 place-items-center rounded border border-border disabled:opacity-40"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="w-8 text-center tabular-nums">{concurrency}</span>
              <button
                onClick={() => setConcurrency((c) => c + 1)}
                disabled={running}
                className="grid size-7 place-items-center rounded border border-border disabled:opacity-40"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={loopV1} onChange={(e) => setLoopV1(e.target.checked)} disabled={running} />
            Loop v1 <span className="text-muted-foreground">— cheap spec-generation pass first</span>
          </label>
          <div className="ml-auto">
            <div className="text-xs text-muted-foreground">
              Slots {active.length} / {concurrency} in use{waiting === null ? '' : ` · ${waiting} waiting`}
            </div>
            <div className="mt-1 h-1.5 w-40 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-success transition-all"
                style={{ width: `${Math.min(100, (active.length / concurrency) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {spawn && (
        <LaunchPanel
          spawn={spawn}
          onKill={(pid) => {
            void killRun(pid);
            // Mirror stop()'s optimistic mark so the panel Kill can't leave a stuck "running" if spawn:exit is missed.
            setSpawn((prev) => (prev && prev.pid === pid && prev.exit === undefined ? { ...prev, exit: null } : prev));
          }}
          onDismiss={(_pid) => setSpawn(null)}
        />
      )}

      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Claimed / Running</div>
      <div className="space-y-2">
        {slots.map((a, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm">
            <span className="text-xs text-muted-foreground">slot {i + 1}</span>
            {a ? (
              <>
                <span className="size-2 rounded-full bg-success" />
                <span className="font-mono font-medium">{a.taskId}</span>
                <Chip color="success" variant="outlined">running</Chip>
              </>
            ) : (
              <span className="text-muted-foreground">idle — polling for ready Tasks</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
