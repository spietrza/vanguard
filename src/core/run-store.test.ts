import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, access, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { VERDICT_STAGES, beginRun, listRuns, readRun, runsRoot, persistDecisionProbe, persistRunRecord, persistStageOutcomes } from './run-store.js';
import { STAGE } from '../pipeline/pipeline.js';
import type { RunResult } from './types.js';

const TS = '2026-06-06T10:00:00.000Z';
const PREFIX = '2026-06-06T10-00-00-000Z';

/**
 * Run `fn` against a throwaway git repo standing in for a run's worktree. It has one commit so
 * `git bundle create ... HEAD` succeeds; `{ commit: false }` leaves it without a HEAD to bundle.
 */
async function withWorktree(fn: (wt: string) => Promise<void>, opts: { commit?: boolean } = {}): Promise<void> {
  const wt = await mkdtemp(join(tmpdir(), 'vg-wt-'));
  try {
    await execa('git', ['init', '-b', 'main'], { cwd: wt });
    if (opts.commit !== false) {
      await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: wt });
    }
    await fn(wt);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-runstore-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const result: RunResult = {
  taskId: 'TES-1',
  completed: true,
  exitReason: 'completed',
  turns: 3,
  worktreePath: '/wt',
  worktreePreserved: false,
  diff: 'HUGE DIFF '.repeat(1000),
  finalText: 'done',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 },
  costUsd: 0.05,
  cacheEfficiency: 0.8,
  model: 'actual-model',
};

const verResult = { command: 'pnpm test', exitCode: 0, passed: true, sha256: 'deadbeef'.repeat(8), outputTail: 'all good' };
const vpResult = {
  command: 'pnpm visual-proof',
  exitCode: 0,
  passed: true,
  sha256: 'cafebabe'.repeat(8),
  outputTail: 'screenshots captured',
  artifacts: [
    { path: '/workspace/.vanguard/visual-proof/home.png', sha256: 'aa'.repeat(32), bytes: 1024 },
    { path: '/workspace/.vanguard/visual-proof/about.png', sha256: 'bb'.repeat(32), bytes: 2048 },
  ],
};

/** Every file a run left in a task dir (records, payloads, proofs), sorted. */
async function recordFiles(taskId: string): Promise<string[]> {
  return (await readdir(join(runsRoot(repo), taskId))).sort();
}

