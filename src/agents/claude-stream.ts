import { AgentError } from '../core/errors.js';
import type { AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote, assistantText } from './shell.js';
import { isSafeSessionId } from './session-store.js';

interface StreamContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: StreamContentBlock[]; model?: string };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

/** Model id the CLI stamps on messages it fabricates locally (API errors), never on real output. */
const SYNTHETIC_MODEL = '<synthetic>';

/** One assistant content block, rendered for the diagnostic log — never the full tool input, just enough to see what it was. */
function summarizeBlock(block: StreamContentBlock): string {
  if (block.type === 'text') return block.text ?? '';
  if (block.type === 'thinking') return `[thinking] ${(block.thinking ?? '').slice(0, 200)}`;
  if (block.type === 'tool_use') return `[tool_use:${block.name ?? '?'}] ${JSON.stringify(block.input ?? {}).slice(0, 200)}`;
  return `[${block.type ?? 'unknown'}]`;
}

/** The last assistant message's content, whatever shape it took — the only evidence left when no text reached finalText. */
function summarizeAssistantMessage(msg: StreamMessage): string {
  return (msg.message?.content ?? []).map(summarizeBlock).join(' ').trim();
}

function toUsage(raw: StreamMessage['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
  };
}

/**
 * Run the in-sandbox `claude` CLI (stream-json) with the given arg list and parse its NDJSON event
 * stream into assistant turns + a run summary. Shared by ClaudeCodeProvider (Anthropic) and ZaiProvider
 * (z.ai GLM, which reuses the same Claude Code CLI pointed at z.ai's Anthropic-compatible endpoint).
 *
 * The caller owns arg construction (effort, model, mcp, etc.); this function owns the prompt-feeding,
 * stream parsing, and the graceful-exit invariant (only a genuine crash with no `result` event is an
 * error — the CLI returns non-zero for graceful stops like max_turns/max_budget too).
 */
export async function* runClaudeCli(
  input: AgentRunInput,
  buildArgs: (input: AgentRunInput) => string[],
): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
  const command = `claude ${buildArgs(input).map(shellQuote).join(' ')}`;
  const res = await input.sandbox.exec(command, {
    cwd: input.workdir,
    input: input.prompt,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let sessionId: string | undefined = input.resumeSessionId;
  let finalText = '';
  let turns = 0;
  let usage: AgentUsage | undefined;
  let costUsd: number | undefined;
  let model: string | undefined;
  let sawResult = false;
  let parsedAny = false;
  let realTurns = 0;
  let droppedSessionId = false;
  let lastBlock: string | undefined;
  let stopReason: string | undefined;

  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let msg: StreamMessage;
    try {
      msg = JSON.parse(trimmed) as StreamMessage;
    } catch {
      continue; // skip non-JSON diagnostic lines
    }
    parsedAny = true;
    // The id names host files on capture/restore and the agent controls this stream: keep only a
    // plain id token, so a forged `session_id` cannot smuggle a path (it is treated as no session).
    if (msg.session_id !== undefined) {
      if (typeof msg.session_id === 'string' && isSafeSessionId(msg.session_id)) sessionId = msg.session_id;
      else droppedSessionId = true;
    }
    if (typeof msg.model === 'string') model = msg.model;
    else if (typeof msg.message?.model === 'string') model = msg.message.model;
    if (msg.type === 'assistant') {
      // Captured for every assistant message, not just ones with text: when the run ends without any
      // text block (all thinking/tool_use), this is the only evidence of what the tokens actually went to.
      const summary = summarizeAssistantMessage(msg);
      if (summary !== '') lastBlock = summary;
      const text = assistantText(msg);
      if (text !== '') {
        turns += 1;
        if (msg.message?.model !== SYNTHETIC_MODEL) realTurns += 1;
        finalText = text;
        yield sessionId !== undefined ? { text, sessionId } : { text };
      }
    } else if (msg.type === 'result') {
      sawResult = true;
      // Keep the accumulated assistant text when the terminal event carries an empty result: the CLI
      // can end a run on a thinking-only message and report result:"" even though real text already
      // streamed. Overwriting here would silently discard it (and any <tech_spec> it contained).
      if (typeof msg.result === 'string' && msg.result !== '') finalText = msg.result;
      usage = toUsage(msg.usage);
      if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
      // The CLI's own classification of why the turn ended (e.g. 'success', 'error_max_turns',
      // 'error_during_execution') — the terminal_reason/stop-reason callers need when finalText is empty.
      if (typeof msg.subtype === 'string') stopReason = msg.subtype;
    }
  }

  if (droppedSessionId) console.warn('vanguard: ignored a malformed session_id in the claude stream (no resume from it)');

  // Only a genuine crash (no result produced) is an error. The CLI returns a non-zero exit code
  // for graceful stops too (max_turns, max_budget), so do not treat exit code alone as failure.
  const detail = (): string => (res.stderr.trim() !== '' ? res.stderr.trim() : res.stdout.trim().slice(-600));
  if (!parsedAny) throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
  if (!sawResult) {
    // A missing terminal `result` event after real work already streamed (assistant turns + a session id)
    // and a clean exit is a truncated/cut stream — a long SSE severed by a corp MITM proxy, or the CLI
    // stopping without its summary — NOT a crash. Salvage the turns so the stage lands as `incomplete` and
    // the resume loop can continue the SAME session, instead of throwing away an expensive run. A non-zero
    // exit, zero turns, or no session id (nothing to resume) stays a genuine crash.
    if (res.exitCode !== 0 || turns === 0 || sessionId === undefined) {
      throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);
    }
    console.warn(
      `vanguard: claude stream ended without a result event (exit 0, ${turns} turns) — treating the stage as incomplete and resumable`,
    );
  }

  // Every assistant message came back stamped `<synthetic>`: the CLI never reached the model and
  // fabricated the text itself (an API/gateway error), which is why such runs report zero tokens and
  // zero cost. Resuming replays the same failing request, so fail loudly with the CLI's own message
  // instead of surfacing it as an `incomplete` stage and spending the resume budget on it.
  if (turns > 0 && realTurns === 0) {
    throw new AgentError(`Provider returned no completion (exit ${res.exitCode}): ${finalText.trim().slice(0, 600)}`);
  }

  const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
  if (sessionId !== undefined) output.sessionId = sessionId;
  if (usage !== undefined) output.usage = usage;
  if (costUsd !== undefined) output.costUsd = costUsd;
  if (stopReason !== undefined) output.stopReason = stopReason;
  // Only worth keeping when the run ended with nothing in finalText: otherwise finalText already is the evidence.
  if (finalText === '' && lastBlock !== undefined) output.lastBlock = lastBlock;
  if (model !== undefined) output.model = model;
  return output;
}
