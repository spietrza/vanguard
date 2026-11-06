import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { runAgent } from '../core/vanguard.js';
import { roundUsd } from '../core/usd.js';
import type { RunContext, StageInput } from '../core/vanguard.js';
import type { RunResult } from '../core/types.js';
import type { EvalVerdict } from '../evals/types.js';
import type { PipelineStage } from './pipeline.js';
import type { AgentProvider } from '../agents/provider.js';

const WORKDIR = '/workspace';

export interface ForkSelectOptions {
  agent: AgentProvider;
  /** Number of variants to run. Default 2. */
  n?: number;
  /** Session ID to fork from (passed as resumeSessionId + forkSession: true). */
  forkFromSessionId?: string;
  /** Score a variant's diff. Higher score wins; ties go to the earliest variant. */
  score: (diff: string, result: RunResult) => Promise<EvalVerdict>;
  variables?: Record<string, string>;
  signal?: AbortSignal;
  /** Remaining global budget before this forked stage started, for metric logging only. */
  remainingBudgetUsd?: number;
  /**
   * Total budget for the entire fork set in USD. Uses a rolling-residual model: each variant
   * receives `residual = stageBudgetUsd - costSoFar` as its maxBudgetUsd. When the residual
   * reaches zero before a variant starts, remaining variants are skipped and the best winner
   * found so far is returned. The first variant always runs regardless of residual.
   */
  stageBudgetUsd?: number;
}

export interface ForkVariant {
  result: RunResult;
  verdict: EvalVerdict;
}

export interface ForkSelectResult {
  winner: RunResult;
  winnerIndex: number;
  variants: ForkVariant[];
}

/**
 * Run a PipelineStage N times (default 2), each forking from the same base session. Score each
 * variant's diff and return the highest-scoring RunResult. Runs are sequential on the shared
 * context; the worktree is reset to HEAD between each variant so all forks start from the same
 * filesystem state. The winning diff is applied to the worktree before returning, so the next
 * stage receives it via {{PREVIOUS_DIFF}}.
 */
export async function forkAndSelect(
  ctx: RunContext,
  stage: PipelineStage,
  opts: ForkSelectOptions,
): Promise<ForkSelectResult> {
  const n = Math.max(1, opts.n ?? 2);
  const variants: ForkVariant[] = [];

  // Reset worktree to HEAD: discard the previous variant's changes before the next fork.
  // git reset --hard removes the intent-to-add index entries left by wm.diff(); git clean
  // then removes the resulting untracked files.
  const resetWorktree = async () => {
    await execa('git', hostGitArgs(['reset', '--hard', 'HEAD']), { cwd: ctx.worktreePath });
    await execa('git', hostGitArgs(['clean', '-fd']), { cwd: ctx.worktreePath });
  };

  let costSoFar = 0;
  for (let i = 0; i < n; i++) {
    // Rolling-residual budget: skip remaining variants when budget exhausted (always run at least one).
    if (i > 0 && opts.stageBudgetUsd !== undefined && roundUsd(opts.stageBudgetUsd - costSoFar) <= 0) {
      break;
    }

    if (i > 0) {
      await resetWorktree();
      // Re-seed the sandbox so the next variant starts from the same clean filesystem state.
      await ctx.sandbox.copyIn(ctx.worktreePath, WORKDIR);
    }

    const residual = opts.stageBudgetUsd !== undefined
      ? Math.max(0, roundUsd(opts.stageBudgetUsd - costSoFar))
      : undefined;

    const input: StageInput = {
      promptTemplate: stage.promptTemplate,
      agent: opts.agent,
      stageName: stage.name,
      variables: opts.variables ?? {},
      ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
      ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
      ...(stage.model !== undefined ? { model: stage.model } : {}),
      ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt } : {}),
      ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
      ...(opts.forkFromSessionId !== undefined
        ? { resumeSessionId: opts.forkFromSessionId, forkSession: true }
        : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(residual !== undefined ? { maxBudgetUsd: residual, stageCapUsd: residual } : {}),
      ...(opts.remainingBudgetUsd !== undefined ? { remainingBudgetUsd: opts.remainingBudgetUsd } : {}),
    };

    const result = await runAgent(ctx, input);
    costSoFar = roundUsd(costSoFar + (result.costUsd ?? 0));
    const verdict = await opts.score(result.diff ?? '', result);
    variants.push({ result, verdict });
  }

  // Highest score wins; ties go to the earliest variant.
  let winnerIndex = 0;
  for (let i = 1; i < variants.length; i++) {
    if (variants[i]!.verdict.score > variants[winnerIndex]!.verdict.score) {
      winnerIndex = i;
    }
  }

  // If the winner is not the last variant that ran, reset the worktree and apply its diff so the
  // next pipeline stage sees the correct {{PREVIOUS_DIFF}}.
  if (winnerIndex !== variants.length - 1) {
    await resetWorktree();
    const winnerDiff = variants[winnerIndex]!.result.diff;
    if (winnerDiff) {
      await execa('git', hostGitArgs(['apply', '--whitespace=fix', '-']), {
        cwd: ctx.worktreePath,
        input: winnerDiff,
      });
    }
    // Sync the sandbox to the winning state so subsequent stages run against the right files.
    await ctx.sandbox.copyIn(ctx.worktreePath, WORKDIR);
  }

  return {
    winner: variants[winnerIndex]!.result,
    winnerIndex,
    variants,
  };
}
