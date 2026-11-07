import { listRuns, readRunRecords, runsRoot } from '../core/run-store.js';
import type { BoardChip, RunDetail } from '../wire.js';
import { taskRefKey } from './board.js';

/** Latest run verdicts in pipeline order; historical records never imply a review pass. */
export function boardChipsFor(detail: RunDetail): BoardChip[] {
  const chips: BoardChip[] = [];
  const implementer = detail.stages.find((s) => s.record.stage === 'implementer')?.record;
  if (implementer !== undefined) chips.push({
    key: 'implementer', label: `implementer: ${implementer.completed ? 'ok' : 'incomplete'}`,
    tone: implementer.completed ? 'pass' : 'failed',
  });
  for (const key of ['reviewer', 'conformance']) {
    const record = detail.stages.find((s) => s.record.stage === key)?.record;
    if (record?.verdict === undefined) continue;
    const count = record.findings?.length ?? 0;
    chips.push({ key, label: `${key}: ${record.verdict}${count > 0 ? ` (${count})` : ''}`, tone: record.verdict });
  }
  for (const [key, label, proof] of [
    ['proof', 'proof', detail.proof],
    ['visual-proof', 'visual proof', detail.visualProof],
  ] as const) {
    if (proof !== undefined) chips.push({ key, label: `${label}: ${proof.passed ? 'pass' : 'fail'}`, tone: proof.passed ? 'pass' : 'failed' });
  }
  return chips;
}

export async function latestRunChips(repoPath: string): Promise<Map<string, BoardChip[]>> {
  const root = runsRoot(repoPath);
  // listRuns is newest-first and fingerprint-cached: keep each task's first (newest) run only.
  const latest = new Map<string, { taskId: string; timestamp: string }>();
  for (const run of await listRuns(root)) {
    const key = taskRefKey(run.taskId);
    if (!latest.has(key)) latest.set(key, run);
  }
  const out = new Map<string, BoardChip[]>();
  await Promise.all([...latest].map(async ([key, run]) => {
    try {
      out.set(key, boardChipsFor(await readRunRecords(root, run.taskId, run.timestamp)));
    } catch {
      // Local state is best-effort; tracker tasks must still load.
      out.set(key, []);
    }
  }));
  return out;
}
