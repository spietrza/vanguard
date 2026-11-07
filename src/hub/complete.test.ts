import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CompleteBusyError, CompleteRegistry } from './complete.js';
import { writeAppConfig } from './app-config.js';
import type { ChildProcess } from 'node:child_process';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'vanguard-hub-complete-'));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe('CompleteRegistry', () => {
  test('sends the allowlisted request fields and resolves on the first JSON line', async () => {
    const fake = new FakeChild();
    let written = '';
    fake.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const registry = new CompleteRegistry(() => fake as unknown as ChildProcess);
    const promise = registry.complete(repoPath, { messages: [{ role: 'user', content: 'hi' }], model: 'claude-sonnet-5' });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'hello' })}\n`);
    const result = await promise;
    expect(result).toEqual({ text: 'hello' });
    const sent = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(sent.model).toBe('claude-sonnet-5');
    expect(sent.assetRoot).toBe(join(repoPath, '.vanguard', 'drafts'));
    expect(sent.baseUrl).toBeUndefined();
  });

  test('substitutes the trusted chatBaseUrl and ignores a caller-supplied one', async () => {
    await writeAppConfig(repoPath, { chatBaseUrl: 'https://proxy.internal' });
    const fake = new FakeChild();
    let written = '';
    fake.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const registry = new CompleteRegistry(() => fake as unknown as ChildProcess);
    const promise = registry.complete(repoPath, {
      messages: [],
      model: 'm',
      // @ts-expect-error -- baseUrl is not part of CompleteParams; proving it cannot ride along even if forced
      baseUrl: 'https://attacker.example',
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const sent = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(sent.baseUrl).toBe('https://proxy.internal');
  });

  test('ignores non-JSON noise on stdout before the real response line', async () => {
    const fake = new FakeChild();
    const registry = new CompleteRegistry(() => fake as unknown as ChildProcess);
    const promise = registry.complete(repoPath, { messages: [], model: 'm' });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write('some stray log line\n');
    fake.stdout.write(`${JSON.stringify({ text: 'real' })}\n`);
    await expect(promise).resolves.toEqual({ text: 'real' });
  });

  test('rejects with a clear message when the child closes with no response', async () => {
    const fake = new FakeChild();
    const registry = new CompleteRegistry(() => fake as unknown as ChildProcess);
    const promise = registry.complete(repoPath, { messages: [], model: 'm' });
    await new Promise((r) => setTimeout(r, 20));
    fake.emit('close');
    await expect(promise).rejects.toThrow(/no response/);
  });

  test('times out and kills the child after the configured timeout', async () => {
    const fake = new FakeChild();
    const registry = new CompleteRegistry(() => fake as unknown as ChildProcess, 10);
    const promise = registry.complete(repoPath, { messages: [], model: 'm' });
    await expect(promise).rejects.toThrow(/timed out/);
    expect(fake.killed).toBe(true);
  });

  test('cancel() kills exactly the child registered under its callId, leaving others alone', async () => {
    const fakeA = new FakeChild();
    const fakeB = new FakeChild();
    const children = [fakeA, fakeB];
    const registry = new CompleteRegistry(() => children.shift() as unknown as ChildProcess);
    const promiseA = registry.complete(repoPath, { messages: [], model: 'm' }, 'call-a');
    const promiseB = registry.complete(repoPath, { messages: [], model: 'm' }, 'call-b');
    registry.cancel('call-a');
    expect(fakeA.killed).toBe(true);
    expect(fakeB.killed).toBe(false);

    await new Promise((r) => setTimeout(r, 20));
    fakeA.emit('close');
    fakeB.stdout.write(`${JSON.stringify({ text: 'b done' })}\n`);
    await expect(promiseA).rejects.toThrow();
    await expect(promiseB).resolves.toEqual({ text: 'b done' });
  });

  test('rejects a turn past the concurrency cap without spawning, and frees the slot when one ends', async () => {
    const fakes = [new FakeChild(), new FakeChild(), new FakeChild()];
    let spawned = 0;
    const registry = new CompleteRegistry(() => fakes[spawned++] as unknown as ChildProcess, 10_000, 2);
    const first = registry.complete(repoPath, { messages: [], model: 'm' });
    const second = registry.complete(repoPath, { messages: [], model: 'm' });
    await expect(registry.complete(repoPath, { messages: [], model: 'm' })).rejects.toBeInstanceOf(CompleteBusyError);
    expect(spawned).toBe(2);

    await new Promise((r) => setTimeout(r, 20));
    fakes[0]!.stdout.write(`${JSON.stringify({ text: 'one' })}\n`);
    await expect(first).resolves.toEqual({ text: 'one' });
    const third = registry.complete(repoPath, { messages: [], model: 'm' });
    expect(spawned).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    fakes[1]!.stdout.write(`${JSON.stringify({ text: 'two' })}\n`);
    fakes[2]!.stdout.write(`${JSON.stringify({ text: 'three' })}\n`);
    await expect(second).resolves.toEqual({ text: 'two' });
    await expect(third).resolves.toEqual({ text: 'three' });
  });

  test('cancel() on an unknown callId is a silent no-op', () => {
    const registry = new CompleteRegistry(() => new FakeChild() as unknown as ChildProcess);
    expect(() => registry.cancel('never-started')).not.toThrow();
  });
});
