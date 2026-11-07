import { execa } from 'execa';
import { hostGitArgs } from '../worktree/host-git.js';
import { runAgent } from '../core/vanguard.js';
import { mergeAttempts } from '../core/run-metric.js';
import { forkAndSelect } from './fork-select.js';
import { buildXmlPrompt } from '../context/xml-prompt.js';
import { diffForPrompt } from '../context/escape.js';
import { extractJson } from '../structured/extract.js';
import { verdictSchema } from '../evals/judges.js';
import { AgentError, isRateLimitError } from '../core/errors.js';
import { roundUsd } from '../core/usd.js';
import type { RunContext } from '../core/vanguard.js';
import type { ReasoningEffort, RunResult } from '../core/types.js';
import type { AgentProvider } from '../agents/provider.js';
import type { Complete } from '../evals/judges.js';
import type { EvalVerdict } from '../evals/types.js';
import type { RunEvent } from './events.js';

/** Single source of truth for all canonical pipeline stage names. String values are stable. */
export const STAGE = {
  IMPLEMENTER: 'implementer',
  REVIEWER: 'reviewer',
  SIMPLIFIER: 'simplifier',
  CONFORMANCE: 'conformance',
  PLANNER: 'planner',
  GENERATOR: 'generator',
  EVALUATOR: 'evaluator',
  REPAIRER: 'repairer',
  ADVERSARY: 'adversary',
  TECH_SPEC: 'tech-spec',
} as const;

/** Stages whose flow-pinned model (opus) survives --provider-model: they plan/red-team, not implement. */
const PLANNER_TIER: ReadonlySet<string> = new Set([STAGE.PLANNER, STAGE.ADVERSARY]);

/** Union of all canonical stage name string literals. A typo is a compile error. */
export type StageName = (typeof STAGE)[keyof typeof STAGE];

/** Per-stage routing overrides applied by resolveRouting. Each field is last-writer-wins. */
export interface StageRouting {
  provider?: AgentProvider;
  model?: string;
  fallback?: { provider: AgentProvider; model?: string };
}

export interface PipelineStage {
  name: string;
  /** Template; may reference {{PREVIOUS_DIFF}}, {{PREVIOUS_FINAL}}, {{PREVIOUS_STAGE}}, {{PREVIOUS_STAGE_TRUNCATED}}, task variables, and !`cmd`. */
  promptTemplate: string;
  effort?: ReasoningEffort;
  maxTurns?: number;
  model?: string;
  /** System prompt appended for this stage (role/policy/guidelines/tradeoffs). */
  systemPrompt?: string;
  /** Resume the previous stage's session so this stage keeps context. Default true. */
  resumePrevious?: boolean;
  /** Run this stage on a specific provider instead of RunStagesOptions.agent (cross-provider review). */
  provider?: AgentProvider;
  /** When false, skip syncing sandbox files back to the worktree (read-only stage: no diff). Default true. */
  copyBack?: boolean;
  /**
   * Max times to auto-resume this stage's session when it exits without a completion signal
   * (`completed === false`). Some models (e.g. glm) end a turn with prose instead of a tool call and
   * stop early ("incomplete") before finishing a large, multi-file task. Each resume re-enters the
   * SAME session (full context preserved) with a "continue / finish the rest" nudge, up to this many
   * times or until the stage signals COMPLETE. Default 0 (no resume). Opt-in per stage.
   */
  resumeUntilComplete?: number;
  /**
   * Prompt sent on each auto-resume. Defaults to RESUME_NUDGE, which talks about files written to
   * disk — wrong for a read-only stage that produces a text block rather than a diff. Override it
   * there so the nudge names what the stage actually owes.
   */
  resumeNudge?: string;
  /**
   * When this stage's provider throws AgentError (unavailable/rate-limited/non-zero exit), re-run
   * the stage once on this provider+model instead of failing the entire run. Used for the reviewer:
   * degrade to the planning provider rather than blowing up the task on a transient Codex outage.
   * The fallback model replaces stage.model so a foreign model name (e.g. gpt-5) is never sent to
   * the planning provider.
   */
  fallback?: { provider: AgentProvider; model?: string };
  /**
   * Per-stage budget as a fraction of the run's maxCostUsd (0..1). Stored as a fraction (not an
   * absolute USD value) so a frozen-run resume with a higher maxCostUsd re-derives the cap automatically.
   * Undefined = the whole remaining global budget (old behavior, no per-stage cap).
   *
   * Note: on Claude/Zai the cap is a true mid-stage stop (--max-budget-usd). On Codex/Cursor/Pi it is
   * advisory — those providers pass no budget flag, so the cap is only checked after the stage returns.
   */
  stageCostFraction?: number;
  /**
   * Reserved minimum USD for this stage, applied as a floor after the fraction is computed.
   * The global budget always wins: if the floor exceeds what remains, the remaining global budget is used.
   */
  stageCostFloorUsd?: number;
  /**
   * Policy when this stage reaches its per-stage budget cap. Default 'continue'.
   * 'continue': proceed to the next stage (reviewer runs against the partial diff — better than no review).
   * 'freeze': return frozen/budget_exceeded immediately with outcomes so far.
   * 'skip': same as 'continue' (useful to signal the stage is optional).
   */
  onStageBudgetExceeded?: 'continue' | 'freeze' | 'skip';
  /**
   * Per-stage wall-clock timeout in ms. Wired to StageInput.timeoutMs (already plumbed to the provider).
   * When undefined, the per-invocation DEFAULT_TIMEOUT_MS (30 min) applies. A stage that exceeds its
   * timeout returns exitReason 'timeout', distinct from a caller-signal abort.
   */
  timeoutMs?: number;
}

export interface StageOutcome {
  name: string;
  result: RunResult;
  providerName?: string;
  model?: string;
}

export interface FrozenRun {
  status: 'frozen';
  reason: 'needs_human' | 'budget_exceeded';
  taskId: string;
  worktreePath: string;
  branch: string;
  shellCommand: string;
  spentUsd: number;
  outcomes: StageOutcome[];
}

export type PipelineResult = { status: 'completed'; outcomes: StageOutcome[] } | FrozenRun;

