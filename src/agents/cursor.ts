import { AgentError } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote, assistantText } from './shell.js';

/**
 * One NDJSON line of `agent -p --output-format stream-json` (cursor.com/docs/cli/reference/output-format,
 * checked against CLI 2026.10.16): `system/init` (session_id, model display name such as "Auto Balance"),
 * `user`, `thinking` deltas (ignored), one `assistant` per text segment between tool calls, `tool_call`
 * started/completed, and a terminal `result` carrying token usage but no cost.
 */
interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  is_error?: boolean;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

/**
 * Claude CLI aliases and Anthropic ids that Vanguard's stage presets pin (spec → `haiku`, implement →
 * `sonnet`, plan → `opus`, escalation → `claude-fable-5-1`) map onto Cursor's Auto modes by tier, so a
 * stage keeps its intelligence/cost trade-off without naming models an account may not have. Cursor's own
 * ids pass through, including `claude-opus-5-5-high` (a suffix after the version, so no match here).
 */
const CLAUDE_MODEL = /^(?:claude-)?(haiku|sonnet|opus|fable)(?:-\d+)*$/;
const AUTO_MODE: Readonly<Record<string, string>> = {
  haiku: 'cost',
  sonnet: 'balanced',
  opus: 'intelligence',
  fable: 'intelligence',
};

/**
 * Short names for the Auto modes, so a workflow input or a `vanguard:model=` label (GitHub caps labels at
 * 50 characters) need not carry `auto-smart[optimize_for=…]`. A Map: the keys come from user input.
 */
const AUTO_SHORT = new Map([
  ['auto-intelligence', 'intelligence'],
  ['auto-balance', 'balanced'],
  ['auto-cost', 'cost'],
]);

/** The `--model` value for a requested model: a short name or Claude tier becomes its Auto mode, anything else is as given. */
function cursorModel(model: string): string {
  const tier = CLAUDE_MODEL.exec(model)?.[1];
  const mode = AUTO_SHORT.get(model) ?? (tier !== undefined ? AUTO_MODE[tier] : undefined);
  return mode === undefined ? model : `auto-smart[optimize_for=${mode}]`;
}

/**
 * Auto mode opens its first segment with the model it picked ("> Auto routed to Grok 4.7\n\n"), either
 * alone (before a tool call) or followed by the answer. It is a notice, not part of the turn's text.
 */
const AUTO_ROUTED = /^> Auto routed to ([^\n]+)\n*/;

/**
 * Sandbox setup run before `agent`: allow every shell command and file access in
 * `~/.cursor/cli-config.json`, keeping the rest of the file. This replaces `--force`, which a team
 * admin can disable ("Run Everything"); without either, print mode rejects every command but `ls`. The
 * Vanguard container is the boundary, as for codex's danger-full-access.
 */
const CURSOR_SETUP =
  `node -e 'const fs=require("fs"),p=require("path"),f=p.join(process.env.HOME,".cursor","cli-config.json");let c={version:1};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}c.permissions={allow:["Shell(*)","Read(**)","Write(**)"],deny:[]};fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(c,null,2))'`;

function toUsage(raw: StreamMessage['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return { inputTokens: raw.inputTokens ?? 0, outputTokens: raw.outputTokens ?? 0, cacheReadInputTokens: raw.cacheReadTokens ?? 0 };
}

function buildArgs(input: AgentRunInput): string[] {
  // --trust: headless runs cannot answer the workspace-trust prompt. --sandbox disabled: the Vanguard
  // container is the boundary; Cursor's own sandbox is not set up there.
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'disabled'];
  if (input.model !== undefined) args.push('--model', cursorModel(input.model));
  // A pipeline resume (repair gate, spec nudge) runs in the same sandbox, where the chat is still on disk.
  if (input.resumeSessionId !== undefined) args.push('--resume', input.resumeSessionId);
  return args;
}

export class CursorProvider implements AgentProvider {
  readonly name = 'cursor';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    // The prompt goes on stdin, never argv: `sh -lc` puts the whole command in one argv string, which
    // Linux caps at 128 KiB (see codex.ts). Cursor has no system-prompt flag, so it leads the prompt.
    const prompt = input.systemPrompt !== undefined ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    const execOpts = { cwd: input.workdir, ...(input.signal !== undefined ? { signal: input.signal } : {}) };
    // Best-effort like codex's login: a failed setup surfaces as rejected commands, not a crash here.
    await input.sandbox.exec(CURSOR_SETUP, execOpts);
    const command = `agent ${buildArgs(input).map(shellQuote).join(' ')}`;
    const res = await input.sandbox.exec(command, { ...execOpts, input: prompt });

    let sessionId: string | undefined;
    let finalText = '';
    let turns = 0;
    let model: string | undefined;
    let result: StreamMessage | undefined;
    let parsedAny = false;

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let msg: StreamMessage;
      try {
        msg = JSON.parse(trimmed) as StreamMessage;
      } catch {
        continue;
      }
      parsedAny = true;
      if (msg.session_id !== undefined) sessionId = msg.session_id;
      if (msg.type === 'system' && typeof msg.model === 'string') model ??= msg.model;
      if (msg.type === 'assistant') {
        const raw = assistantText(msg);
        const routed = AUTO_ROUTED.exec(raw);
        // The served model, not the mode ("Auto Balance"), is what run records and stats should show.
        if (routed?.[1] !== undefined) model = routed[1].trim();
        const text = routed !== null ? raw.slice(routed[0].length) : raw;
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (msg.type === 'result') {
        result = msg;
      }
    }

    // Masked like codex.ts: this text reaches the run log and the issue comment, and cursor's key is
    // injected straight into the sandbox, so raw stderr/stdout could carry it.
    const detail = (): string => {
      const err = redactForPublish(res.stderr.trim());
      const out = redactForPublish(res.stdout.trim()).slice(-1500);
      return [err !== '' ? `stderr: ${err}` : '', out !== '' ? `stdout: ${out}` : ''].filter(Boolean).join(' | ') || '(no output)';
    };
    if (!parsedAny) throw new AgentError(`Agent produced no parseable output (exit ${res.exitCode}): ${detail()}`);
    if (result === undefined) throw new AgentError(`Agent exited without a result (exit ${res.exitCode}): ${detail()}`);
    if (result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success')) {
      throw new AgentError(`Agent reported an error result (${result.subtype ?? 'is_error'}, exit ${res.exitCode}): ${detail()}`);
    }
    // `result.result` concatenates every segment with no separator, so the last segment is the real final
    // message (where the termination signal sits); fall back to it only when no segment was streamed.
    if (finalText === '' && typeof result.result === 'string') finalText = result.result;

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
    if (sessionId !== undefined) output.sessionId = sessionId;
    const usage = toUsage(result.usage);
    if (usage !== undefined) output.usage = usage;
    if (model !== undefined) output.model = model;
    return output;
  }
}
