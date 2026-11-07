import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRetrospectiveMemory,
  renderRetrospectiveMarkdown,
  refreshRetrospectiveMemory,
  writeRetrospectiveMarkdown,
  loadRetrospectiveMemory,
  redact,
} from './retrospective-memory.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-retro-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeMetricsLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

async function writeMetrics(repoPath: string, lines: string[]): Promise<void> {
  const runsDir = join(repoPath, '.vanguard', 'runs');
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'metrics.jsonl'), lines.join('\n') + '\n');
}

async function writeProof(
  repoPath: string,
  taskId: string,
  ts: string,
  proof: Record<string, unknown>,
): Promise<void> {
  const taskDir = join(repoPath, '.vanguard', 'runs', taskId);
  await mkdir(taskDir, { recursive: true });
  const sanitized = ts.replace(/[^0-9A-Za-z]/g, '-');
  await writeFile(join(taskDir, `${sanitized}.proof.json`), JSON.stringify(proof, null, 2) + '\n');
}

async function writeReviewerJson(
  repoPath: string,
  taskId: string,
  ts: string,
  record: Record<string, unknown>,
): Promise<void> {
  const taskDir = join(repoPath, '.vanguard', 'runs', taskId);
  await mkdir(taskDir, { recursive: true });
  const sanitized = ts.replace(/[^0-9A-Za-z]/g, '-');
  await writeFile(join(taskDir, `${sanitized}-reviewer.json`), JSON.stringify(record, null, 2) + '\n');
}

// ─── Test 1: No artifacts ────────────────────────────────────────────────────

describe('buildRetrospectiveMemory – no artifacts', () => {
  it('returns empty entries when .vanguard does not exist', async () => {
    const report = await buildRetrospectiveMemory(repo);
    expect(report.entries).toEqual([]);
  });

  it('renderRetrospectiveMarkdown produces a stable constant markdown for empty report', () => {
    const report = { entries: [] };
    const md1 = renderRetrospectiveMarkdown(report);
    const md2 = renderRetrospectiveMarkdown(report);
    expect(md1).toBe(md2);
    expect(md1).toContain('No failures or review notes recorded yet.');
    // Should NOT contain any dynamic date
    expect(md1).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ─── Test 2: Failed run_complete ─────────────────────────────────────────────

describe('buildRetrospectiveMemory – failed run_complete', () => {
  it('surfaces failed runs (exitReason !== completed) and ignores successful ones', async () => {
    const ts1 = '2026-06-10T10:00:00.000Z';
    const ts2 = '2026-06-10T11:00:00.000Z';
    const ts3 = '2026-06-10T12:00:00.000Z';

    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'run_complete', ts: ts1, taskId: 'TES-1', stage: 'implementer', exitReason: 'error', completed: false, turns: 5, costUsd: 0.1 }),
      makeMetricsLine({ evt: 'run_complete', ts: ts2, taskId: 'TES-2', stage: 'implementer', exitReason: 'completed', completed: true, turns: 3, costUsd: 0.05 }),
      makeMetricsLine({ evt: 'run_complete', ts: ts3, taskId: 'TES-3', stage: 'reviewer', exitReason: 'maxTurns', completed: false, turns: 20, costUsd: 0.2 }),
    ]);

    const report = await buildRetrospectiveMemory(repo);
    const kinds = report.entries.filter((e) => e.kind === 'failed_run');
    expect(kinds).toHaveLength(2);

    const taskIds = kinds.map((e) => e.taskId);
    expect(taskIds).toContain('TES-1');
    expect(taskIds).toContain('TES-3');
    expect(taskIds).not.toContain('TES-2');

    // exitReason should appear in detail
    const tes1 = kinds.find((e) => e.taskId === 'TES-1');
    expect(tes1?.detail).toContain('error');

    const tes3 = kinds.find((e) => e.taskId === 'TES-3');
    expect(tes3?.detail).toContain('maxTurns');
  });

  it('surfaces a repaired stage (firstExitReason !== completed, final completed) as a failed run', async () => {
    const ts = '2026-06-10T13:00:00.000Z';
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'run_complete', ts, taskId: 'TES-4', stage: 'implementer', exitReason: 'completed', completed: true, turns: 45, costUsd: 0.4, attempts: 2, firstExitReason: 'maxTurns' }),
    ]);
    const report = await buildRetrospectiveMemory(repo);
    const entry = report.entries.find((e) => e.kind === 'failed_run' && e.taskId === 'TES-4');
    expect(entry?.detail).toBe('exitReason: maxTurns [implementer] (completed after 2 attempts)');
  });

  it('does NOT include a completed run_complete in failed_run entries', async () => {
    const ts = '2026-06-10T10:00:00.000Z';
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'run_complete', ts, taskId: 'TES-OK', stage: 'implementer', exitReason: 'completed', completed: true, turns: 3 }),
    ]);
    const report = await buildRetrospectiveMemory(repo);
    const failedRuns = report.entries.filter((e) => e.kind === 'failed_run');
    expect(failedRuns).toHaveLength(0);
  });
});