export function makeFrozenRun(
  ctx: RunContext,
  reason: FrozenRun['reason'],
  spentUsd: number,
  outcomes: StageOutcome[],
): FrozenRun {
  return {
    status: 'frozen',
    reason,
    taskId: ctx.taskId,
    worktreePath: ctx.worktreePath,
    branch: ctx.branch,
    shellCommand: ctx.sandbox.shellCommand(),
    spentUsd,
    outcomes,
  };
}

export interface ForkOptions {
  /** Number of implementation variants to generate. Default 2. */
  n?: number;
  /** LLM completion function used to score each variant's diff. Higher score wins. */
  complete: Complete;
  /** Scorer override (e.g. a decision model); when set, `complete` is not used for scoring. */
  score?: (diff: string, result: RunResult) => Promise<EvalVerdict>;
  /**
   * Name of the stage to run via forkAndSelect. Defaults to 'implementer'.
   * If no stage with this name exists in the pipeline, fork is silently ignored.
   */
  stageName?: StageName;
}

export interface RunStagesOptions {
  agent: AgentProvider;
  variables?: Record<string, string>;
  signal?: AbortSignal;
  maxCostUsd?: number;
  /** When set, run the implementer stage via forkAndSelect instead of a single pass. */
  fork?: ForkOptions;
  /** When set, receives structured run events (stage lifecycle + cost). Absent ⇒ no events, no behavior change. */
  onEvent?: (e: RunEvent) => void;
}

/** Sandbox dir for the fork scorer: a throwaway cwd so any stray write never touches the worktree. */
const SCORER_WORKDIR = '/tmp';

/**
 * A Complete backed by a one-shot agent run in the shared sandbox, used to score fork variants. Runs
 * the given provider (provider-agnostic) with maxTurns 1 in /tmp — the diff to rate is supplied
 * entirely in the prompt, so the scorer needs no worktree access and any stray file write lands in a
 * throwaway dir, never the code under review. Lets `run --fork` score variants without a host LLM SDK.
 */
export function sandboxComplete(ctx: RunContext, agent: AgentProvider, signal?: AbortSignal): Complete {
  return async (prompt: string): Promise<string> => {
    const gen = agent.run({
      prompt,
      sandbox: ctx.sandbox,
      workdir: SCORER_WORKDIR,
      home: ctx.home,
      maxTurns: 1,
      ...(signal !== undefined ? { signal } : {}),
    });
    for (;;) {
      const next = await gen.next();
      if (next.done) return next.value.finalText;
    }
  };
}

/** Build a scorer that asks the LLM to rate a diff, returning an EvalVerdict. */
function makeDiffScorer(complete: Complete): (diff: string, result: RunResult) => Promise<EvalVerdict> {
  return async (diff) => {
    const prompt = buildXmlPrompt({
      role: 'You are a strict judge evaluating a code diff.',
      guidelines:
        'Rate the quality of the diff. Return JSON in a <verdict> tag with fields: passed (bool), score (0..1, higher is better), reason (string).',
      task: `Diff:\n${diff || '(empty diff — no changes)'}\n\nReturn the verdict as <verdict>{...}</verdict>.`,
    });
    const text = await complete(prompt);
    return extractJson(text, 'verdict', verdictSchema);
  };
}

/**
 * Run stages sequentially over one shared context, enforcing a cumulative cost ceiling
 * (default $5). Chains the agent session stage-to-stage and exposes the previous stage's diff as
 * {{PREVIOUS_DIFF}} (substituted after command expansion, so backticks inside a diff never trigger
 * sandbox commands). Before each stage, if the cost spent so far has reached maxCostUsd, it stops
 * and returns a frozen `budget_exceeded` result with the outcomes so far; the caller keeps the
 * context alive and may resume with a higher limit.
 */
/** Appended to implementer prompts: forbid stopping at a partial milestone on a large task. */
export const DELIVER_FULL_SCOPE_CLAUSE =
  "Deliver EVERY acceptance criterion and EVERY file in the task's scope. Do not stop at a single layer or a partial milestone. If the task is large, work through all of it. Only write <promise>COMPLETE</promise> when the entire task is implemented; if you genuinely cannot finish, state precisely what remains.";

/** Nudge used when auto-resuming an incomplete stage (see PipelineStage.resumeUntilComplete). */
const RESUME_NUDGE = [
  'You stopped before signaling completion. Review what the task still requires versus what you have',
  'actually written to disk so far (check your own diff), then finish EVERY remaining part — including',
  'files, modules, or UI you have not created yet. Do not stop until the whole task is implemented.',
  'When (and only when) it is genuinely all done and verified, write <promise>COMPLETE</promise>.',
].join('\n');

/**
 * Resume nudge for the tech-spec stage. The default nudge points at files on disk; this stage writes
 * none, so it is told to stop researching and emit the block it already has the material for.
 */
const SPEC_RESUME_NUDGE = [
  'You stopped before emitting the specification. Stop researching now — you already have enough.',
  'Write the complete <tech_spec>...</tech_spec> block from what you have learned, followed by the',
  '<spec_manifest>{...}</spec_manifest> JSON. Mark anything you could not verify as an explicit',
  'assumption or risk inside the spec rather than going back to explore it.',
  'Then write <promise>COMPLETE</promise>.',
].join('\n');

/** Default whole-run USD cap when the caller sets none. Shared with the gate-loop repair budget. */
export const DEFAULT_RUN_MAX_COST_USD = 5;

