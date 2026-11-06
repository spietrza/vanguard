import { describe, it, expect } from 'vitest';
import { runClaudeCli } from './claude-stream.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentRunInput, AgentRunOutput } from './provider.js';

function fakeSandbox(stdout: string, exitCode: number = 0): IsolatedSandboxProvider {
  return {
    exec: async (): Promise<ExecResult> => ({ stdout, stderr: '', exitCode }),
  } as unknown as IsolatedSandboxProvider;
}

function capturingSandbox(
  stdout: string,
  exitCode: number = 0,
): { sandbox: IsolatedSandboxProvider; captured: { command: string; opts: Record<string, unknown> | undefined } } {
  const captured: { command: string; opts: Record<string, unknown> | undefined } = { command: '', opts: undefined };
  return {
    captured,
    sandbox: {
      exec: async (command: string, opts?: Record<string, unknown>): Promise<ExecResult> => {
        captured.command = command;
        captured.opts = opts;
        return { stdout, stderr: '', exitCode };
      },
    } as unknown as IsolatedSandboxProvider,
  };
}

const noArgs = (): string[] => [];

const streamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use' }, { type: 'text', text: '' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    result: 'done',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    total_cost_usd: 0.01,
  }),
].join('\n');

function input(sandbox: IsolatedSandboxProvider, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: 'do it', sandbox, workdir: '/workspace', home: '/root', ...overrides };
}

async function drain(
  sandbox: IsolatedSandboxProvider,
  overrides: Partial<AgentRunInput> = {},
): Promise<{ turns: Array<{ text: string; sessionId?: string }>; out: AgentRunOutput }> {
  const gen = runClaudeCli(input(sandbox, overrides), noArgs);
  const turns: Array<{ text: string; sessionId?: string }> = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { turns, out: n.value };
    turns.push(n.value);
  }
}

async function expectRunRejects(
  sandbox: IsolatedSandboxProvider,
  pattern: RegExp,
  overrides: Partial<AgentRunInput> = {},
): Promise<void> {
  const gen = runClaudeCli(input(sandbox, overrides), noArgs);
  await expect(
    (async () => {
      for await (const turn of gen) void turn;
    })(),
  ).rejects.toThrow(pattern);
}