// ─── Test 3: Failed proof with secret redaction ──────────────────────────────

describe('buildRetrospectiveMemory – failed proof', () => {
  it('surfaces failed verify events with redacted+truncated outputTail', async () => {
    const ts = '2026-06-10T14:00:00.000Z';
    const fakeSecret = 'ABCDEF0123456789ABCDEF0123456789'; // 32 hex chars → should be redacted
    const outputTail = `Error: token=${fakeSecret} is invalid\nTest failed`;

    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'verify', ts, taskId: 'TES-4', passed: false, exitCode: 1, sha256: 'abc123' }),
    ]);
    await writeProof(repo, 'TES-4', ts, {
      command: 'pnpm test',
      exitCode: 1,
      passed: false,
      sha256: 'abc123',
      outputTail,
    });

    const report = await buildRetrospectiveMemory(repo);
    const proofEntries = report.entries.filter((e) => e.kind === 'failed_proof');
    expect(proofEntries).toHaveLength(1);

    const entry = proofEntries[0]!;
    expect(entry.taskId).toBe('TES-4');
    expect(entry.detail).toContain('pnpm test');
    expect(entry.detail).toContain('exitCode: 1');
    // Secret must be redacted
    expect(entry.detail).not.toContain(fakeSecret);
    expect(entry.detail).toContain('***');
  });

  it('surfaces failed proof even when proof.json is missing', async () => {
    const ts = '2026-06-10T14:00:00.000Z';
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'verify', ts, taskId: 'TES-5', passed: false, exitCode: 2, sha256: 'xyz' }),
    ]);
    // No proof file written

    const report = await buildRetrospectiveMemory(repo);
    const proofEntries = report.entries.filter((e) => e.kind === 'failed_proof');
    expect(proofEntries).toHaveLength(1);
    expect(proofEntries[0]?.taskId).toBe('TES-5');
  });

  it('does NOT include a passed verify event', async () => {
    const ts = '2026-06-10T14:00:00.000Z';
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'verify', ts, taskId: 'TES-6', passed: true, exitCode: 0, sha256: 'ok' }),
    ]);

    const report = await buildRetrospectiveMemory(repo);
    expect(report.entries.filter((e) => e.kind === 'failed_proof')).toHaveLength(0);
  });

  it('redacts a secret embedded in the proof command field', async () => {
    const ts = '2026-06-10T14:00:00.000Z';
    const fakeSecret = 'ABCDEF0123456789ABCDEF0123456789'; // 32 chars
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'verify', ts, taskId: 'TES-CMD', passed: false, exitCode: 1, sha256: 'abc' }),
    ]);
    await writeProof(repo, 'TES-CMD', ts, {
      command: `curl -H "Authorization: Bearer ${fakeSecret}" https://api`,
      exitCode: 1,
      passed: false,
      sha256: 'abc',
      outputTail: 'failed',
    });

    const report = await buildRetrospectiveMemory(repo);
    const entry = report.entries.find((e) => e.kind === 'failed_proof' && e.taskId === 'TES-CMD');
    expect(entry).toBeDefined();
    expect(entry?.detail).not.toContain(fakeSecret);
    expect(entry?.detail).toContain('***');
  });
});