export async function runBudgetedStages(
  ctx: RunContext,
  stages: PipelineStage[],
  opts: RunStagesOptions,
): Promise<PipelineResult> {
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_RUN_MAX_COST_USD;
  const outcomes: StageOutcome[] = [];
  let previous: RunResult | undefined;
  let prevName = '';
  let sessionId: string | undefined;
  // The provider that produced `sessionId`: a session is only resumable on the CLI that opened it, so
  // after an implementer fallback a resumePrevious stage on the primary agent starts fresh instead.
  let sessionOwner: string | undefined;
  // Set once a stage's primary provider threw and its fallback took over: later stages that carry a
  // fallback go straight to it instead of paying a failed attempt each against the same dead provider.
  let primaryDown = false;
  let spentUsd = 0;
  const emit = opts.onEvent ?? ((): void => {});
  let index = 0;
  const of = stages.length;
  for (const stage of stages) {
    if (spentUsd >= maxCostUsd) {
      return makeFrozenRun(ctx, 'budget_exceeded', spentUsd, outcomes);
    }
    emit({ type: 'stage-start', name: stage.name, index, of });
    const agent = stage.provider ?? opts.agent;
    const resume = (stage.resumePrevious ?? true) && sessionOwner === agent.name;

    // Per-stage effective cap: fraction → floor → min(remainingGlobal).
    // Global always wins (Math.min) so tiny-budget runs never spend past their limit.
    // Stored as fraction, not resolved USD, so a frozen-run resume with a higher maxCostUsd
    // re-derives the cap automatically when the caller reconstitutes the same PipelineStage config.
    const remainingGlobal = roundUsd(maxCostUsd - spentUsd);
    const fromFraction = stage.stageCostFraction !== undefined
      ? maxCostUsd * stage.stageCostFraction
      : remainingGlobal;
    const withFloor = Math.max(fromFraction, stage.stageCostFloorUsd ?? 0);
    const effectiveCap = roundUsd(Math.min(withFloor, remainingGlobal));
    const isFiniteCap = Number.isFinite(effectiveCap);
    const isFiniteGlobal = Number.isFinite(maxCostUsd);

    const variables: Record<string, string> = {
      ...(opts.variables ?? {}),
      // The diff is agent-written content (file text, quoted issue text): no `<` may open or close a prompt
      // block. diffForPrompt also prepends the escaping note, so every stage that shows the diff carries it.
      PREVIOUS_DIFF: diffForPrompt(previous?.diff ?? ''),
      PREVIOUS_FINAL: previous?.finalText ?? '',
      PREVIOUS_STAGE: prevName,
      PREVIOUS_STAGE_TRUNCATED: previous !== undefined && previous.exitReason !== 'completed' ? 'true' : 'false',
    };

    if (opts.fork !== undefined && stage.name === (opts.fork.stageName ?? STAGE.IMPLEMENTER)) {
      const forkResult = await forkAndSelect(ctx, stage, {
        agent,
        ...(opts.fork.n !== undefined ? { n: opts.fork.n } : {}),
        score: opts.fork.score ?? makeDiffScorer(opts.fork.complete),
        variables,
        ...(resume && sessionId !== undefined ? { forkFromSessionId: sessionId } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(isFiniteCap ? { stageBudgetUsd: effectiveCap } : {}),
        ...(isFiniteGlobal ? { remainingBudgetUsd: remainingGlobal } : {}),
      });
      // The winner keeps its identity; the losing variants' cost/tokens fold in so the stage metric
      // reflects everything the fork spent, not just the chosen branch.
      const result = forkResult.variants
        .filter((_, i) => i !== forkResult.winnerIndex)
        .reduce((acc, loser) => mergeAttempts(loser.result, acc), forkResult.winner);
      const forkStageCost = roundUsd(result.costUsd ?? 0);
      outcomes.push({
        name: stage.name,
        result,
        providerName: agent.name,
        ...(stage.model !== undefined ? { model: stage.model } : {}),
      });
      previous = result;
      prevName = stage.name;
      if (result.sessionId !== undefined) {
        sessionId = result.sessionId;
        sessionOwner = agent.name;
      }
      spentUsd = roundUsd(spentUsd + forkStageCost);
      emit({ type: 'stage-end', name: stage.name, index, of, outcome: result.completed ? 'completed' : result.exitReason });
      emit({ type: 'cost', usdSpent: spentUsd });
      index += 1;

      // Orchestrator-side post-stage cap check (reactive; covers providers that ignore maxBudgetUsd).
      if (isFiniteCap && forkStageCost >= effectiveCap) {
        const policy = stage.onStageBudgetExceeded ?? 'continue';
        if (policy === 'freeze') return makeFrozenRun(ctx, 'budget_exceeded', spentUsd, outcomes);
      }
      continue;
    }

    // Effective provider and model; may be overridden when the stage's fallback activates.
    const skipPrimary = primaryDown && stage.provider === undefined && stage.fallback !== undefined;
    let effectiveAgent = skipPrimary && stage.fallback !== undefined ? stage.fallback.provider : agent;
    let effectiveModel: string | undefined = skipPrimary && stage.fallback !== undefined ? stage.fallback.model : stage.model;

    // Stable per-stage options shared by the primary attempt, fallback, and any auto-resume calls.
    const stageOpts = {
      stageName: stage.name,
      variables,
      ...(stage.effort !== undefined ? { effort: stage.effort } : {}),
      ...(stage.maxTurns !== undefined ? { maxTurns: stage.maxTurns } : {}),
      ...(stage.systemPrompt !== undefined ? { systemPrompt: stage.systemPrompt } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(stage.copyBack !== undefined ? { copyBack: stage.copyBack } : {}),
      ...(isFiniteCap ? { maxBudgetUsd: effectiveCap, stageCapUsd: effectiveCap } : {}),
      ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
      ...(isFiniteGlobal ? { remainingBudgetUsd: remainingGlobal } : {}),
    };

    let result: RunResult;
    try {
      result = await runAgent(ctx, {
        ...stageOpts,
        promptTemplate: stage.promptTemplate,
        agent: effectiveAgent,
        ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
        ...(resume && sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
      });
    } catch (err) {
      if (err instanceof AgentError && stage.fallback !== undefined) {
        // No `reason` here: AgentError carries the CLI's raw stderr, and an auth failure may echo the
        // credential it was handed — the redactor knows common token shapes, not every vendor's.
        const rateLimited = isRateLimitError(err);
        ctx.log.warn(
          { stage: stage.name, from: agent.name, to: stage.fallback.provider.name, rateLimited },
          rateLimited
            ? `${stage.name} provider rate-limited (429) — falling back to ${stage.fallback.provider.name}`
            : `${stage.name} provider unavailable — falling back to ${stage.fallback.provider.name}`,
        );
        effectiveAgent = stage.fallback.provider;
        effectiveModel = stage.fallback.model;
        if (stage.provider === undefined) primaryDown = true;
        // Do not resume the failed primary session.
        result = await runAgent(ctx, {
          ...stageOpts,
          promptTemplate: stage.promptTemplate,
          agent: effectiveAgent,
          ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
        });
      } else {
        // No fallback to catch this one: at least name a rate limit for what it is before it
        // propagates — the operator log line that follows (watch-prs / revise-pr) stays generic.
        if (err instanceof AgentError && isRateLimitError(err)) {
          ctx.log.warn({ stage: stage.name, provider: agent.name }, `${stage.name} provider rate-limited (429) — no fallback configured`);
        }
        throw err;
      }
    }
    let stageCost = roundUsd(result.costUsd ?? 0);

    // Auto-resume an incomplete stage: some models (glm) end a turn with prose instead of a tool call
    // and stop before finishing a large, multi-file task. Re-enter the SAME session (context intact)
    // with a "finish the rest" nudge, up to stage.resumeUntilComplete times or until it signals COMPLETE.
    // Per-stage cap gates the loop (aggregate across all resumes) and provides a residual budget to each
    // resume call so a multi-resume stage cannot multiply its cap across iterations.
    let resumesLeft = stage.resumeUntilComplete ?? 0;
    while (
      !result.completed &&
      resumesLeft > 0 &&
      result.sessionId !== undefined &&
      spentUsd + stageCost < maxCostUsd &&
      (!isFiniteCap || stageCost < effectiveCap)
    ) {
      resumesLeft -= 1;
      ctx.log.info(
        { taskId: ctx.taskId, stage: stage.name, exitReason: result.exitReason, resumesLeft },
        'stage incomplete — resuming session',
      );
      const resumed = await runAgent(ctx, {
        ...stageOpts,
        promptTemplate: stage.resumeNudge ?? RESUME_NUDGE,
        agent: effectiveAgent,
        ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
        resumeSessionId: result.sessionId,
        ...(isFiniteCap ? { maxBudgetUsd: effectiveCap - stageCost } : {}),
      });
      // Fold the resume into the stage result so the persisted metric carries every attempt's cost;
      // the loop's cap check reads the same figure.
      result = mergeAttempts(result, resumed);
      stageCost = roundUsd(result.costUsd ?? 0);
    }

    outcomes.push({
      name: stage.name,
      result,
      providerName: effectiveAgent.name,
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
    });
    previous = result;
    prevName = stage.name;
    if (result.sessionId !== undefined) {
      sessionId = result.sessionId;
      sessionOwner = effectiveAgent.name;
    }
    spentUsd = roundUsd(spentUsd + stageCost);
    emit({ type: 'stage-end', name: stage.name, index, of, outcome: result.completed ? 'completed' : result.exitReason });
    emit({ type: 'cost', usdSpent: spentUsd });
    index += 1;

    // Orchestrator-side post-stage cap check (reactive; covers providers that ignore maxBudgetUsd).
    if (isFiniteCap && stageCost >= effectiveCap) {
      const policy = stage.onStageBudgetExceeded ?? 'continue';
      if (policy === 'freeze') return makeFrozenRun(ctx, 'budget_exceeded', spentUsd, outcomes);
      // 'continue' and 'skip': proceed to the next stage (reviewer runs against the partial diff).
    }
  }
  return { status: 'completed', outcomes };
}

/** Run stages with no budget ceiling, returning just the outcomes (unchanged behaviour). */
export async function runStages(
  ctx: RunContext,
  stages: PipelineStage[],
  opts: RunStagesOptions,
): Promise<StageOutcome[]> {
  const result = await runBudgetedStages(ctx, stages, { ...opts, maxCostUsd: Number.POSITIVE_INFINITY });
  return result.outcomes;
}

/** Advisory retrospective-memory block appended to task-bearing prompts. The {{RETROSPECTIVE_MEMORY}} placeholder renders empty when the runner supplies no memory. */
export function retrospectiveMemoryBlock(): string {
  return [
    '<retrospective_memory>',
    'Retrospective memory from prior Vanguard runs; use only when relevant to this task.',
    '{{RETROSPECTIVE_MEMORY}}',
    '</retrospective_memory>',
  ].join('\n');
}

/**
 * XML system prompt with explicit trade-off reasoning (Anthropic playbook). Appended to every
 * canonical stage so the agent weighs cost-of-error against cost-of-verification, not just follows
 * instructions. Pass it as PipelineStage.systemPrompt (the canonical stage sets do this by default).
 */
export function defaultSystemPrompt(): string {
  return [
    '<role>',
    'You are a senior software engineer working autonomously in an isolated sandbox on a single task.',
    '</role>',
    '<policy>',
    'Make the smallest correct change that satisfies the task. Do not commit or push; the host commits and opens a pull request for human review. Keep changes scoped to the task.',
    '</policy>',
    '<guidelines>',
    'Prefer tools over assumptions: when a tool is available (typecheck, run_tests), call it to verify instead of guessing. Read the relevant files before editing. Match the existing code style. When a knowledge or test tool is available, use it before guessing.',
    '</guidelines>',
    '<tradeoffs>',
    'A wrong or sloppy change costs reviewer trust and rework, far more than the few seconds a typecheck or test run takes. An over-large change costs review time and risks regressions. Favor a minimal, verified change over a fast, unverified one.',
    '</tradeoffs>',
    '<efficiency>',
    'Spend tokens on the change, not on prose. Read only the files you need, keep reasoning brief, and keep your messages terse — no preamble, no restating the task, no summaries of what you are about to do. Verification still matters; verbosity does not.',
    '</efficiency>',
  ].join('\n');
}

/**
 * Fast single-stage preset: one implementer pass with low effort on a fast model. Cheaper and
 * quicker than the multi-stage pipeline, and still runs on the Claude subscription via the CLI.
 */
export function fastStages(): PipelineStage[] {
  return [
    {
      name: STAGE.IMPLEMENTER,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nImplement the solution in the current repo. When done, write exactly <promise>COMPLETE</promise>.',
      effort: 'low',
      model: 'haiku',
      maxTurns: 12,
      systemPrompt: defaultSystemPrompt(),
    },
  ];
}

/** Canonical Implementer -> Reviewer -> Simplifier stages (Merger is commitStage). */
export function implementReviewSimplifyStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: STAGE.IMPLEMENTER,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nContext from the ticket comments (includes any Vanguard Tech Spec):\n{{COMMENTS}}\n\nImplement the solution in the current repo.\n\n' +
        retrospectiveMemoryBlock() +
        `\n\n${DELIVER_FULL_SCOPE_CLAUSE}\n\nWhen done, write exactly <promise>COMPLETE</promise>.`,
      maxTurns: 30,
      stageCostFraction: 0.6,
      stageCostFloorUsd: 0.25,
      timeoutMs: 25 * 60 * 1000,
      onStageBudgetExceeded: 'continue',
    },
    {
      name: STAGE.REVIEWER,
      // Fresh context (resumePrevious:false): an independent reviewer judges the diff cold, without
      // inheriting the implementer's reasoning. The files are still on disk in the shared worktree.
      resumePrevious: false,
      promptTemplate:
        'You are an independent code reviewer of the change below — you did not write it. If a code-review skill is available, use it. Review adversarially for bugs, security, missing tests, and convention violations. Also review for over-engineering: unnecessary complexity, speculative abstractions, boilerplate, and dead code — apply the ponytail lens (would less code do the same job?) and prefer deletion. Fix what you find in the repo.\n\nTicket and spec context (if a <tech_spec> block is present, its Acceptance Criteria and Tests section are mandatory — flag as a high-severity finding any AC or spec-mandated test the diff does not cover, unless the PR body explicitly declares it deferred):\n{{COMMENTS}}\n\n{{PREVIOUS_DIFF}}\n\nAfter completing your review and any fixes, emit a verdict: if there are no blocking issues, write exactly "No blocking issues." on its own line. If there are high or critical severity issues, also include a structured block: <findings>{"findings":[{"severity":"high|critical","kind":"security|perf|correctness|style","title":"...","evidence":"..."}]}</findings>.\n\nWhen done, write <promise>COMPLETE</promise>.',
      effort: 'high',
      maxTurns: 20,
      stageCostFraction: 0.25,
      stageCostFloorUsd: 0.5,
      timeoutMs: 15 * 60 * 1000,
      onStageBudgetExceeded: 'continue',
    },
    {
      name: STAGE.SIMPLIFIER,
      resumePrevious: false,
      promptTemplate:
        'Improve the changed code for clarity, reuse, and simplicity without changing behaviour. If a simplify skill is available, use it.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
      maxTurns: 20,
      stageCostFraction: 0.15,
      stageCostFloorUsd: 0.25,
      timeoutMs: 15 * 60 * 1000,
      onStageBudgetExceeded: 'skip',
    },
  ];
  return stages.map((stage) => ({ systemPrompt, ...stage }));
}

