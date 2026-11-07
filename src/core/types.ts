import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider, AgentUsage } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

export type { ReasoningEffort } from '../wire.js';
import type { ReasoningEffort } from '../wire.js';

export type ExitReason = 'completed' | 'incomplete' | 'maxTurns' | 'timeout' | 'error' | 'needs_human' | 'budget_exceeded';

export interface RunOptions {
  taskId: string;
  localRepoPath: string;
  baseBranch?: string;
  reuse?: boolean;
  /** Keep a local base that is ahead of/diverged from origin (default: outside CI only). See resolveRemoteBaseRef. */
  keepLocalIfAhead?: boolean;
  promptTemplate: string;
  variables?: Record<string, string>;
  skills?: string[];
  effort?: ReasoningEffort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
  systemPrompt?: string;
  mcpConfig?: string;
  allowedTools?: string[];
  model?: string;
  sandbox: IsolatedSandboxProvider;
  agent: AgentProvider;
  logger?: VanguardLogger;
  signal?: AbortSignal;
}

export interface RunResult {
  taskId: string;
  completed: boolean;
  exitReason: ExitReason;
  turns: number;
  sessionId?: string;
  worktreePath: string;
  worktreePreserved: boolean;
  diff?: string;
  finalText: string;
  usage?: AgentUsage;
  costUsd?: number;
  cacheEfficiency?: number;
  /** Wall-clock duration of the agent run, in milliseconds. */
  durationMs?: number;
  /** Raw agent output (stream-json), persisted as the run transcript; omitted from run.json. */
  transcript?: string;
  /** Model actually used for the run: the provider-reported model, falling back to the configured one. */
  model?: string;
  /** The CLI's own classification of why the turn ended (e.g. 'success', 'error_max_turns'). See AgentRunOutput.stopReason. */
  stopReason?: string;
  /** Truncated summary of the last assistant message's content when finalText ended up empty. See AgentRunOutput.lastBlock. */
  lastBlock?: string;
  /** Number of agent calls folded into this result (resumes, repairs, fork variants); absent = 1. */
  attempts?: number;
  /** Exit reason of the FIRST attempt when more than one was folded in — keeps a truncation visible after a repair. */
  firstExitReason?: ExitReason;
}
