import { Button, Chip } from '@/ui';
import { RefreshCw, Square } from 'lucide-react';
import type { TypedRunState } from './typedRunReducer';

/** Renders the folded typed-run state: stage progress row, live spend, terminal. */
export function RunStrip({ state, onCancel }: { state: TypedRunState; onCancel: () => void }) {
  const { stages, stageState, usdSpent, warnings, terminal } = state;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{state.taskId ?? 'starting…'}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">~${usdSpent.toFixed(2)}</span>
        {terminal === undefined && (
          <Button variant="text" color="destructive" onClick={onCancel} startIcon={<Square className="size-3.5" />}>
            Kill
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {stages.map((name, i) => {
          const phase = stageState[i] ?? 'pending';
          return (
            <span
              key={i}
              data-testid={`stage-${i}`}
              data-phase={phase}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                phase === 'done'
                  ? 'border-emerald-600 text-emerald-500'
                  : phase === 'failed'
                    ? 'border-rose-600 text-rose-500'
                    : phase === 'running'
                      ? 'border-blue-600 text-blue-500'
                      : 'border-border text-muted-foreground opacity-60'
              }`}
            >
              {phase === 'running' && terminal === undefined && (
                <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              )}
              {name}
            </span>
          );
        })}
      </div>
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((message, i) => (
            <div
              key={i}
              data-testid="run-warning"
              className="rounded border border-amber-600/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600"
            >
              {message}
            </div>
          ))}
        </div>
      )}
      {terminal !== undefined && (
        <div className="text-xs">
          {terminal.kind === 'success' && terminal.prUrl !== undefined && (
            <a href={terminal.prUrl} className="text-blue-500 underline">
              View PR
            </a>
          )}
          {terminal.kind === 'no-changes' && (
            <Chip color="secondary" variant="outlined">
              no PR (no changes)
            </Chip>
          )}
          {terminal.kind === 'secret-blocked' && (
            <Chip color="destructive" variant="outlined">
              secret-blocked
            </Chip>
          )}
          {terminal.kind === 'error' && (
            <Chip color="destructive" variant="outlined">
              error: {terminal.message}
            </Chip>
          )}
          {terminal.kind === 'cancelled' && (
            <Chip color="secondary" variant="outlined">
              cancelled
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}