/** Report-only conformance pass. Appended by assembleReviewPipeline only when explicitly enabled. */
export function conformanceStage(): PipelineStage {
  return {
    name: STAGE.CONFORMANCE,
    // Fresh context: compare the final diff against spec without inheriting prior reasoning.
    resumePrevious: false,
    // Report-only: no sandbox->worktree sync.
    copyBack: false,
    effort: 'high',
    maxTurns: 16,
    systemPrompt: conformanceSystemPrompt(),
    promptTemplate: [
      'You are an independent conformance reviewer. Do not edit any files.',
      '',
      'If the context below contains no <tech_spec> block, write exactly:',
      'No spec, conformance skipped.',
      'then <promise>COMPLETE</promise> and stop.',
      '',
      'Otherwise, compare the diff against the spec Acceptance Criteria. Flag exactly three classes of issues:',
      '1. Unmet or partially-met Acceptance Criteria',
      '2. Scope drift or scope creep (changes outside the spec)',
      '3. Silently dropped requirements',
      '',
      'Report only. Do not edit files.',
      '',
      'Spec and comments:',
      '{{COMMENTS}}',
      '',
      'Diff:',
      '{{PREVIOUS_DIFF}}',
      '',
      'If you find issues, emit:',
      '<findings>{"findings":[{"severity":"high|critical|medium|low","kind":"correctness","title":"...","evidence":"..."}]}</findings>',
      'If there are no issues, write: No conformance issues.',
      '',
      'End with <promise>COMPLETE</promise>.',
    ].join('\n'),
  };
}

