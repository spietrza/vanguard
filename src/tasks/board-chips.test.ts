import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginRun, readRunRecords, runsRoot } from '../core/run-store.js';
import { boardChipsFor, latestRunChips } from './board-chips.js';
import type { RunResult } from '../core/types.js';

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'vg-chips-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });
const result: RunResult = { taskId: 'gh-owner-repo-904', completed: true, exitReason: 'completed', turns: 1, worktreePath: '/missing', worktreePreserved: false, finalText: '' };
const timestamp = '2026-06-06T10:00:00.000Z';
const finding = { severity: 'high', kind: 'correctness', title: 'broken', evidence: 'line' };

it('T15: returns the full ordered fixture and never reads diff/transcript payloads', async () => {
  const writer = beginRun(repo, result.taskId, timestamp);
  await writer.writeStages([
    { name: 'implementer', result },
    { name: 'reviewer', result: { ...result, finalText: `<findings>${JSON.stringify({ findings: [finding, finding] })}</findings>` } },
  ]);
  await writer.writeProof({ command: 'test', exitCode: 1, passed: false, sha256: 'abc', outputTail: '' });
  await writer.writeVisualProof({ command: 'visual', exitCode: 0, passed: true, sha256: 'abc', outputTail: '', artifacts: [] });
  const chips = (await latestRunChips(repo)).get('gh-904');
  expect(chips).toEqual([
    { key: 'implementer', label: 'implementer: ok', tone: 'pass' },
    { key: 'reviewer', label: 'reviewer: changes (2)', tone: 'changes' },
    { key: 'proof', label: 'proof: fail', tone: 'failed' },
    { key: 'visual-proof', label: 'visual proof: pass', tone: 'pass' },
  ]);
  // Record-only mode excludes artifact payloads.
  const base = join(runsRoot(repo), result.taskId, '2026-06-06T10-00-00-000Z-reviewer');
  await writeFile(`${base}.diff`, "large diff");
  await writeFile(`${base}.transcript.log`, "large transcript");
  const detail = await readRunRecords(runsRoot(repo), result.taskId, timestamp);
  expect(detail.stages.every((s) => s.diff === undefined && s.transcript === undefined)).toBe(true);
});

it('T16: skips legacy reviewer verdicts and absent proofs; empty run trees have no chips', async () => {
  expect(await latestRunChips(repo)).toEqual(new Map());
  expect(boardChipsFor({ taskId: result.taskId, timestamp, stages: [{ record: { ...result, timestamp, stage: 'reviewer' } }] })).toEqual([]);
});

it('T17/T18: uses only the newest run and skips garbage records', async () => {
  await beginRun(repo, result.taskId, timestamp).writeStages([{ name: 'reviewer', result }]);
  await beginRun(repo, result.taskId, '2026-06-07T10:00:00.000Z').writeStages([{ name: 'implementer', result: { ...result, completed: false } }]);
  await writeFile(join(runsRoot(repo), result.taskId, 'garbage.json'), '{');
  expect((await latestRunChips(repo)).get('gh-904')).toEqual([{ key: 'implementer', label: 'implementer: incomplete', tone: 'failed' }]);
});
