import { appendFile } from 'node:fs/promises';
import { stageMetric } from './run-metric.js';
import { redactForPublish } from './secret-scan.js';
import type { SummaryOutcome } from './run-summary.js';

/** How a run ended, as the job summary states it. */
export type StepSummaryExit = 'completed' | 'verify-failed' | 'secret-blocked' | 'no-changes' | 'error';

/** One run's block in the GitHub Actions job summary — built from the same outcomes as metrics.jsonl. */
export interface StepSummary {
  taskId: string;
  flow: string;
  provider: string;
  /** Model the implementer (or reviewer) ran on, when known. */
  model?: string;
  outcomes: ReadonlyArray<SummaryOutcome>;
  exit: StepSummaryExit;
  prUrl?: string;
  /** Review runs: the stated verdict. */
  verdict?: string;
  /** Review runs: the stated risk level, directly after the verdict. */
  risk?: string;
  /** The thrown error, when `exit` is 'error'. */
  error?: string;
  /** Freeform lines rendered as `- Note: <line>` entries, e.g. ignored-feedback-author lines. */
  notes?: string[];
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
/** A pipe would end the markdown table cell early. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** Render one run as a self-contained markdown block: heading, header line, stage table, trailer. */
export function renderStepSummary(summary: StepSummary): string {
  let totalCost = 0;
  const rows = summary.outcomes.map(({ name, result }) => {
    const m = stageMetric(result, name);
    totalCost += m.costUsd;
    return `| ${cell(name)} | ${m.exitReason} | ${m.turns} | ${seconds(m.durationMs)} | ${m.costUsd.toFixed(4)} |`;
  });
  const table =
    rows.length === 0
      ? ['_no stage ran_']
      : ['| stage | exit | turns | time | $cost |', '| --- | --- | ---: | ---: | ---: |', ...rows, `| **total** | | | | **${totalCost.toFixed(4)}** |`];
  const trailer = [
    summary.prUrl !== undefined ? `- PR: ${summary.prUrl}` : undefined,
    summary.verdict !== undefined ? `- Verdict: ${summary.verdict}` : undefined,
    summary.risk !== undefined ? `- Risk: ${summary.risk}` : undefined,
    ...(summary.notes ?? []).map((note) => `- Note: ${redactForPublish(note)}`),
    // The job summary is public on a public repo, and a thrown agent error embeds raw CLI output.
    summary.error !== undefined ? `- Error: ${redactForPublish(summary.error)}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [
    `### Vanguard run \`${summary.taskId}\` — ${summary.exit}`,
    '',
    `flow \`${summary.flow}\` · provider \`${summary.provider}\`${summary.model !== undefined ? ` · model \`${summary.model}\`` : ''}`,
    '',
    ...table,
    ...(trailer.length > 0 ? ['', ...trailer] : []),
    '',
  ].join('\n');
}

/**
 * Append one run's block to the GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`), where it shows
 * in the job's Summary tab. Append, never truncate: several runs in one job stack. No path (anywhere
 * outside Actions) ⇒ a silent no-op. A write failure is reported, never fatal — the run itself is done.
 */
export async function appendStepSummary(path: string | undefined, summary: StepSummary): Promise<void> {
  if (path === undefined || path === '') return;
  try {
    await appendFile(path, `${renderStepSummary(summary)}\n`);
  } catch (error) {
    console.warn(`vanguard: could not append the job summary to ${path}: ${String(error)}`);
  }
}