/**
 * Route one named stage (default 'reviewer') to a different provider, leaving the rest on the
 * pipeline's default agent. This is the cross-provider review toggle: the implementer stays on the
 * main provider while the reviewer runs on an independent one to catch different classes of bugs.
 */
export function withStageProvider(
  stages: PipelineStage[],
  provider: AgentProvider,
  stageName: StageName = STAGE.REVIEWER,
): PipelineStage[] {
  return stages.map((stage) => (stage.name === stageName ? { ...stage, provider } : stage));
}

/** Set `model` on one named stage (default: all stages when stageName is omitted). */
export function withStageModel(stages: PipelineStage[], model: string, stageName?: StageName): PipelineStage[] {
  return stages.map((stage) => (stageName === undefined || stage.name === stageName ? { ...stage, model } : stage));
}

/**
 * Override `maxTurns` on one named stage (default: 'implementer'). Backs `--max-turns`: an opt-in
 * override of the implementer's hardcoded turn cap so one run can finish a deliberately large task.
 */
export function withStageMaxTurns(
  stages: PipelineStage[],
  maxTurns: number,
  stageName: StageName = STAGE.IMPLEMENTER,
): PipelineStage[] {
  return stages.map((stage) => (stage.name === stageName ? { ...stage, maxTurns } : stage));
}

/**
 * Set `resumeUntilComplete` on one named stage (default: 'implementer'). Backs `--max-repair-iterations`
 * for the *incomplete* case: when the implementer ends a turn without `<promise>COMPLETE</promise>` while
 * still under budget, re-enter the same session with a "finish the rest" nudge up to N times (see the
 * auto-resume loop in runBudgetedStages). Complements the gate-repair loop, which only fires on gate failure.
 */
export function withStageResumeUntilComplete(
  stages: PipelineStage[],
  resumeUntilComplete: number,
  stageName: StageName = STAGE.IMPLEMENTER,
): PipelineStage[] {
  return stages.map((stage) => (stage.name === stageName ? { ...stage, resumeUntilComplete } : stage));
}

/**
 * Set `model` on every stage EXCEPT `exceptStage`. Applies the implement provider's `--provider-model`
 * to the main stages without leaking it onto a cross-provider reviewer: an Anthropic model name (e.g.
 * `sonnet`) handed to a Codex/ChatGPT reviewer is rejected by the backend. The reviewer keeps its own
 * provider default unless `--review-model` sets it explicitly.
 */
export function withStageModelExcept(stages: PipelineStage[], model: string, exceptStage: string): PipelineStage[] {
  return stages.map((stage) => (stage.name === exceptStage ? stage : { ...stage, model }));
}

