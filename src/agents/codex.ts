import { AgentError } from '../core/errors.js';
import { redactForPublish } from '../core/secret-scan.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput, AgentUsage } from './provider.js';
import { shellQuote } from './shell.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

/**
 * Sandbox setup command run before `codex exec`, branching at runtime on the credential in the env.
 *
 * Subscription mode (`$CODEX_AUTH_JSON` set): write its content to `$CODEX_HOME/auth.json` (0600) and skip
 * login entirely. This is a ChatGPT subscription's OAuth credential (`auth_mode: chatgpt`, no API key);
 * `codex exec` reads it like the file `codex login` would have written and self-refreshes the token via the
 * embedded refresh_token. Lives in the sandbox like Claude's OAuth token, so `--llm-proxy` does not apply.
 *
 * Normal mode (no auth.json, no base URL): log in with the real key from `$OPENAI_API_KEY`, piped via
 * stdin so the secret never reaches argv. `codex exec` then reads the auth.json that `codex login` wrote.
 *
 * Proxy mode (the runner set `$VANGUARD_OPENAI_BASE_URL` to a trusted sidecar): never run `codex login`.
 * Instead write `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) declaring a custom
 * OpenAI-compatible provider pointed at the sidecar. With `wire_api = "responses"` and a base_url ending
 * in `/v1`, Codex POSTs to `/v1/responses` and sends `env_key`'s value (`$OPENAI_API_KEY`, which in proxy
 * mode holds only a nonce, not the real key) as `Authorization: Bearer`; the sidecar validates the nonce
 * and swaps in the real key. Fail clearly if the nonce is missing.
 *
 * The `\n` sequences are emitted as literal backslash-n into the sandbox shell so `printf` interprets
 * them; the base URL is expanded inside the sandbox via printf's `%s` arg, never interpolated host-side.
 */
const CODEX_SETUP =
  'if [ -n "${CODEX_AUTH_JSON:-}" ]; then mkdir -p "${CODEX_HOME:-$HOME/.codex}"; printf %s "$CODEX_AUTH_JSON" > "${CODEX_HOME:-$HOME/.codex}/auth.json"; chmod 600 "${CODEX_HOME:-$HOME/.codex}/auth.json"; elif [ -n "${VANGUARD_OPENAI_BASE_URL:-}" ]; then if [ -z "${OPENAI_API_KEY:-}" ]; then echo \'vanguard: codex proxy mode requires the OPENAI_API_KEY nonce\' >&2; exit 1; fi; mkdir -p "${CODEX_HOME:-$HOME/.codex}"; printf \'model_provider = "vanguardproxy"\\n[model_providers.vanguardproxy]\\nname = "vanguard-proxy"\\nbase_url = "%s"\\nwire_api = "responses"\\nenv_key = "OPENAI_API_KEY"\\n\' "$VANGUARD_OPENAI_BASE_URL" > "${CODEX_HOME:-$HOME/.codex}/config.toml"; else printf %s "$OPENAI_API_KEY" | codex login --with-api-key; fi';

function buildArgs(input: AgentRunInput): string[] {
  const args = ['exec', '--json', '--sandbox', 'danger-full-access'];
  if (input.model !== undefined) args.push('-m', input.model);
  return args;
}

function toUsage(raw: CodexEvent['usage']): AgentUsage | undefined {
  if (raw === undefined) return undefined;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadInputTokens: raw.cached_input_tokens ?? 0,
  };
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    const sh = input.sandbox.exec.bind(input.sandbox);
    const execOpts = {
      cwd: input.workdir,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    // Authenticate before exec: normal mode logs in with the real key (piped from $OPENAI_API_KEY so the
    // secret never reaches argv); proxy mode instead points codex at a trusted sidecar via config.toml.
    // See CODEX_SETUP. Best-effort: a missing/invalid key surfaces as an auth failure on the exec below,
    // caught by the graceful-exit guard.
    await sh(CODEX_SETUP, execOpts);

    // Feed the prompt on stdin (`-` as the PROMPT arg), never on argv: the command runs through
    // `sh -lc "<command>"`, so the whole prompt lands in ONE argv string, which Linux caps at
    // MAX_ARG_STRLEN (128 KiB). A PR-review prompt embeds the diff; past the cap `codex` never starts
    // (exit 1 within seconds, empty stdout AND stderr), which surfaces below as "no parseable output".
    const args = buildArgs(input);
    args.push('-');
    const command = `codex ${args.map(shellQuote).join(' ')}`;

    const res = await sh(command, { ...execOpts, input: input.prompt });

    let sessionId: string | undefined;
    let finalText = '';
    let turns = 0;
    let usage: AgentUsage | undefined;
    let sawTurnCompleted = false;
    let parsedAny = false;

    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(trimmed) as CodexEvent;
      } catch {
        continue;
      }
      parsedAny = true;

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        const text = event.item.text;
        if (text !== '') {
          turns += 1;
          finalText = text;
          yield sessionId !== undefined ? { text, sessionId } : { text };
        }
      } else if (event.type === 'turn.completed') {
        sawTurnCompleted = true;
        usage = toUsage(event.usage);
      }
    }

    // On a silent network/auth failure codex often leaves stderr empty and stdout holding only a startup
    // line, so surface BOTH streams (not just one) and the exit code. Redact credential material first:
    // in subscription mode auth.json (JWTs + Bearer tokens) lives in the sandbox, and this string is both
    // dumped to the run log AND posted as a public issue comment by the runner — a token must never ride along.
    const detail = (): string => {
      const err = redactForPublish(res.stderr.trim());
      const out = redactForPublish(res.stdout.trim()).slice(-1500);
      return [err !== '' ? `stderr: ${err}` : '', out !== '' ? `stdout: ${out}` : ''].filter(Boolean).join(' | ') || '(no output)';
    };
    if (!parsedAny || !sawTurnCompleted) {
      const reason = parsedAny ? 'exited without a result' : 'produced no parseable output';
      console.error(`codex ${reason} (exit ${res.exitCode})\n--- codex stdout ---\n${redactForPublish(res.stdout)}\n--- codex stderr ---\n${redactForPublish(res.stderr)}`);
      throw new AgentError(`Agent ${reason} (exit ${res.exitCode}): ${detail()}`);
    }

    const output: AgentRunOutput = { finalText, turns, transcript: res.stdout };
    if (sessionId !== undefined) output.sessionId = sessionId;
    if (usage !== undefined) output.usage = usage;
    return output;
  }
}