// ─── Test 4: Reviewer notes + sibling file isolation ─────────────────────────

describe('buildRetrospectiveMemory – reviewer notes', () => {
  it('includes substantive reviewer notes', async () => {
    const ts = '2026-06-10T15:00:00.000Z';
    await mkdir(join(repo, '.vanguard', 'runs', 'TES-7'), { recursive: true });
    await writeReviewerJson(repo, 'TES-7', ts, {
      taskId: 'TES-7',
      stage: 'reviewer',
      finalText: 'The implementation has a bug: missing null check in line 42.',
      timestamp: ts,
    });

    const report = await buildRetrospectiveMemory(repo);
    const reviewerEntries = report.entries.filter((e) => e.kind === 'reviewer_note');
    expect(reviewerEntries).toHaveLength(1);
    const entry = reviewerEntries[0]!;
    expect(entry.taskId).toBe('TES-7');
    expect(entry.detail).toContain('missing null check');
  });

  it('redacts a token embedded in a reviewer note', async () => {
    const ts = '2026-06-10T15:00:00.000Z';
    const fakeSecret = 'ABCDEF0123456789ABCDEF0123456789'; // 32 chars
    await mkdir(join(repo, '.vanguard', 'runs', 'TES-RT'), { recursive: true });
    await writeReviewerJson(repo, 'TES-RT', ts, {
      taskId: 'TES-RT',
      stage: 'reviewer',
      finalText: `Found a leaked token=${fakeSecret} in the config — fix it.`,
      timestamp: ts,
    });

    const report = await buildRetrospectiveMemory(repo);
    const entry = report.entries.find((e) => e.kind === 'reviewer_note' && e.taskId === 'TES-RT');
    expect(entry).toBeDefined();
    expect(entry?.detail).not.toContain(fakeSecret);
    expect(entry?.detail).toContain('***');
  });

  it('skips reviewer notes whose finalText is just <promise>COMPLETE</promise>', async () => {
    const ts = '2026-06-10T15:00:00.000Z';
    await mkdir(join(repo, '.vanguard', 'runs', 'TES-8'), { recursive: true });
    await writeReviewerJson(repo, 'TES-8', ts, {
      taskId: 'TES-8',
      stage: 'reviewer',
      finalText: '<promise>COMPLETE</promise>',
      timestamp: ts,
    });

    const report = await buildRetrospectiveMemory(repo);
    const reviewerEntries = report.entries.filter((e) => e.kind === 'reviewer_note');
    expect(reviewerEntries).toHaveLength(0);
  });

  it('skips reviewer notes whose finalText (after stripping promise tags) equals COMPLETE case-insensitively', async () => {
    const ts = '2026-06-10T15:00:00.000Z';
    await mkdir(join(repo, '.vanguard', 'runs', 'TES-9'), { recursive: true });
    await writeReviewerJson(repo, 'TES-9', ts, {
      taskId: 'TES-9',
      stage: 'reviewer',
      finalText: '  <promise>complete</promise>  ',
      timestamp: ts,
    });

    const report = await buildRetrospectiveMemory(repo);
    expect(report.entries.filter((e) => e.kind === 'reviewer_note')).toHaveLength(0);
  });

  it('ignores .diff and .transcript.log siblings — their content must not appear in the report', async () => {
    const ts = '2026-06-10T16:00:00.000Z';
    const sanitized = ts.replace(/[^0-9A-Za-z]/g, '-');
    const taskDir = join(repo, '.vanguard', 'runs', 'TES-10');
    await mkdir(taskDir, { recursive: true });

    // Write sibling .diff and .transcript.log with unique content
    await writeFile(join(taskDir, `${sanitized}.diff`), 'SECRET_DIFF_CONTENT_UNIQUE_XYZ');
    await writeFile(join(taskDir, `${sanitized}.transcript.log`), 'SECRET_TRANSCRIPT_CONTENT_UNIQUE_ABC');

    // Write a reviewer note too so we confirm we DO read reviewer.json but not sibling files
    await writeReviewerJson(repo, 'TES-10', ts, {
      taskId: 'TES-10',
      stage: 'reviewer',
      finalText: 'Code looks good except for missing error handling.',
      timestamp: ts,
    });

    const report = await buildRetrospectiveMemory(repo);
    const rendered = renderRetrospectiveMarkdown(report);

    expect(rendered).not.toContain('SECRET_DIFF_CONTENT_UNIQUE_XYZ');
    expect(rendered).not.toContain('SECRET_TRANSCRIPT_CONTENT_UNIQUE_ABC');
    // Reviewer note should appear
    expect(rendered).toContain('missing error handling');
  });
});