/**
 * Set a fallback provider+model on one named stage (default: 'reviewer'). When the stage's primary
 * provider throws AgentError, runBudgetedStages re-runs it once on the fallback provider. Used to
 * degrade gracefully from a cross-provider reviewer (e.g. Codex) to the planning provider (Claude)
 * instead of failing the whole task on a transient outage or rate limit.
 */
export function withStageFallback(
  stages: PipelineStage[],
  fallback: { provider: AgentProvider; model?: string },
  stageName: StageName = STAGE.REVIEWER,
): PipelineStage[] {
  return stages.map((stage) => (stage.name === stageName ? { ...stage, fallback } : stage));
}

/**
 * Attach `fallback` to every stage that runs on the primary agent (no `provider` of its own and no
 * fallback yet): implementer, simplifier, planner, tech-spec — and any name a repo flow uses. A
 * provider that is down for the implementer is down for the simplifier too; rescuing one stage
 * would still lose the run (and the work) at the next.
 */
export function withPrimaryFallback(stages: PipelineStage[], fallback: { provider: AgentProvider; model?: string }): PipelineStage[] {
  return stages.map((stage) => (stage.provider === undefined && stage.fallback === undefined ? { ...stage, fallback } : stage));
}

export interface ReviewPipelineDeps {
  provider?: string;
  reviewProvider?: string;
  providerModel?: string;
  reviewModel?: string;
  noSimplify?: boolean;
  /** When true, include the conformance stage. Default false (opt-in). */
  conformance?: boolean;
  /** Model override for the conformance stage only (e.g. 'opus' for planner-tier). */
  conformanceModel?: string;
  /**
   * Model the implement provider forces when a stage names none (zai → glm, openrouter → its slug, a
   * custom's `model`). Set only for such providers: a flow-pinned planner-tier model (opus) cannot be
   * served there, so those stages take `providerModel` or, failing that, this forced model.
   */
  providerForcedModel?: string;
}

/**
 * Apply per-stage routing overrides to `baseStages` in a single, order-free pass. The result depends
 * only on `config`'s contents, not on the order its keys were inserted: each stage is matched by name
 * and its `provider`/`model`/`fallback` overridden when present. Stages without a config entry pass
 * through untouched. Pure — never mutates its inputs.
 */
export function resolveRouting(
  baseStages: PipelineStage[],
  config: Partial<Record<StageName, StageRouting>>,
): PipelineStage[] {
  return baseStages.map((stage) => {
    const routing = config[stage.name as StageName];
    if (routing === undefined) return stage;
    return {
      ...stage,
      ...(routing.provider !== undefined ? { provider: routing.provider } : {}),
      ...(routing.model !== undefined ? { model: routing.model } : {}),
      ...(routing.fallback !== undefined ? { fallback: routing.fallback } : {}),
    };
  });
}

/**
 * Compose the standard review pipeline transformers over `base` stages. Handles the `--no-simplify`
 * filter, cross-provider reviewer gating, per-stage model assignment, optional conformance, and
 * fallback wiring in one place so neither the GitHub nor Linear runner needs to inline these steps.
 *
 * Membership is decided first (filter/append); then a flat routing config is built and applied by
 * resolveRouting in one pass. Three subtle rules live as explicit config-building code: (1) a
 * cross-provider reviewer is excluded from `providerModel` — an Anthropic model name handed to a
 * Codex/ChatGPT reviewer is rejected by the backend, while a same-provider reviewer keeps it;
 * (2) `conformanceModel` wins over `providerModel` on the conformance stage (last-writer-wins); and
 * (3) a planner-tier stage (PLANNER_TIER) with a flow-pinned model keeps it — unless the provider
 * forces its own model (`providerForcedModel`), which cannot serve the pinned alias.
 */
export function assembleReviewPipeline(
  base: PipelineStage[],
  agents: { agent: AgentProvider; reviewAgent?: AgentProvider },
  deps: ReviewPipelineDeps,
): PipelineStage[] {
  // Membership first: drop the cleanup stage for --no-simplify, append optional conformance.
  let pipeline = deps.noSimplify === true ? base.filter((s) => s.name !== STAGE.SIMPLIFIER) : base;
  if (deps.conformance === true) {
    pipeline = [...pipeline, conformanceStage()];
  }

  // Build a flat per-stage routing config; merge so later writers win on a given field.
  const config: Partial<Record<StageName, StageRouting>> = {};
  const route = (name: StageName, patch: StageRouting): void => {
    config[name] = { ...config[name], ...patch };
  };

  if (deps.providerModel !== undefined || deps.providerForcedModel !== undefined) {
    // Only a CROSS-provider reviewer and the pinned planner-tier stages are excluded from the implement
    // model. Gating on the mere presence of reviewAgent would wrongly strip the model when
    // --review-provider equals --provider. Planner/adversary keep the stronger model their flow pins
    // (opus) — the whole point of --plan/flow-b is "plan and red-team high, implement cheap", which a
    // single implement model flag must not flatten. The exception is a forced-model provider, which
    // cannot serve `opus` at all: there the pinned tier takes providerModel (or the forced default) so
    // the flow still runs. An UNPINNED planner-tier stage (repo HCL flow) gets providerModel like any
    // other stage. Everything else (incl. conformance) gets providerModel.
    const crossProviderReview =
      deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
    for (const stage of pipeline) {
      if (crossProviderReview && stage.name === STAGE.REVIEWER) continue;
      const pinnedPlannerTier = PLANNER_TIER.has(stage.name) && stage.model !== undefined;
      if (pinnedPlannerTier && deps.providerForcedModel === undefined) continue;
      const model = deps.providerModel ?? (pinnedPlannerTier ? deps.providerForcedModel : undefined);
      if (model !== undefined) route(stage.name as StageName, { model });
    }
  }
  // Cross-provider reviewer: route it to its own provider, and fall back to the planning provider on
  // AgentError (outage/rate-limit) rather than failing the whole run. The fallback never sends the
  // reviewer's foreign model name.
  if (agents.reviewAgent !== undefined) {
    route(STAGE.REVIEWER, {
      provider: agents.reviewAgent,
      fallback: {
        provider: agents.agent,
        ...(deps.providerModel !== undefined ? { model: deps.providerModel } : {}),
      },
    });
  }
  // reviewModel overrides providerModel on the reviewer only.
  if (deps.reviewModel !== undefined) route(STAGE.REVIEWER, { model: deps.reviewModel });
  // conformanceModel wins over providerModel on the conformance stage (last-writer-wins).
  if (deps.conformanceModel !== undefined) route(STAGE.CONFORMANCE, { model: deps.conformanceModel });

  return resolveRouting(pipeline, config);
}