describe('beginRun — writing', () => {
  it('writes a per-stage JSON (without the diff) and appends a metric line', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }], { prUrl: 'https://pr/1' });
    const file = join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`);

    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.taskId).toBe('TES-1');
    expect(record.stage).toBe('implementer');
    expect(record.costUsd).toBe(0.05);
    expect(record.model).toBe('actual-model');
    expect(record.prUrl).toBe('https://pr/1');
    expect(record.diff).toBeUndefined(); // diff excluded from JSON

    const diffFile = await readFile(file.replace(/\.json$/, '.diff'), 'utf8');
    expect(diffFile).toBe(result.diff);

    const metrics = await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8');
    const line = JSON.parse(metrics.trim());
    expect(line).toMatchObject({
      evt: 'run_complete',
      taskId: 'TES-1',
      exitReason: 'completed',
      costUsd: 0.05,
      inputTokens: 100,
      model: 'actual-model',
      prUrl: 'https://pr/1',
    });
  });

  it('writes a sibling transcript.log and keeps the transcript out of the JSON', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([
      { name: 'implementer', result: { ...result, transcript: '{"type":"result"}\n' } },
    ]);
    const file = join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.transcript).toBeUndefined();
    const log = await readFile(file.replace(/\.json$/, '.transcript.log'), 'utf8');
    expect(log).toBe('{"type":"result"}\n');
  });

  it('masks credential material in transcript.log before it reaches disk', async () => {
    const token = `ghp_${'A'.repeat(36)}`;
    await beginRun(repo, 'TES-1', TS).writeStages([
      {
        name: 'implementer',
        result: { ...result, transcript: `env: GH_TOKEN=${token}\nAuthorization: Bearer abc.def.ghi\n` },
      },
    ]);
    const log = await readFile(join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.transcript.log`), 'utf8');
    expect(log).not.toContain(token);
    expect(log).toContain('[REDACTED-GH]');
    expect(log).toContain('Bearer [REDACTED]');
  });

  describe('injected credentials the patterns cannot recognize', () => {
    // Opaque like a Codex refresh_token: no SECRET_PATTERNS entry matches it on its own.
    const refresh = 'rt_DUMMY8kQ2wZx7Pm4Nv1Lc9Hb3Jt6Ry0Ed5Sa';
    const custom = 'acme-opaque-key-5532719';
    const authJson = JSON.stringify({ tokens: { refresh_token: refresh } });
    // The shapes a tool result takes in a stream-json / codex --json transcript: JSON-escaped and bare.
    const transcript = [
      JSON.stringify({ type: 'tool_result', content: JSON.stringify({ tokens: { refresh_token: refresh } }, null, 2) }),
      JSON.stringify({ type: 'command_execution', command: 'jq -r .tokens.refresh_token', aggregated_output: `${refresh}\n` }),
      JSON.stringify({ type: 'command_execution', command: 'env', aggregated_output: `ACME_KEY=${custom}\n` }),
    ].join('\n');

    beforeEach(() => {
      vi.stubEnv('CODEX_AUTH_JSON', authJson);
      vi.stubEnv('ACME_KEY', custom);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('never survives in transcript.log, finalText, proof.json or visual-proof.json', async () => {
      const writer = beginRun(repo, 'TES-1', TS, { secretEnvVars: ['ACME_KEY'] });
      await writer.writeStages([
        { name: 'reviewer', result: { ...result, diff: '', finalText: `Done. refresh=${refresh} key ${custom}`, transcript } },
      ]);
      await writer.writeProof({ ...verResult, outputTail: `refresh: ${refresh}` });
      await writer.writeVisualProof({ ...vpResult, outputTail: `refresh: ${refresh}` });
      const taskDir = join(runsRoot(repo), 'TES-1');
      for (const name of await recordFiles('TES-1')) {
        const text = await readFile(join(taskDir, name), 'utf8');
        expect(text, name).not.toContain(refresh);
        expect(text, name).not.toContain(custom);
      }
      const log = await readFile(join(taskDir, `${PREFIX}-reviewer.transcript.log`), 'utf8');
      expect(log).toContain('[REDACTED-INJECTED]');
      // The rest of the transcript is kept: only the credential is cut out.
      expect(log).toContain('jq -r .tokens.refresh_token');
    });

    it('masks a failed visual proof too, re-hashing the did-not-run tail so the proof stays verifiable', async () => {
      const writer = beginRun(repo, 'TES-1', TS);
      const tail = `visual proof execution failed: ${refresh}`;
      const file = await writer.writeVisualProof({ ...vpResult, exitCode: -1, passed: false, outputTail: tail, artifacts: [] });
      const stored = JSON.parse(await readFile(file, 'utf8'));
      expect(stored.outputTail).toBe('visual proof execution failed: [REDACTED-INJECTED]');
      expect(stored.sha256).toBe(createHash('sha256').update(stored.outputTail).digest('hex'));
      const metric = JSON.parse((await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim());
      expect(metric.sha256).toBe(stored.sha256);

      const ranFile = await writer.writeVisualProof({ ...vpResult, exitCode: 1, passed: false, outputTail: tail });
      const ran = JSON.parse(await readFile(ranFile, 'utf8'));
      expect(ran.outputTail).not.toContain(refresh);
      expect(ran.sha256).toBe(vpResult.sha256); // over the full output, not the tail: unchanged
    });

    it('withholds a stage diff that carries an injected value no pattern recognizes', () =>
      withWorktree(async (wt) => {
        const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+const k = '${refresh}';\n`;
        await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result: { ...result, worktreePath: wt, diff } }]);
        const record = JSON.parse(await readFile(join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`), 'utf8'));
        expect(record.diffOmitted).toBe('secret-scan');
        expect(await recordFiles('TES-1')).toEqual([`${PREFIX}-implementer.json`]);
      }));

    it('a custom keyEnv is only known when the run names it (control)', async () => {
      await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'reviewer', result: { ...result, diff: '', finalText: `key ${custom}` } }]);
      const record = JSON.parse(await readFile(join(runsRoot(repo), 'TES-1', `${PREFIX}-reviewer.json`), 'utf8'));
      expect(record.finalText).toBe(`key ${custom}`);
    });
  });

  it('masks finalText in run.json; the .diff stays byte-faithful (the publish gate owns diff secrets)', async () => {
    const token = `glpat-${'B'.repeat(24)}`;
    // Ordinary code that redactTokens would mangle (`password: process.env…` → `[REDACTED]`) but the gate passes.
    const diff = `+  password: process.env.DB_PASSWORD,\n+  const pushToken = opts.pushToken.value;\n`;
    await beginRun(repo, 'TES-1', TS).writeStages([
      { name: 'implementer', result: { ...result, finalText: `Added the deploy key ${token} to config`, diff } },
    ]);
    const file = join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.finalText).not.toContain(token);
    expect(record.finalText).toContain('[REDACTED-GL]');
    expect(await readFile(file.replace(/\.json$/, '.diff'), 'utf8')).toBe(diff);
  });

  it('a stage diff the publish gate would block is withheld and marked, even without omitDiff', () =>
    withWorktree(async (wt) => {
      const token = `ghp_${'D'.repeat(36)}`;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await beginRun(repo, 'TES-1', TS).writeStages([
        {
          name: 'implementer',
          result: {
            ...result,
            worktreePath: wt,
            transcript: '{"type":"result"}\n',
            diff: `--- a/src/config.ts\n+++ b/src/config.ts\n+const token = '${token}';\n`,
          },
        },
      ]);
      consoleError.mockRestore();
      const file = join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`);
      const record = JSON.parse(await readFile(file, 'utf8'));
      expect(record.diffOmitted).toBe('secret-scan');
      expect(record.finalText).toBe('[withheld: secret-scan]');
      await expect(access(file.replace(/\.json$/, '.diff'))).rejects.toThrow();
      await expect(access(file.replace(/\.json$/, '.bundle'))).rejects.toThrow();
      await expect(access(file.replace(/\.json$/, '.transcript.log'))).rejects.toThrow();
    }),
  );

  it('omitDiff writes the JSON but no .diff, no .bundle and no transcript for any stage (secret-blocked runs)', () =>
    withWorktree(async (wt) => {
      const staged = { ...result, worktreePath: wt, transcript: '{"type":"result"}\n' };
      await beginRun(repo, 'TES-1', TS).writeStages(
        [{ name: 'implementer', result: staged }, { name: 'reviewer', result: staged }],
        { omitDiff: true },
      );
      const files = await recordFiles('TES-1');
      expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
      expect(files.some((f) => f.endsWith('.diff') || f.endsWith('.bundle') || f.endsWith('.transcript.log'))).toBe(false);
      const record = JSON.parse(await readFile(join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.json`), 'utf8'));
      expect(record.diffOmitted).toBe('secret-blocked');
      expect(record.finalText).toBe('[withheld: secret-blocked]');
    }),
  );

  it('writes a git bundle when worktreePath has a commit', () =>
    withWorktree(async (wt) => {
      await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result: { ...result, worktreePath: wt } }]);
      await expect(access(join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.bundle`))).resolves.toBeUndefined();
    }),
  );

  it('does not write a bundle and does not throw when worktreePath has no commits', () =>
    withWorktree(async (wt) => {
      await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result: { ...result, worktreePath: wt } }]);
      await expect(access(join(runsRoot(repo), 'TES-1', `${PREFIX}-implementer.bundle`))).rejects.toThrow();
    }, { commit: false }),
  );

  it('writeProof masks credential material in outputTail', async () => {
    const token = `ghp_${'C'.repeat(36)}`;
    const file = await beginRun(repo, 'TES-1', TS).writeProof({
      command: 'pnpm test',
      exitCode: 1,
      passed: false,
      sha256: 'abc',
      outputTail: `Error: bad token ${token}`,
    });
    const proof = JSON.parse(await readFile(file, 'utf8'));
    expect(proof.outputTail).not.toContain(token);
    expect(proof.outputTail).toContain('[REDACTED-GH]');
  });

  it('writeProof writes proof.json and metric line', async () => {
    const file = await beginRun(repo, 'TES-1', TS).writeProof(verResult);
    expect(file).toBe(join(runsRoot(repo), 'TES-1', `${PREFIX}.proof.json`));

    const proof = JSON.parse(await readFile(file, 'utf8'));
    expect(proof.command).toBe('pnpm test');
    expect(proof.passed).toBe(true);
    expect(proof.sha256).toBe(verResult.sha256);

    const metrics = await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8');
    expect(JSON.parse(metrics.trim())).toMatchObject({
      evt: 'verify',
      ts: TS,
      taskId: 'TES-1',
      passed: true,
      exitCode: 0,
      sha256: verResult.sha256,
    });
  });

  it('writeVisualProof writes visual-proof.json with artifacts and a metric line', async () => {
    const file = await beginRun(repo, 'TES-1', TS).writeVisualProof(vpResult);
    expect(file).toBe(join(runsRoot(repo), 'TES-1', `${PREFIX}.visual-proof.json`));

    const proof = JSON.parse(await readFile(file, 'utf8'));
    expect(proof.command).toBe('pnpm visual-proof');
    expect(proof.passed).toBe(true);
    expect(proof.sha256).toBe(vpResult.sha256);
    expect(proof.artifacts).toHaveLength(2);
    expect(proof.artifacts[0]).toEqual(vpResult.artifacts[0]);
    expect(proof.artifacts[1]).toEqual(vpResult.artifacts[1]);

    const metrics = await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8');
    expect(JSON.parse(metrics.trim())).toMatchObject({
      evt: 'visual_proof',
      ts: TS,
      taskId: 'TES-1',
      passed: true,
      exitCode: 0,
      sha256: vpResult.sha256,
      artifacts: 2,
    });
  });

  it('writeVisualProof records an artifacts count of 0 when there are no artifacts', async () => {
    await beginRun(repo, 'TES-2', TS).writeVisualProof({
      command: 'pnpm visual-proof',
      exitCode: 1,
      passed: false,
      sha256: 'deadbeef'.repeat(8),
      outputTail: 'no screenshots',
      artifacts: [],
    });
    const metrics = await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8');
    expect(JSON.parse(metrics.trim())).toMatchObject({ evt: 'visual_proof', taskId: 'TES-2', passed: false, exitCode: 1, artifacts: 0 });
  });

  it('labels every stage in the filename and appends one metric line per record', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }]);
    await beginRun(repo, 'TES-1', '2026-06-06T10:01:00.000Z').writeStages([{ name: 'reviewer', result }]);
    expect(await recordFiles('TES-1')).toEqual(
      expect.arrayContaining([`${PREFIX}-implementer.json`, '2026-06-06T10-01-00-000Z-reviewer.json']),
    );

    const metrics = (await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(metrics).toHaveLength(2);
    expect(JSON.parse(metrics[0]!).stage).toBe('implementer');
    expect(JSON.parse(metrics[1]!).stage).toBe('reviewer');
  });

  it('persistDecisionProbe appends one decision_probe line', async () => {
    await persistDecisionProbe(repo, 'task-1', { model: 'clef-flash', completesFirstTry: 0.7, difficulty: 1.5, difficultyConfidence: 0.6, specClear: 0.9, latencyMs: 120 }, { timestamp: TS });
    const metrics = (await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(metrics.at(-1)!)).toEqual({ evt: 'decision_probe', ts: TS, taskId: 'task-1', model: 'clef-flash', completesFirstTry: 0.7, difficulty: 1.5, difficultyConfidence: 0.6, specClear: 0.9, latencyMs: 120 });
  });

  it('writeStages records the configured model next to the served one', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([
      { name: 'implementer', result: { ...result, model: 'claude-sonnet-4-6' }, model: 'claude-fable-5' },
      { name: 'reviewer', result },
    ]);
    const metrics = (await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(metrics[0]!)).toMatchObject({ model: 'claude-sonnet-4-6', requestedModel: 'claude-fable-5' });
    expect(JSON.parse(metrics[1]!)).not.toHaveProperty('requestedModel');
  });

  it('one writer gives the stage records, proof.json and visual-proof.json one shared prefix', async () => {
    const writer = beginRun(repo, 'TES-1', TS);
    const proofFile = await writer.writeProof(verResult);
    const visualProofFile = await writer.writeVisualProof(vpResult);
    await writer.writeStages([{ name: 'implementer', result }, { name: 'reviewer', result }]);

    const taskDir = join(runsRoot(repo), 'TES-1');
    expect(proofFile).toBe(join(taskDir, `${PREFIX}.proof.json`));
    expect(visualProofFile).toBe(join(taskDir, `${PREFIX}.visual-proof.json`));
    expect((await recordFiles('TES-1')).filter((n) => n.endsWith('.json'))).toEqual(
      expect.arrayContaining([`${PREFIX}.proof.json`, `${PREFIX}.visual-proof.json`, `${PREFIX}-implementer.json`, `${PREFIX}-reviewer.json`]),
    );
  });

  it('writeStages mirrors the run as one OTLP trace when an exporter is configured', async () => {
    vi.stubEnv('VANGUARD_OTLP_ENDPOINT', 'https://lf.example/api/public/otel');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }, { name: 'reviewer', result }], { prUrl: 'https://pr/1', flow: 'default', provider: 'claude' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://lf.example/api/public/otel/v1/traces');
    const spans = (JSON.parse(init.body as string) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] }).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name)).toEqual(['TES-1', 'implementer', 'reviewer']);
    // The metric lines on disk are untouched by the mirror.
    const metrics = (await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(metrics).toHaveLength(2);
  });

  // The deprecated src/index.ts exports, kept for one release: they must land the same bytes in the
  // same place as the writer they forward to, or an external caller's history splits in two formats.
  it('persistStageOutcomes/persistRunRecord still write what the writer writes', async () => {
    await persistStageOutcomes(repo, [{ name: 'implementer', result }, { name: 'reviewer', result }], { timestamp: TS });
    await persistRunRecord(repo, result, { timestamp: TS, label: 'simplifier', requestedModel: 'claude-fable-5' });
    expect((await recordFiles('TES-1')).filter((n) => n.endsWith('.json'))).toEqual([
      `${PREFIX}-implementer.json`,
      `${PREFIX}-reviewer.json`,
      `${PREFIX}-simplifier.json`,
    ]);
    const metrics = (await readFile(join(runsRoot(repo), 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(metrics.map((l) => JSON.parse(l).stage)).toEqual(['implementer', 'reviewer', 'simplifier']);
    expect(JSON.parse(metrics[2]!)).toMatchObject({ requestedModel: 'claude-fable-5' });
  });
});

// The writer and the readers are one module precisely so this round trip holds: what beginRun puts on
// disk is what listRuns/readRun report, with no second implementation of the naming in between.
describe('beginRun → listRuns/readRun round trip', () => {
  it('reports the run once, with its stages, payloads and both proofs', async () => {
    const writer = beginRun(repo, 'TES-1', TS);
    await writer.writeStages(
      [
        { name: 'implementer', result: { ...result, transcript: 'implementer log\n' } },
        { name: 'reviewer', result: { ...result, transcript: 'reviewer log\n' } },
      ],
      { prUrl: 'https://pr/1' },
    );
    await writer.writeProof(verResult);
    await writer.writeVisualProof(vpResult);

    const root = runsRoot(repo);
    const summaries = await listRuns(root);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      taskId: 'TES-1',
      timestamp: TS,
      stages: ['implementer', 'reviewer'],
      anyFailed: false,
      prUrl: 'https://pr/1',
    });
    expect(summaries[0]!.totalCostUsd).toBeCloseTo(0.1);

    const detail = await readRun(root, 'TES-1', TS);
    expect(detail.stages.map((s) => s.record.stage)).toEqual(['implementer', 'reviewer']);
    for (const stage of detail.stages) {
      expect(stage.diff).toBe(result.diff);
      expect(stage.transcript).toBe(`${stage.record.stage} log\n`);
    }
    expect(detail.proof?.sha256).toBe(verResult.sha256);
    expect(detail.visualProof?.artifacts).toHaveLength(2);
  });

  it('readRun still finds a proof file stamped earlier than the stage records (pre-shared-timestamp runs)', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }]);
    // 90s before the stage records — inside the 10-minute fallback window, as a run persisted before
    // one timestamp was shared across the proof writers and the stage writer leaves on disk.
    const proofFile = await beginRun(repo, 'TES-1', '2026-06-06T09:58:30.000Z').writeProof(verResult);
    expect(proofFile).toBe(join(runsRoot(repo), 'TES-1', '2026-06-06T09-58-30-000Z.proof.json'));

    const detail = await readRun(runsRoot(repo), 'TES-1', TS);
    expect(detail.proof?.sha256).toBe(verResult.sha256);
  });

  it('listRuns re-parses after a new record: the fingerprint cache does not pin a stale list', async () => {
    const root = runsRoot(repo);
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }]);
    expect(await listRuns(root)).toHaveLength(1);
    // Cached: the same tree yields the very same array instance.
    expect(await listRuns(root)).toBe(await listRuns(root));

    await beginRun(repo, 'TES-1', '2026-06-06T11:00:00.000Z').writeStages([{ name: 'implementer', result }]);
    const after = await listRuns(root);
    expect(after.map((s) => s.timestamp)).toEqual(['2026-06-06T11:00:00.000Z', TS]);
  });

  it('readRun rejects a task id that escapes the runs root', async () => {
    await expect(readRun(runsRoot(repo), '../../etc', TS)).rejects.toThrow('invalid task id');
  });

  it('listRuns skips a record file that is not parseable JSON', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'implementer', result }]);
    await writeFile(join(runsRoot(repo), 'TES-1', `${PREFIX}-truncated.json`), '{"taskId":');
    const summaries = await listRuns(runsRoot(repo));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.stages).toEqual(['implementer']);
  });
});

describe('committed symlinks under .vanguard', () => {
  const proof = verResult;
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'vg-runstore-outside-'));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses to write records through a symlinked .vanguard/runs and leaves the target untouched', async () => {
    await mkdir(join(repo, '.vanguard'));
    await symlink(outside, join(repo, '.vanguard', 'runs'));
    await expect(beginRun(repo, 'gh-o-r-1', TS).writeProof(proof)).rejects.toThrow(/symlink/);
    await expect(beginRun(repo, 'gh-o-r-1', TS).writeStages([{ name: 'implementer', result }])).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses to append through a symlinked metrics.jsonl', async () => {
    const victim = join(outside, 'victim.rc');
    await writeFile(victim, 'export X=1\n');
    await mkdir(join(repo, '.vanguard', 'runs'), { recursive: true });
    await symlink(victim, join(repo, '.vanguard', 'runs', 'metrics.jsonl'));
    await expect(beginRun(repo, 'gh-o-r-2', TS).writeProof(proof)).rejects.toThrow(/symlink/);
    expect(await readFile(victim, 'utf8')).toBe('export X=1\n');
  });

  it('still writes on a real .vanguard/runs', async () => {
    const file = await beginRun(repo, 'gh-o-r-3', TS).writeProof(proof);
    expect(file.startsWith(join(repo, '.vanguard', 'runs', 'gh-o-r-3'))).toBe(true);
  });
});

describe('persisted review verdict (T5–T9)', () => {
  const finding = { severity: 'high', kind: 'security', title: 'credential', evidence: 'unsafe' };
  const text = '<findings>' + JSON.stringify({ findings: [finding] }) + '</findings>';
  it('persists and round-trips reviewer findings, leaving other/legacy stages unchanged', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([
      { name: 'reviewer', result: { ...result, finalText: text } },
      { name: 'implementer', result },
      { name: 'conformance', result: { ...result, finalText: text } },
    ]);
    const detail = await readRun(runsRoot(repo), 'TES-1', TS);
    expect(detail.stages.find((s) => s.record.stage === 'reviewer')?.record).toMatchObject({ verdict: 'changes', findings: [finding] });
    expect(detail.stages.find((s) => s.record.stage === 'conformance')?.record.verdict).toBe('changes');
    const legacy = detail.stages.find((s) => s.record.stage === 'implementer')!.record;
    expect(legacy).not.toHaveProperty('verdict');
    expect(legacy).not.toHaveProperty('findings');
  });
  it('withholds findings with the diff but retains the verdict', async () => {
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'reviewer', result: { ...result, finalText: text } }], { omitDiff: true });
    const record = (await readRun(runsRoot(repo), 'TES-1', TS)).stages[0]!.record;
    expect(record.verdict).toBe('changes');
    expect(record).not.toHaveProperty('findings');
    expect(record.finalText).toBe('[withheld: secret-blocked]');
  });
  it('redacts finding title/evidence after deriving the raw verdict', async () => {
    vi.stubEnv('ACME_KEY', 'critical-secret-credential-value');
    try {
      const finalText = '<findings>' + JSON.stringify({ findings: [{ severity: 'high', kind: 'security', title: 'critical-secret-credential-value', evidence: 'critical-secret-credential-value' }] }) + '</findings>';
      await beginRun(repo, 'TES-1', TS, { secretEnvVars: ['ACME_KEY'] }).writeStages([{ name: 'reviewer', result: { ...result, finalText } }]);
      const record = (await readRun(runsRoot(repo), 'TES-1', TS)).stages[0]!.record;
      expect(record.findings?.[0]?.title).not.toContain('critical-secret-credential-value');
      expect(record.findings?.[0]?.evidence).not.toContain('critical-secret-credential-value');
      expect(record.verdict).toBe('changes');
      // Prose fallback: the only severity keyword is inside the credential. Deriving from
      // redacted text would incorrectly pass, even though the incomplete raw reply blocks.
      await beginRun(repo, 'TES-1', TS, { secretEnvVars: ['ACME_KEY'] }).writeStages([
        { name: 'reviewer', result: { ...result, completed: false, finalText: 'critical-secret-credential-value' } },
      ]);
      const rawVerdict = (await readRun(runsRoot(repo), 'TES-1', TS)).stages[0]!.record;
      expect(rawVerdict.finalText).not.toContain('critical');
      expect(rawVerdict.verdict).toBe('changes');
    } finally { vi.unstubAllEnvs(); }
  });
  it('pins verdict stage names and omits empty findings', async () => {
    expect(VERDICT_STAGES).toEqual(new Set([STAGE.REVIEWER, STAGE.CONFORMANCE]));
    await beginRun(repo, 'TES-1', TS).writeStages([{ name: 'reviewer', result }]);
    const record = (await readRun(runsRoot(repo), 'TES-1', TS)).stages[0]!.record;
    expect(record.verdict).toBe('pass');
    expect(record).not.toHaveProperty('findings');
  });
});
