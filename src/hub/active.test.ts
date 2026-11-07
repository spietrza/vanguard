import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, isSessionPath, listActive, readSession } from './active.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vanguard-hub-active-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

describe('readSession', () => {
  it('T-11 parses assistant text and tool_use blocks, skipping attachment/user lines', async () => {
    const f = join(tmp, 's.jsonl');
    await write(
      f,
      [
        '{"type":"attachment","x":1}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it"},{"type":"tool_use","name":"Edit","input":{}}]}}',
        '{"type":"user","message":{"content":[]},"toolUseResult":"ok"}',
      ].join('\n'),
    );
    const out = (await readSession(f)).entries;
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ role: 'assistant', text: 'Working on it' });
    expect(out[1]).toEqual({ role: 'tool', text: 'Edit' });
  });

  it('T-12 sums token totals and prices cost per-message off each message model', async () => {
    const f = join(tmp, 's.jsonl');
    await write(
      f,
      [
        // opus: 1M in @ $5 + 1M out @ $25 + 1M cacheRead @ $0.5 = $30.5
        '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":1000000},"content":[{"type":"text","text":"a"}]}}',
        // unknown model contributes tokens but no cost (lower-bound estimate)
        '{"type":"assistant","message":{"model":"mystery-9","usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"b"}]}}',
      ].join('\n'),
    );
    const r = await readSession(f);
    expect(r.inputTokens).toBe(2_000_000);
    expect(r.outputTokens).toBe(1_000_000);
    expect(r.cacheReadTokens).toBe(1_000_000);
    expect(Math.abs(r.estCostUsd - 30.5)).toBeLessThan(1e-9);
  });
});

describe('isSessionPath', () => {
  it('T-13 accepts a real .vanguard/sessions path and rejects traversal / wrong dirs', () => {
    expect(isSessionPath('/repo/.vanguard/sessions/t/a.jsonl')).toBe(true);
    expect(isSessionPath('/etc/passwd')).toBe(false);
    expect(isSessionPath('/repo/.vanguard/sessions/../../secret.jsonl')).toBe(false);
    // "sessions" in the path but NOT under a real `.vanguard/sessions` dir.
    expect(isSessionPath('/tmp/sessions/evil.jsonl')).toBe(false);
    expect(isSessionPath('/repo/.vanguard/runs/t/a.jsonl')).toBe(false);
  });
});

describe('listActive', () => {
  it('fresh session is active; no sessions dir is empty', async () => {
    expect(await listActive(tmp)).toEqual([]);

    const sess = join(tmp, '.vanguard', 'sessions', 'task-x');
    await mkdir(sess, { recursive: true });
    await write(join(sess, 'a.jsonl'), '{}'); // just written -> mtime now
    const active = await listActive(tmp);
    expect(active.length).toBe(1);
    expect(active[0]?.taskId).toBe('task-x');
  });

  it('T-14 excludes a task whose run record also just finished (fresh mtime)', async () => {
    const sess = join(tmp, '.vanguard', 'sessions', 'task-y');
    await mkdir(sess, { recursive: true });
    await write(join(sess, 'a.jsonl'), '{}');

    // No runs/<task> dir at all -> normally active.
    let active = await listActive(tmp);
    expect(active.length).toBe(1);
    expect(active[0]?.taskId).toBe('task-y');

    // A fresh run record for the same task means the run just finished -> excluded.
    const runsDir = join(tmp, '.vanguard', 'runs', 'task-y');
    await mkdir(runsDir, { recursive: true });
    await write(join(runsDir, '2026-01-01T00-00-00-000Z.json'), '{}');
    active = await listActive(tmp);
    expect(active).toEqual([]);
  });

  it('T-15 treats a future mtime (clock skew) as active, not too old', async () => {
    const sess = join(tmp, '.vanguard', 'sessions', 'task-z');
    await mkdir(sess, { recursive: true });
    const file = join(sess, 'a.jsonl');
    await write(file, '{}');
    const future = new Date(Date.now() + ACTIVE_WINDOW_MS * 10);
    await utimes(file, future, future);

    const active = await listActive(tmp);
    expect(active.length).toBe(1);
    expect(active[0]?.taskId).toBe('task-z');
  });
});

describe('listActive — non-regular session files', () => {
  it('never offers a symlinked .jsonl as a session to tail', async () => {
    const outside = join(tmp, 'outside.jsonl');
    await write(outside, '{}');
    const sess = join(tmp, '.vanguard', 'sessions', 'task-link');
    await mkdir(sess, { recursive: true });
    await symlink(outside, join(sess, 'a.jsonl'));
    expect(await listActive(tmp)).toEqual([]);
  });
});