/**
 * Plan with the most capable model, then implement and review with a faster one. The planner
 * (opus, high effort) emits a <plan>; the implementer and reviewer run on sonnet to cut cost and
 * latency. Each later stage gets the plan / diff via variables, in a fresh context.
 */
export function planImplementReviewStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: STAGE.PLANNER,
      model: 'opus',
      effort: 'high',
      maxTurns: 15,
      resumePrevious: false,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nProduce a concise implementation plan inside <plan>...</plan>. Do not edit files yet. When done, write <promise>COMPLETE</promise>.',
    },
    {
      name: STAGE.IMPLEMENTER,
      model: 'sonnet',
      maxTurns: 30,
      resumePrevious: false,
      promptTemplate:
        `Implement the change in the current repo, following this plan:\n\n{{PREVIOUS_FINAL}}\n\n${DELIVER_FULL_SCOPE_CLAUSE}\n\nWhen done, write <promise>COMPLETE</promise>.`,
    },
    {
      name: STAGE.REVIEWER,
      model: 'sonnet',
      effort: 'high',
      maxTurns: 20,
      resumePrevious: false,
      promptTemplate:
        'Review the diff below for bugs and gaps, then fix the code:\n\n{{PREVIOUS_DIFF}}\n\nAfter completing your review and any fixes, emit a verdict: if there are no blocking issues, write exactly "No blocking issues." on its own line. If there are high or critical severity issues, also include a structured block: <findings>{"findings":[{"severity":"high|critical","kind":"security|perf|correctness|style","title":"...","evidence":"..."}]}</findings>.\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
  ];
  return stages.map((stage) => ({ systemPrompt, ...stage }));
}

export interface CommitOptions {
  message: string;
  authorName?: string;
  authorEmail?: string;
}

export interface CommitOutcome {
  committed: boolean;
  branch: string;
  sha?: string;
}

/**
 * Merger stage: commit the agent's work onto the worktree branch. Returns committed=false
 * when there is nothing to commit. Push / PR is the caller's explicit opt-in step.
 */
export async function commitStage(ctx: RunContext, opts: CommitOptions): Promise<CommitOutcome> {
  if (!(await ctx.wm.isDirty(ctx.worktreePath))) return { committed: false, branch: ctx.branch };
  const name = opts.authorName ?? 'Vanguard';
  const email = opts.authorEmail ?? 'vanguard@local';
  await execa('git', hostGitArgs(['add', '-A']), { cwd: ctx.worktreePath });
  // --no-verify skips the target repo's husky/pre-commit hooks. Vanguard commits in an isolated worktree
  // without the project's node_modules, so hooks that run eslint/nx/tests (e.g. an `@nx/eslint-plugin`
  // lint or `nx run api:test-unit`) fail to resolve and would block every commit. Vanguard has its own
  // reviewer/verification pipeline and the PR's CI re-runs these checks, so the local pre-commit gate is
  // redundant here.
  await execa(
    'git',
    hostGitArgs(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-verify', '-m', opts.message]),
    { cwd: ctx.worktreePath },
  );
  const { stdout } = await execa('git', hostGitArgs(['rev-parse', 'HEAD']), { cwd: ctx.worktreePath });
  return { committed: true, branch: ctx.branch, sha: stdout.trim() };
}

/**
 * Generate -> Evaluate -> Repair (Anthropic playbook). The Evaluator only reports violations
 * (no edits); the Repairer applies targeted fixes from that report. Evaluator and Repairer run
 * in fresh contexts (resumePrevious: false) to cut tokens, operating on the shared worktree plus
 * the diff / report passed in.
 */
export function generateEvaluateRepairStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: STAGE.GENERATOR,
      promptTemplate:
        '<task_instructions>\nTask: {{TITLE}}\n\n{{DESCRIPTION}}\n\nGenerate a first version of the solution in the current repo. Implement, do not review. When done, write <promise>COMPLETE</promise>.\n</task_instructions>',
    },
    {
      name: STAGE.EVALUATOR,
      promptTemplate:
        '<role>Strict reviewer. You do not change files.</role>\n<task_instructions>\nAnalyse the diff below and list ONLY violations and bugs inside <violations>...</violations>. Do not edit code.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.\n</task_instructions>',
      effort: 'high',
      resumePrevious: false,
    },
    {
      name: STAGE.REPAIRER,
      promptTemplate:
        '<task_instructions>\nApply targeted fixes based on the violations report. Fix only what is listed:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.\n</task_instructions>',
      resumePrevious: false,
    },
  ];
  return stages.map((stage) => ({ systemPrompt, ...stage }));
}

/** System prompt for the conformance reviewer (reports only, never edits). */
export function conformanceSystemPrompt(): string {
  return [
    '<role>Conformance reviewer. You compare the implementation diff against the tech spec Acceptance Criteria. You do not edit files.</role>',
    '<policy>Never edit files. Report only. A missed dropped requirement is more costly than a noted false positive.</policy>',
    '<guidelines>For each Acceptance Criterion in the spec, verify whether the diff satisfies it. Flag unmet or partially-met criteria, scope drift or scope creep, and silently dropped requirements. Name the criterion text in your evidence.</guidelines>',
    '<tradeoffs>A missed dropped requirement causes rework; a noted false positive is a quick triage. When unsure, report it.</tradeoffs>',
  ].join('\n');
}

/** Red-team system prompt for the adversarial reviewer (reports only, never edits). */
export function adversarySystemPrompt(): string {
  return [
    '<role>Adversarial security and performance reviewer. Assume the change is guilty until proven safe.</role>',
    '<policy>You never edit files. You only report findings. Prefer false positives over missed vulnerabilities.</policy>',
    '<guidelines>Hunt for: injection, secret or PII exposure, auth/authz gaps, unsafe deserialization, path traversal, ReDoS, N+1 and quadratic patterns, unbounded growth, race conditions. Verify each claim against the diff.</guidelines>',
    '<tradeoffs>A missed vulnerability is far more costly than a false positive; when unsure, report it.</tradeoffs>',
  ].join('\n');
}