// ─── Test 5: loadRetrospectiveMemory + maxBytes ───────────────────────────────

describe('loadRetrospectiveMemory', () => {
  it('returns stable no-memory message when file is absent', async () => {
    const result = await loadRetrospectiveMemory(repo);
    expect(result).toBe('No retrospective memory yet.');
  });

  it('respects maxBytes cap', async () => {
    // Generate enough entries to produce a large file
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = `2026-06-10T${String(i).padStart(2, '0')}:00:00.000Z`;
      lines.push(
        makeMetricsLine({
          evt: 'run_complete',
          ts,
          taskId: `TES-BULK-${i}`,
          stage: 'implementer',
          exitReason: 'error',
          completed: false,
          turns: 5,
          costUsd: 0.1,
        }),
      );
    }
    await writeMetrics(repo, lines);

    await refreshRetrospectiveMemory(repo);

    const fullContent = await readFile(join(repo, '.vanguard', 'memory', 'retrospective.md'), 'utf8');
    expect(fullContent.length).toBeGreaterThan(200);

    const maxBytes = 100;
    const capped = await loadRetrospectiveMemory(repo, { maxBytes });
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(maxBytes);
  });

  it('caps multibyte content without producing U+FFFD mojibake', async () => {
    // Reviewer note full of multibyte chars; cap mid-stream.
    const ts = '2026-06-10T10:00:00.000Z';
    await mkdir(join(repo, '.vanguard', 'runs', 'TES-MB'), { recursive: true });
    await writeReviewerJson(repo, 'TES-MB', ts, {
      taskId: 'TES-MB',
      stage: 'reviewer',
      finalText: 'Łódź źdźbło ćma ' + 'ą'.repeat(100),
      timestamp: ts,
    });
    await refreshRetrospectiveMemory(repo);

    const capped = await loadRetrospectiveMemory(repo, { maxBytes: 50 });
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(50);
    // No replacement character introduced by splitting a multibyte sequence.
    expect(capped).not.toContain('�');
  });

  it('refreshRetrospectiveMemory writes the file and returns the path', async () => {
    await writeMetrics(repo, [
      makeMetricsLine({ evt: 'run_complete', ts: '2026-06-10T10:00:00.000Z', taskId: 'TES-R', exitReason: 'timeout', completed: false, turns: 5, costUsd: 0.01 }),
    ]);

    const path = await refreshRetrospectiveMemory(repo);
    expect(path).toBe(join(repo, '.vanguard', 'memory', 'retrospective.md'));

    const content = await readFile(path, 'utf8');
    expect(content).toContain('TES-R');
    expect(content).toContain('timeout');
  });

  it('writeRetrospectiveMarkdown refuses a committed retrospective.md symlink and keeps the target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vg-retro-outside-'));
    try {
      const victim = join(outside, 'notes.txt');
      await writeFile(victim, 'operator notes\n');
      await mkdir(join(repo, '.vanguard', 'memory'), { recursive: true });
      await symlink(victim, join(repo, '.vanguard', 'memory', 'retrospective.md'));
      await expect(writeRetrospectiveMarkdown(repo, '# dummy\n')).rejects.toThrow(/symlink/);
      expect(await readFile(victim, 'utf8')).toBe('operator notes\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeRetrospectiveMarkdown writes the given markdown and returns the path', async () => {
    const path = await writeRetrospectiveMarkdown(repo, '# hello\n');
    expect(path).toBe(join(repo, '.vanguard', 'memory', 'retrospective.md'));
    expect(await readFile(path, 'utf8')).toBe('# hello\n');
  });
});