describe('runClaudeCli', () => {
  it('yields assistant turns in order, filtering non-text and empty-text blocks', async () => {
    const { turns, out } = await drain(fakeSandbox(streamJson));
    expect(turns.map((t) => t.text)).toEqual(['working']);
    expect(out.turns).toBe(1);
  });

  it('collects usage, cost, and result overrides finalText', async () => {
    const { out } = await drain(fakeSandbox(streamJson));
    expect(out.finalText).toBe('done');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 80 });
    expect(out.costUsd).toBe(0.01);
  });

  // Observed on data-controls-engine#2489: the CLI ended on a thinking-only message and reported
  // result:"" after real text had streamed. Overwriting finalText there discards the run's output.
  it('keeps the streamed assistant text when the result event carries an empty string', async () => {
    const emptyResult = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<tech_spec>S</tech_spec>' }] } }),
      JSON.stringify({ type: 'result', result: '', total_cost_usd: 1.67 }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(emptyResult, 0));
    expect(out.finalText).toBe('<tech_spec>S</tech_spec>');
    expect(out.costUsd).toBe(1.67); // the rest of the result event is still honoured
  });

  it('does not throw on a non-zero exit when a result was produced (graceful stop e.g. max_turns)', async () => {
    const { out } = await drain(fakeSandbox(streamJson, 1));
    expect(out.finalText).toBe('done');
  });

  it('throws "without a result" on a non-zero exit with parsed output but no result event', async () => {
    const partial = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await expectRunRejects(fakeSandbox(partial, 1), /without a result/);
    await expectRunRejects(fakeSandbox(partial, 1), /exit 1/);
  });

  it('salvages a cut stream (exit 0 + assistant turns + session, no result) as an incomplete resumable run', async () => {
    const cut = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'writing tests' }] } }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(cut, 0));
    expect(out.finalText).toBe('writing tests'); // last streamed turn kept
    expect(out.sessionId).toBe('sess-1'); // session preserved → resume loop can continue
    expect(out.usage).toBeUndefined(); // no result event → no usage/cost
    expect(out.costUsd).toBeUndefined();
  });

  it('still throws on a cut stream with turns but no session id (nothing to resume)', async () => {
    const cut = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    await expectRunRejects(fakeSandbox(cut, 0), /without a result/);
  });

  it('still throws on a clean exit with a session but zero assistant turns (no work to salvage)', async () => {
    const initOnly = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await expectRunRejects(fakeSandbox(initOnly, 0), /without a result/);
  });

  it('throws "no parseable output" when every line is non-JSON', async () => {
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /no parseable output/);
    await expectRunRejects(fakeSandbox('fatal crash output', 1), /exit 1/);
  });

  it('throws "no parseable output" on empty stdout', async () => {
    await expectRunRejects(fakeSandbox('', 1), /no parseable output/);
  });

  it('throws with the CLI error text when every assistant turn is synthetic (gateway never answered)', async () => {
    // Shape of a real Meridian failure: init reports the requested model, the only assistant message is
    // one the CLI fabricated itself, and the result event carries zero tokens and zero cost.
    const syntheticOnly = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5-1' }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 upstream stream closed' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        result: '',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      }),
    ].join('\n');
    await expectRunRejects(fakeSandbox(syntheticOnly, 0), /Provider returned no completion/);
    await expectRunRejects(fakeSandbox(syntheticOnly, 0), /API Error: 500 upstream stream closed/);
  });

  it('does not fire the synthetic guard when a real assistant turn also streamed', async () => {
    const mixed = [
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: overloaded' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        message: { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'real output' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'real output' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(mixed));
    expect(out.finalText).toBe('real output');
  });

  it('skips interleaved non-JSON diagnostic lines without failing the parse', async () => {
    const withDiagnostics = `WARN: something noisy\n${streamJson}\nWARN: trailer`;
    const { out } = await drain(fakeSandbox(withDiagnostics));
    expect(out.sessionId).toBe('sess-1');
    expect(out.finalText).toBe('done');
  });

  it('captures session_id from the stream and seeds it from resumeSessionId when absent', async () => {
    const { out } = await drain(fakeSandbox(streamJson));
    expect(out.sessionId).toBe('sess-1');

    const noSessionStream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }),
    ].join('\n');
    const { turns, out: out2 } = await drain(fakeSandbox(noSessionStream), { resumeSessionId: 'resumed-1' });
    expect(out2.sessionId).toBe('resumed-1');
    expect(turns[0]?.sessionId).toBe('resumed-1');
  });

  it('captures model from a top-level field, or from nested message.model', async () => {
    const topLevelModelStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', model: 'claude-x', result: 'done' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(topLevelModelStream));
    expect(out.model).toBe('claude-x');

    const nestedModelStream = [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-y', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ].join('\n');
    const { out: out2 } = await drain(fakeSandbox(nestedModelStream));
    expect(out2.model).toBe('claude-y');
  });

  it('omits usage/cost/model/sessionId keys entirely when absent from the stream', async () => {
    const minimal = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
    const { out } = await drain(fakeSandbox(minimal));
    expect('usage' in out).toBe(false);
    expect('costUsd' in out).toBe(false);
    expect('model' in out).toBe(false);
    expect('sessionId' in out).toBe(false);
  });

  it('omits usage when the result event carries no usage field, even though result is present', async () => {
    const noUsage = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'done' });
    const { out } = await drain(fakeSandbox(noUsage));
    expect(out.finalText).toBe('done');
    expect('usage' in out).toBe(false);
  });

  it('feeds the prompt as exec input and runs a claude command', async () => {
    const { sandbox, captured } = capturingSandbox(streamJson);
    const { out } = await drain(sandbox);
    expect(out.finalText).toBe('done');
    expect(captured.command.startsWith('claude')).toBe(true);
    expect(captured.opts?.input).toBe('do it');
  });

  it('drops a forged session_id that is not a plain id token', async () => {
    const forged = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: '../../runs/metrics', result: 'done' }),
    ].join('\n');
    const { out } = await drain(fakeSandbox(forged));
    expect(out.sessionId).toBe('sess-1');

    const onlyForged = JSON.stringify({ type: 'result', subtype: 'success', session_id: '/etc/passwd', result: 'done' });
    expect((await drain(fakeSandbox(onlyForged))).out.sessionId).toBeUndefined();
  });
});