/**
 * Plan (opus) -> implement (sonnet) -> adversary (opus, red-team, reports <findings>) -> repair (sonnet).
 * The adversary runs on a different model than the implementer and only reports; the repairer fixes
 * from the findings via {{PREVIOUS_FINAL}}.
 */
export function planImplementAdversaryStages(): PipelineStage[] {
  const systemPrompt = defaultSystemPrompt();
  const stages: PipelineStage[] = [
    {
      name: STAGE.PLANNER,
      model: 'opus',
      effort: 'high',
      maxTurns: 15,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Task: {{TITLE}}\n\n{{DESCRIPTION}}\n\nProduce a concise implementation plan inside <plan>...</plan>. Do not edit files yet. When done, write <promise>COMPLETE</promise>.',
    },
    {
      name: STAGE.IMPLEMENTER,
      model: 'sonnet',
      maxTurns: 30,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Implement the change in the current repo, following this plan:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
    {
      name: STAGE.ADVERSARY,
      model: 'opus',
      effort: 'high',
      maxTurns: 12,
      resumePrevious: false,
      systemPrompt: adversarySystemPrompt(),
      promptTemplate:
        'Review the diff below. Emit ONLY a single <findings> block of this exact shape:\n<findings>{"findings":[{"severity":"low|medium|high|critical","kind":"security|perf|correctness|style","title":"...","evidence":"..."}]}</findings>\nThe top-level value is an object with a "findings" array (not a bare array), sorted by severity. Do not edit files.\n\n{{PREVIOUS_DIFF}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
    {
      name: STAGE.REPAIRER,
      model: 'sonnet',
      maxTurns: 20,
      resumePrevious: false,
      systemPrompt,
      promptTemplate:
        'Apply targeted fixes for these findings, highest severity first; fix only what is listed:\n\n{{PREVIOUS_FINAL}}\n\nWhen done, write <promise>COMPLETE</promise>.',
    },
  ];
  return stages;
}

/** System prompt for the tech-spec stage: strict architect role, read-only, no file edits. */
export function techSpecSystemPrompt(): string {
  return [
    '<role>',
    'You are a strict software architect producing a technical specification. You do not edit, create, or delete any source files.',
    '</role>',
    '<policy>',
    'Read existing code and documentation to understand the current system. Do not modify source files. Your only output is the technical specification wrapped in <tech_spec>...</tech_spec>.',
    '</policy>',
    '<guidelines>',
    'Research the codebase read-only: read files, inspect interfaces, understand data flows and dependencies. Use all available information to produce a precise, actionable spec. Cover the problem, architecture, acceptance criteria, tests, risks, and performance/scalability.',
    '</guidelines>',
    '<tradeoffs>',
    'An under-specified tech spec causes rework and mis-implementation. A precise spec that does not touch source is far safer than one that guesses and edits. When uncertain about a detail, note it as an open question rather than inventing an answer.',
    '</tradeoffs>',
  ].join('\n');
}

/**
 * Tech-spec stage: a single read-only stage that researches the codebase and produces a technical
 * specification wrapped in <tech_spec>...</tech_spec>. Sets copyBack: false — no source files are
 * modified. Use extractTag(result.finalText, 'tech_spec') to pull the spec out of the outcome.
 *
 * Model is omitted from the stage unless explicitly supplied via opts.model; the caller owns the
 * provider-aware default (e.g. 'haiku' for Claude, omitted for z.ai so ZaiProvider picks glm).
 */
export function techSpecStage(opts?: { model?: string; maxTurns?: number }): PipelineStage[] {
  return [
    {
      name: STAGE.TECH_SPEC,
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      copyBack: false,
      resumePrevious: false,
      // Research over a whole codebase needs more turns than implementation; 15 silently starved
      // large tickets (hit maxTurns mid-research, no <tech_spec> emitted). Overridable via --max-turns.
      maxTurns: opts?.maxTurns ?? 30,
      // Research over a large monorepo can end "incomplete" with the whole exploration still in the
      // session but nothing emitted — the run then throws and every turn of research is discarded.
      // Resuming the SAME session costs one nudge and turns that sunk cost into a spec.
      resumeUntilComplete: 2,
      resumeNudge: SPEC_RESUME_NUDGE,
      systemPrompt: techSpecSystemPrompt(),
      promptTemplate: [
        'Task: {{TITLE}}',
        '',
        '{{DESCRIPTION}}',
        '',
        'Existing discussion on the ticket:',
        '{{COMMENTS}}',
        '',
        retrospectiveMemoryBlock(),
        '',
        'Research the existing codebase read-only (do not edit any files). Produce a technical specification for this task.',
        '',
        // Observed on data-controls-engine#2489: the model announced "I'll continue the research",
        // then ended its turn on a thinking-only message having emitted nothing — 25 turns discarded.
        'Never end a turn without either calling a tool or emitting output. If you are running low on',
        'room, stop exploring and write the spec from what you have, marking anything unverified as a risk.',
        '',
        'The spec MUST include:',
        '- **Problem** — what exactly needs to be solved and why',
        '- **Architecture** — components, interfaces, data flows, and integration points',
        '- **Acceptance Criteria** — precise, testable conditions for done',
        '- **Tests** — what test cases and scenarios must be covered',
        '- **Risks** — known unknowns, edge cases, and failure modes',
        '- **Performance / Scalability** — throughput, latency, and growth considerations',
        '',
        'Wrap the complete specification in <tech_spec>...</tech_spec>.',
        '',
        'Immediately after it, emit a machine-checkable manifest of the obligations above, wrapped in',
        '<spec_manifest>{...}</spec_manifest> as JSON matching this shape (omit an array entirely if empty):',
        '{"files":[{"path":"src/foo.ts","required":true}],',
        '"tests":[{"id":"T1","file":"src/foo.test.ts","required":true}],',
        '"acceptance":[{"id":"AC-1","description":"...","artifact":"path/to/pre-change/artifact","required":true}],',
        '"dependencies":[{"consumer":"src/consumer.ts","producer":"src/producer.ts"}]}',
        'List every file the implementation must touch, every test id with the file it belongs in, every',
        'acceptance criterion (with an `artifact` path when the AC defines a pre-change file such as a golden',
        'baseline that must exist before any code change), and any producer/consumer pairs where shipping the',
        'consumer without the producer would be a silent semantic change rather than a partial delivery.',
        '',
        'When done, write <promise>COMPLETE</promise>.',
      ].join('\n'),
    },
  ];
}
