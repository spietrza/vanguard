import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { ReasoningEffort } from '../core/types.js';

export interface AgentRunInput {
  prompt: string;
  sandbox: IsolatedSandboxProvider;
  workdir: string;
  home: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  forkSession?: boolean;
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  model?: string;
  signal?: AbortSignal;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/** Fraction of input tokens served from cache (0..1); a proxy for prompt-cache effectiveness. */
export function cacheEfficiency(usage: AgentUsage): number {
  const total = usage.inputTokens + usage.cacheReadInputTokens;
  return total === 0 ? 0 : usage.cacheReadInputTokens / total;
}

export interface AgentTurn {
  text: string;
  sessionId?: string;
}

export interface AgentRunOutput {
  finalText: string;
  sessionId?: string;
  turns: number;
  usage?: AgentUsage;
  costUsd?: number;
  /** Raw agent output (e.g. the stream-json), persisted as the run transcript. */
  transcript?: string;
  /** Model the provider actually ran, parsed from its output stream when available. */
  model?: string;
  /** The CLI's own classification of why the turn ended (e.g. 'success', 'error_max_turns'); the terminal_reason/stop-reason diagnostic for a run that ended with no final text. */
  stopReason?: string;
  /** Truncated summary of the last assistant message's content blocks; set only when finalText ended up empty, so there is still evidence of what the spent tokens went to (thinking/tool_use instead of a reply). */
  lastBlock?: string;
}

/** Which CLI an adapter drives — the trait callers need instead of matching provider names. */
export type AgentFamily = 'claude-cli' | 'codex' | 'cursor' | 'pi';

/**
 * The one table mapping an adapter name to its family. Every adapter that runs `runClaudeCli`
 * (claude-code, zai, openrouter, meridian, and every repo-configured custom provider) is
 * `claude-cli`: it writes a resumable session jsonl, reads skills from ~/.claude, and so on. Callers
 * read the trait here instead of keeping their own name lists, which drifted (openrouter, meridian
 * and customs silently lost session capture).
 */
const AGENT_FAMILIES: Readonly<Record<string, AgentFamily>> = {
  'claude-code': 'claude-cli',
  zai: 'claude-cli',
  openrouter: 'claude-cli',
  meridian: 'claude-cli',
  codex: 'codex',
  cursor: 'cursor',
  pi: 'pi',
};

/**
 * Family of an adapter by its `AgentProvider.name` (`'claude-code'`, `'zai'`, … or `custom:<name>`) —
 * NOT the registry key a user types (`'claude'`); see providerUpstream in registry.ts for that namespace.
 * An unknown name is a custom provider, which always drives the Claude CLI.
 */
export function agentFamily(adapterName: string | undefined): AgentFamily {
  return adapterName !== undefined && Object.hasOwn(AGENT_FAMILIES, adapterName) ? (AGENT_FAMILIES[adapterName] ?? 'claude-cli') : 'claude-cli';
}

/** True when the table names this adapter explicitly (built-ins must; customs fall through by design). */
export function agentFamilyIsExplicit(adapterName: string): boolean {
  return Object.hasOwn(AGENT_FAMILIES, adapterName);
}

export interface AgentProvider {
  readonly name: string;
  /** Run one agent invocation inside the sandbox; yields assistant turns, returns a summary. */
  run: (input: AgentRunInput) => AsyncGenerator<AgentTurn, AgentRunOutput, void>;
}
