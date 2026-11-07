import { runAgent } from '../core/vanguard.js';
import { roundUsd } from '../core/usd.js';
import { diffForPrompt } from '../context/escape.js';
import type { RunContext, StageInput } from '../core/vanguard.js';
import { makeFrozenRun } from './pipeline.js';
import type { PipelineStage, PipelineResult, StageOutcome } from './pipeline.js';
import type { AgentProvider } from '../agents/provider.js';
import type { Judge } from '../evals/types.js';

export interface JudgedRepairOptions {
  agent: AgentProvider;
  /** First pass that produces the change. */
  generate: PipelineStage;
  /** Repair pass; receives {{JUDGE_REASON}}, {{PREVIOUS_DIFF}}, {{PREVIOUS_FINAL}}. */
  repair: PipelineStage;
  /** Judge of the produced diff after each pass. */
  judge: Judge;
  variables?: Record<string, string>;
  /** Consecutive rejects before escalating to a human. Default 3. */
  maxRejects?: number;
  signal?: AbortSignal;
  /**
   * Total budget for the generate + all repair attempts combined. When the accumulated spend
   * reaches this limit before the judge passes, the loop freezes with budget_exceeded and the
   * outcomes so far. Default: Number.POSITIVE_INFINITY (no cap, current behavior — the loop
   * terminates only on verdict.passed or maxRejects).
   */
  maxCostUsd?: number;
}

function toStageInput(
  stage: PipelineStage,
  agent: AgentProvider,
  variables: Record<string, string>,
  signal: AbortSignal | undefined,
  resumeSessionId: string | undefined,
  maxBudgetUsd?: number,
): StageInput {
  return {
    promptTemplate: stage.promptTemplate,
    agent,
    variables,
    ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
    ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
    ...(stage.model !== undefined ? { model: stage.model } : {}),
    ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt } : {}),
    ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}

/**
 * Generate, then judge-and-repair in a loop. After `maxRejects` consecutive rejections the run is
 * frozen (sandbox + worktree left alive) and returned as `needs_human` with a shell command the
 * operator can use to inspect the live sandbox. Caller disposes: keep the context on a frozen result.
 */
export async function runJudgedRepair(ctx: RunContext, opts: JudgedRepairOptions): Promise<PipelineResult> {
  const maxRejects = opts.maxRejects ?? 3;
  const maxCostUsd = opts.maxCostUsd ?? Number.POSITIVE_INFINITY;
  const baseVariables = opts.variables ?? {};
  const outcomes: StageOutcome[] = [];

  const generateBudget = maxCostUsd < Number.POSITIVE_INFINITY ? maxCostUsd : undefined;
  let result = await runAgent(
    ctx,
    toStageInput(opts.generate, opts.agent, baseVariables, opts.signal, undefined, generateBudget),
  );
  outcomes.push({ name: opts.generate.name, result });
  let sessionId = result.sessionId;
  let spentUsd = roundUsd(result.costUsd ?? 0);
  let rejects = 0;

  for (;;) {
    const verdict = await opts.judge.judge({
      testCase: { id: ctx.taskId, kind: 'control', input: opts.generate.name },
      output: result.diff ?? result.finalText,
    });
    if (verdict.passed) {
      return { status: 'completed', outcomes };
    }
    rejects += 1;
    if (rejects >= maxRejects) {
      return makeFrozenRun(ctx, 'needs_human', spentUsd, outcomes);
    }
    if (spentUsd >= maxCostUsd) {
      return makeFrozenRun(ctx, 'budget_exceeded', spentUsd, outcomes);
    }
    const variables: Record<string, string> = {
      ...baseVariables,
      JUDGE_REASON: verdict.reason,
      PREVIOUS_DIFF: diffForPrompt(result.diff ?? ''),
      PREVIOUS_FINAL: result.finalText,
    };
    const repairBudget = maxCostUsd < Number.POSITIVE_INFINITY ? roundUsd(maxCostUsd - spentUsd) : undefined;
    result = await runAgent(
      ctx,
      toStageInput(opts.repair, opts.agent, variables, opts.signal, sessionId, repairBudget),
    );
    outcomes.push({ name: `${opts.repair.name}#${rejects}`, result });
    if (result.sessionId !== undefined) sessionId = result.sessionId;
    spentUsd = roundUsd(spentUsd + (result.costUsd ?? 0));
  }
}