// ─── Test 6: Ordering and limit ───────────────────────────────────────────────

describe('buildRetrospectiveMemory – ordering and limit', () => {
  it('returns entries newest-first and respects limit', async () => {
    const lines: string[] = [];
    // 5 failed runs with increasing timestamps
    for (let i = 1; i <= 5; i++) {
      const ts = `2026-06-10T${String(i).padStart(2, '0')}:00:00.000Z`;
      lines.push(
        makeMetricsLine({
          evt: 'run_complete',
          ts,
          taskId: `TES-ORD-${i}`,
          exitReason: 'error',
          completed: false,
          turns: 2,
          costUsd: 0.01,
        }),
      );
    }
    await writeMetrics(repo, lines);

    const report = await buildRetrospectiveMemory(repo, { limit: 3 });
    expect(report.entries).toHaveLength(3);
    // newest first: TES-ORD-5 should be first
    expect(report.entries[0]?.taskId).toBe('TES-ORD-5');
    expect(report.entries[1]?.taskId).toBe('TES-ORD-4');
    expect(report.entries[2]?.taskId).toBe('TES-ORD-3');
  });

  it('skips blank and malformed lines in metrics.jsonl', async () => {
    await writeMetrics(repo, [
      '',
      'not json at all',
      makeMetricsLine({ evt: 'other_event', taskId: 'TES-X' }),
      makeMetricsLine({ evt: 'run_complete', ts: '2026-06-10T10:00:00.000Z', taskId: 'TES-VALID', exitReason: 'error', completed: false, turns: 1 }),
    ]);

    const report = await buildRetrospectiveMemory(repo);
    const failedRuns = report.entries.filter((e) => e.kind === 'failed_run');
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.taskId).toBe('TES-VALID');
  });
});

describe('redact', () => {
  it('masks a short (8-31 char) token in a key=value assignment that the 32-char pass would miss', () => {
    const shortSecret = 'abc123DEF456ghi'; // 15 chars: only caught by the key=value / Bearer passes
    const out = redact(`api_key=${shortSecret} done`);
    expect(out).not.toContain(shortSecret);
    expect(out).toContain('***');
  });

  it('masks a short Bearer token', () => {
    const shortSecret = 'tok_ABCdef12345'; // 15 chars
    const out = redact(`Authorization: Bearer ${shortSecret}`);
    expect(out).not.toContain(shortSecret);
    expect(out).toContain('***');
  });

  it('masks a long (32+ char) opaque token with no key prefix', () => {
    const longSecret = 'ABCDEF0123456789ABCDEF0123456789AB'; // 34 chars
    const out = redact(`leaked ${longSecret} here`);
    expect(out).not.toContain(longSecret);
    expect(out).toContain('***');
  });

  it('leaves ordinary prose untouched', () => {
    const text = 'Test failed: expected 200 but got 404';
    expect(redact(text)).toBe(text);
  });
});
