import { clearStageMarker, writeStageMarker } from '../core/run-stage-marker.js';
import { reviewVerdictLine, reviewVerdictOf } from '../pipeline/review-verdict.js';
import { trustedSpecText, isTrustedComment } from '../tasks/comment-trust.js';
import { readFile } from 'node:fs/promises';
import { taskToVariables } from '../tasks/fetcher.js';
import { escapePromptTags } from '../context/escape.js';
import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { selectAgents, forcedProviderModel, providerKeyEnvNames } from '../agents/registry.js';
import { DEFAULT_BASE_BRANCH } from '../core/base-branch.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { probeTaskDifficulty, decisionProbeConfig } from '../core/decision-probe.js';
import { decisionModelConfig, decisionEgressAllowed, decisionModelMissing, DECISION_MODEL_DEFAULT, type DecisionModelConfig } from '../core/decision-model.js';
import { VanguardError } from '../core/errors.js';
import { decisionDiffScorer } from '../evals/decision-judge.js';
import { runStages, assembleReviewPipeline, withPrimaryFallback, sandboxComplete, withStageMaxTurns, withStageResumeUntilComplete, STAGE } from '../pipeline/pipeline.js';
import { FLOWS } from '../api/capabilities.js';
import { resolveRepoFlow, unknownFlowError } from '../flows/repo.js';
import { buildReviewerAttribution } from '../pipeline/review-publish.js';
import { authSecrets } from '../agents/auth.js';
import { beginRun, persistDecisionProbe } from '../core/run-store.js';
import type { SecretBlock } from '../core/secret-scan.js';
import { summarizeOutcomes } from '../core/run-summary.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import { loadRetrospectiveMemory, refreshRetrospectiveMemory } from '../core/retrospective-memory.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback, proofBlock, verifySkippedBlock } from '../pipeline/verify.js';
import { resolveAndRunVisualProof, visualProofBlock } from '../pipeline/visual-proof.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { reviewRequestBody } from './review-body.js';
import { repairUntilGreen } from '../pipeline/repair-gate.js';
import { deliverChange, conventionalPrTitle } from './deliver-change.js';
import {
  parseSpecManifest,
  primaryModuleScope,
  checkConformance,
  renderConformanceFeedback,
  commitLeakWarningBlock,
  PASSING_RESULT,
} from '../pipeline/conformance-gate.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { ConformanceResult } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
import type { Task } from '../tasks/fetcher.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, CustomProviderEntry } from '../agents/registry.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';
import type { RunEvent } from '../pipeline/events.js';
import { skillRegistryForRun } from '../context/skill-registry.js';

/** Agent-pipeline options shared by the `run` and `watch` commands, threaded verbatim into the *Deps. */
export interface RunOptions extends ProviderChoice {
  providerModel?: string;
  reviewModel?: string;
  /** Model for the implementer fallback provider (ProviderChoice.fallbackProvider); undefined = its default. */
  fallbackModel?: string;
  /** Model for gate repairs after the first failed one; undefined = keep the implementer model. */
  escalateModel?: string;
  /** How --fork variants are scored; 'decision' needs decision-model credentials (fails fast without). */
  forkScorer?: 'llm' | 'decision';
  noSimplify?: boolean;
  verifyCmd?: string;
  visualProofCmd?: string;
  /** When true, run the conformance stage (opt-in; default off). */
  conformance?: boolean;
  /** Model override for the conformance stage (e.g. 'opus'). */
  conformanceModel?: string;
  /** Git author for the commit (default: `Vanguard <vanguard@local>`). Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /**
   * When true, run a dedicated planning stage first (opus, high effort) before implement/review — the
   * plan-implement-review pipeline — instead of the source's default implement-first stages. Set via --plan.
   */
  plan?: boolean;
  /**
   * Named flow key (a `FLOWS` registry entry, e.g. 'flow-b'). Set via `--flow`. `--plan` is the
   * back-compat alias for `flow: 'plan'`. When set, `FLOWS[flow].build()` supplies the base stages
   * instead of the adapter's — EXCEPT `'default'`, which means "the adapter's own stages" (an adapter
   * may customize them; Linear does). Validated at the CLI/sidecar boundary.
   */
  flow?: string;
  /** Base branch to branch off and target the PR at (default: `main`). Set via --base. */
  baseBranch?: string;
  /**
   * Override the implementer stage's turn cap (default: 30; base/fast stays 12). Opt-in, higher
   * token cost — lets one run finish a deliberately large, multi-file task. Set via --max-turns.
   */
  maxTurns?: number;
  /**
   * Override the conformance/verify repair loop-back cap (default: 2). Opt-in — gives the
   * manifest-driven loop-back more passes on large tasks. Set via --max-repair-iterations.
   */
  maxRepairIterations?: number;
  /**
   * Local spec file injected as a virtual issue comment: the implementer prompt ({{COMMENTS}}),
   * triage, and the conformance manifest read it exactly like a posted spec, but nothing is written
   * to the tracker. Pairs with `vanguard spec --out` for a no-trace client-repo flow. Set via --spec-file.
   */
  specFile?: string;
  feedbackAuthors?: string[];
  /**
   * Skills directory injected into the sandbox (Vanguard's bundled `skills/` in the factory), merged
   * with the target repo's own `.github/vanguard-skills/`. Set via --skills.
   */
  skillsDir?: string;
}

/**
 * Extract the shared RunOptions fields from a `run` or `watch` command (or any compatible shape).
 *
 * Booleans (`noSimplify`, `conformance`) are copied on `!== undefined`, relying on the parse-time
 * invariant that the CLI only ever emits `true` or omits them. A future caller passing an explicit
 * `false` will therefore propagate it — a conscious choice, not a dropped flag.
 */
export function pickRunOptions(cmd: Readonly<Partial<RunOptions>>): RunOptions {
  return {
    ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    ...(cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
    ...(cmd.fallbackProvider !== undefined ? { fallbackProvider: cmd.fallbackProvider } : {}),
    ...(cmd.fallbackModel !== undefined ? { fallbackModel: cmd.fallbackModel } : {}),
    // Loaded repo customs must survive this copy or selectAgents sees a bare name (S6).
    ...(cmd.customProviders !== undefined ? { customProviders: cmd.customProviders } : {}),
    ...(cmd.providerModel !== undefined ? { providerModel: cmd.providerModel } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.escalateModel !== undefined ? { escalateModel: cmd.escalateModel } : {}),
    ...(cmd.forkScorer !== undefined ? { forkScorer: cmd.forkScorer } : {}),
    ...(cmd.noSimplify !== undefined ? { noSimplify: cmd.noSimplify } : {}),
    ...(cmd.verifyCmd !== undefined ? { verifyCmd: cmd.verifyCmd } : {}),
    ...(cmd.visualProofCmd !== undefined ? { visualProofCmd: cmd.visualProofCmd } : {}),
    ...(cmd.conformance !== undefined ? { conformance: cmd.conformance } : {}),
    ...(cmd.conformanceModel !== undefined ? { conformanceModel: cmd.conformanceModel } : {}),
    ...(cmd.commitAuthor !== undefined ? { commitAuthor: cmd.commitAuthor } : {}),
    ...(cmd.plan !== undefined ? { plan: cmd.plan } : {}),
    ...(cmd.flow !== undefined ? { flow: cmd.flow } : {}),
    ...(cmd.baseBranch !== undefined ? { baseBranch: cmd.baseBranch } : {}),
    ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
    ...(cmd.maxRepairIterations !== undefined ? { maxRepairIterations: cmd.maxRepairIterations } : {}),
    ...(cmd.specFile !== undefined ? { specFile: cmd.specFile } : {}),
    ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
  };
}

/** Shared dependencies for all source-backed issue runners. */
export interface RunIssueDeps extends RunOptions {
  auth?: AgentAuth;
  repoPath: string;
  proxyUrl?: string;
  network?: string;
  llmProxy?: LlmProxyDep;
  reuse?: boolean;
  /** Keep a local base that is ahead of/diverged from origin (default: outside CI only). See resolveRemoteBaseRef. */
  keepLocalIfAhead?: boolean;
  forkN?: number;
  reviewGate?: boolean;
  /** When set, receives structured run events. Absent ⇒ no events (CLI path). Threaded to runStages + run-start/run-end. */
  onEvent?: (e: RunEvent) => void;
  /** When set, aborts the run — the sandbox is torn down via the caller's finally. Threaded into runStages. */
  signal?: AbortSignal;
}

/** Semantic kind of a proof failure; adapters map it to a platform label string. */
export type ProofFailureKind = 'verify' | 'visual-proof';

/** Input to the per-source publishVerdict hook (platform-neutral subset of PublishReviewVerdictInput). */
export interface PublishVerdictInput {
  /** Full PR or MR URL returned by publishForReview. */
  prUrl: string;
  /** The commit SHA — also the dedupe marker embedded in the comment. */
  headSha: string;
  /** The 'reviewer' StageOutcome. Missing → hard error (no-silence guarantee). */
  reviewerOutcome?: StageOutcome | undefined;
  /** The 'conformance' StageOutcome. Optional; when present appends a ## Conformance section. */
  conformanceOutcome?: StageOutcome | undefined;
  /** Attribution string e.g. "codex" or "claude/sonnet". */
  attribution: string;
  /** When true, blocking (high/critical) findings gate the PR/MR. */
  gate?: boolean;
}

/** Per-source seam: fetch/prepare, extra secrets, id derivation, stage set, extra variables, PR link-back. */
export interface SourceAdapter {
  /** Fetch the task. Runs on the host. */
  prepare(issueRef: string): Promise<{ task: Task }>;
  /** Extra sandbox secrets merged in before agent secrets (e.g. LINEAR_API_KEY). */
  secrets?: Record<string, string>;
  /** Derive the worktree/task id from the fetched task. */
  taskId(task: Task): string;
  /** Base pipeline stages (canonical, or implementer-swapped for Linear). */
  stages(): PipelineStage[];
  /** Extra prompt variables (e.g. ISSUE for Linear). */
  variables?(issueRef: string, task: Task): Record<string, string>;
  /** Whether the review body should include source-control auto-close syntax for this task id. */
  closeIssueOnMerge?: boolean;
  /** CLI used to open the draft PR/MR for review. Default 'gh'. GitLab supplies 'glab'. */
  reviewCli?: 'gh' | 'glab';
  /** Post the reviewer verdict (+ optional conformance section) onto the opened PR/MR. */
  publishVerdict(input: PublishVerdictInput): Promise<void>;
  /** Add a proof-failure label to the opened PR/MR (best-effort; must never throw). */
  addFailureLabel(prUrl: string, kind: ProofFailureKind): Promise<void>;
  /**
   * Surface a secret-scan block on the source issue (label + masked comment). Best-effort: must
   * never throw (mirrors addFailureLabel). Called for BOTH the findings block and the scan-error
   * precautionary block.
   */
  signalSecretBlock(issueRef: string, task: Task, block: SecretBlock): Promise<void>;
  /** Write the PR link back onto the source issue. */
  linkPr(issueRef: string, task: Task, prUrl: string): Promise<void>;
}

/** Shared result shape for all source-backed issue runners. */
export interface RunIssueResult {
  task: Task;
  /** Absent when the agent produced no changes (no PR opened). */
  prUrl?: string;
  /** True when a PR was withheld because the secret scan flagged the outgoing diff — NOT "no changes". */
  secretBlocked?: boolean;
}

/** Cap on implement-session resumes triggered by a failing conformance/verify gate, before falling back to a declared-partial PR. */
const MAX_REPAIR_ITERATIONS = 2;

/** Read the local --spec-file eagerly with a clear error — an ENOENT deep inside a run is not actionable. */
async function readSpecFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`--spec-file: cannot read ${path}: ${String(cause)}`);
  }
}

/**
 * White-label branch id: the trailing issue number (e.g. `gh-…-904` → `904`), else a
 * Conventional-Branch-safe slug of the taskId. Used for `feat/<id>-<hash>` branches in white-label mode.
 */
function branchIdFromTaskId(taskId: string): string {
  const trailingNumber = /(\d+)$/.exec(taskId)?.[1];
  if (trailingNumber !== undefined) return trailingNumber;
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug === '' ? 'task' : slug;
}

/** Issue label that pins the implementer-tier model for ONE task: `vanguard:model=<model>`. */
export const MODEL_LABEL_PREFIX = 'vanguard:model=';

/**
 * Model ids/aliases/slugs as every supported provider spells them (`opus`, `claude-sonnet-5`,
 * `anthropic/claude-sonnet-4.6`, `gpt-5.6-sol`, `glm-5.2`). Labels are a lower-trust input than a CLI
 * flag — anyone with triage permission can set one — so the value is allowlisted by shape before it
 * becomes a `--model` argument, even though the arg is shell-quoted downstream.
 */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * Per-task model override from the issue's labels. A human judging "this one is hard" beats any
 * pre-run heuristic, so the label wins over the fleet-wide --provider-model. Last well-formed
 * matching label wins; an empty or malformed value is ignored (and reported via `onInvalid`).
 */
export function modelFromLabels(labels: ReadonlyArray<string>, onInvalid?: (label: string) => void): string | undefined {
  let model: string | undefined;
  for (const label of labels) {
    if (!label.startsWith(MODEL_LABEL_PREFIX)) continue;
    const value = label.slice(MODEL_LABEL_PREFIX.length).trim();
    if (value === '') continue;
    if (!MODEL_NAME_RE.test(value)) {
      onInvalid?.(label);
      continue;
    }
    model = value;
  }
  return model;
}

/**
 * Conventional-Commits-safe commit message for white-label mode: `<type>(<scope>)?: <lower-case
 * subject> (#<issue>)` with a header ≤100 chars. Reuses `conventionalPrTitle` so a title that already
 * carries a type (e.g. `refactor(hub): …`) keeps it instead of getting a second `feat: ` prefix.
 * Lower-casing the whole subject is the reliable way to pass commitlint's `subject-case` (never
 * sentence/start/pascal/upper-case); the trailing `#<n>` satisfies task-number rules.
 */
export function conventionalCommitMessage(title: string, taskId: string, opts: { bugLabel?: boolean } = {}): string {
  const prefixed = conventionalPrTitle(title, opts);
  const suffix = ` (#${branchIdFromTaskId(taskId)})`;
  const subject = prefixed.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
  const room = 100 - suffix.length;
  const clipped = subject.length > room ? subject.slice(0, room).trimEnd() : subject;
  return `${clipped}${suffix}`;
}

/**
 * Resolve a flow name to its base stage array. 'default' (and no flow at all) means "this
 * adapter's own stages", NOT FLOWS.default.build. They are not the same: the Linear adapter's
 * stages() swaps in an implementer that reads the issue via the linear-cli skill, while
 * FLOWS.default.build is the generic implementReviewSimplifyStages. Selecting 'default' by name —
 * the natural thing for a name-driven UI — must not silently downgrade a Linear run to an
 * implementer that never reads the issue. Non-built-in names resolve from the repo's
 * `.vanguard/flows/*.hcl` (S5); unknown names throw listing both sets.
 */
async function resolveBaseStages(
  flow: string | undefined,
  repoPath: string,
  adapter: SourceAdapter,
  customProviders?: readonly CustomProviderEntry[],
): Promise<PipelineStage[]> {
  if (flow === undefined || flow === 'default') return adapter.stages();
  if (Object.hasOwn(FLOWS, flow)) return FLOWS[flow]!.build();
  const stages = await resolveRepoFlow(flow, repoPath, customProviders);
  if (stages === undefined) throw await unknownFlowError(flow, repoPath);
  return stages;
}

/**
 * Credentials and consent for `--fork-scorer decision`. Checked by the CLI before anything runs and
 * again here as a backstop. A white-label run ships the CLIENT's diff to the decision model, so it
 * needs the same explicit consent as the difficulty probe (VANGUARD_DECISION_PROBE=all).
 */
export function resolveForkScorerConfig(whiteLabel: boolean, env: NodeJS.ProcessEnv = process.env): DecisionModelConfig {
  if (!decisionEgressAllowed(whiteLabel, env)) {
    throw new VanguardError(
      '--fork-scorer decision on a white-label run (--commit-author) sends the client diff to the decision model; set VANGUARD_DECISION_PROBE=all to allow that.',
    );
  }
  const config = decisionModelConfig(env);
  if (config === undefined) {
    throw new VanguardError(`--fork-scorer decision: ${decisionModelMissing(env['VANGUARD_DECISION_MODEL'] ?? DECISION_MODEL_DEFAULT, env)}`);
  }
  return config;
}

/** Shared pipeline body for GitHub and Linear issue runners, parameterised by a SourceAdapter. */
export async function runSourcedIssue(
  issueRef: string,
  deps: RunIssueDeps,
  adapter: SourceAdapter,
): Promise<RunIssueResult> {
  // Named-flow dispatch, resolved FIRST: a flow typo must fail before the tracker fetch, the
  // provider proxies, and the sandbox spin-up (the CLI mirror of the sidecar fail-fast, S5 D6).
  // `--flow <name>` selects a FLOWS builder or a repo `.vanguard/flows/*.hcl` flow; `--plan` is
  // the back-compat alias for flow 'plan'.
  const flow = deps.flow ?? (deps.plan === true ? 'plan' : undefined);
  const baseStages = await resolveBaseStages(flow, deps.repoPath, adapter, deps.customProviders);

  // Every source gets the same skills: the --skills dir plus the repo's own .github/vanguard-skills/.
  const [{ task: fetchedTask }, skills] = await Promise.all([adapter.prepare(issueRef), skillRegistryForRun(deps.skillsDir, deps.repoPath)]);
  // --spec-file: layer the local spec onto the fetched task as a virtual comment — the implementer
  // prompt ({{COMMENTS}}), triage, and the conformance manifest read it exactly like a posted spec,
  // with nothing written to the tracker. Copy, don't mutate: the fetched object may be shared.
  const task =
    deps.specFile === undefined
      ? fetchedTask
      : {
          ...fetchedTask,
          comments: [...fetchedTask.comments, { author: 'spec-file', authorAssociation: 'OWNER', body: await readSpecFile(deps.specFile) }],
        };

  // White-label mode (triggered by --commit-author): the PR is delivered as a plain, human-looking PR.
  // Branch becomes `feat/<issue-number>-<hash>`, the "by Vanguard" attribution and the Vanguard review
  // comment / issue link-back are suppressed. Off by default — everything stays branded as Vanguard.
  const whiteLabel = deps.commitAuthor !== undefined;

  const agents = selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: sandboxImage(),
      // In llm-proxy mode the real Claude secret stays in the sidecar — the sandbox gets only the nonce.
      secrets: {
        ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth ? authSecrets(deps.auth) : {}),
        ...(adapter.secrets ?? {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(deps.network !== undefined ? { network: deps.network } : {}),
    });

    // A decision-model fork scorer needs credentials; resolve them BEFORE the sandbox is built so a
    // missing key fails in a second, not after a full implementer run.
    const forkScore =
      deps.forkN !== undefined && deps.forkScorer === 'decision' ? decisionDiffScorer(resolveForkScorerConfig(whiteLabel), deps.signal !== undefined ? { signal: deps.signal } : {}) : undefined;
    const retrospectiveMemory = await loadRetrospectiveMemory(deps.repoPath);
    // Log-only difficulty probe (decision model, opt-in via env): kicked off here so its round trip
    // hides under sandbox + worktree provisioning; awaited once the pipeline is assembled. Recorded
    // next to the run so stats can later tell whether it predicts repairs/escalation. Never routes.
    const labelModel = modelFromLabels(task.labels, (label) =>
      console.warn(`vanguard: ${task.id} ignoring malformed model label ${JSON.stringify(label)}`),
    );
    const probePromise = probeTaskDifficulty(task, labelModel ?? deps.providerModel, {
      config: decisionProbeConfig(process.env, { whiteLabel }),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const ctx = await prepareContext(
      {
        taskId: adapter.taskId(task),
        localRepoPath: deps.repoPath,
        sandbox,
        agentName: agents.agent.name,
        ...(agents.reviewAgent !== undefined ? { reviewAgentName: agents.reviewAgent.name } : {}),
        ...(agents.fallbackAgent !== undefined ? { fallbackAgentName: agents.fallbackAgent.name } : {}),
        // Cut from origin's copy of the base when it is ahead of the local one (on Actions the checkout is
        // the event SHA and main may already have moved), so the sandbox, verification and review see the
        // tree the PR will land on (#423). A reused branch keeps its own history.
        baseBranch: deps.baseBranch ?? DEFAULT_BASE_BRANCH,
        start: deps.reuse === true ? 'reuse' : 'base',
        ...(deps.keepLocalIfAhead !== undefined ? { keepLocalIfAhead: deps.keepLocalIfAhead } : {}),
        ...(whiteLabel ? { branchPrefix: 'feat/', branchId: branchIdFromTaskId(adapter.taskId(task)) } : {}),
      },
      { skills },
    );
    let outcomes: StageOutcome[] = [];
    // On Actions each run leaves one block in the job's Summary tab, built from the same outcomes as
    // the run record + metrics.jsonl so the two never disagree. No GITHUB_STEP_SUMMARY ⇒ no-op.
    const stepSummary = (exit: StepSummaryExit, extra: Pick<StepSummary, 'prUrl' | 'error'> = {}): Promise<void> => {
      const model = outcomes.find((o) => o.name === STAGE.IMPLEMENTER)?.result.model ?? labelModel ?? deps.providerModel;
      return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: task.id,
        flow: flow ?? 'default',
        provider: agents.agent.name,
        ...(model !== undefined ? { model } : {}),
        outcomes,
        exit,
        ...extra,
      });
    };
    let markerWrites = Promise.resolve();
    try {
      const turnScoped = deps.maxTurns !== undefined ? withStageMaxTurns(baseStages, deps.maxTurns) : baseStages;
      // --max-repair-iterations also drives auto-resume of an incomplete implementer (not just the gate
      // loop): an under-budget stage that stopped without <promise>COMPLETE</promise> gets nudged to finish.
      const scopedStages =
        deps.maxRepairIterations !== undefined
          ? withStageResumeUntilComplete(turnScoped, deps.maxRepairIterations)
          : turnScoped;
      const providerForcedModel = forcedProviderModel(deps.provider ?? 'claude', deps.customProviders);
      if (labelModel !== undefined) {
        console.log(`vanguard: ${task.id} pins the implementer model to ${labelModel} via label (overrides --provider-model)`);
      }
      let pipeline = assembleReviewPipeline(scopedStages, agents, {
        ...deps,
        ...(labelModel !== undefined ? { providerModel: labelModel } : {}),
        ...(providerForcedModel !== undefined ? { providerForcedModel } : {}),
      });
      // Implementer fallback: on an AgentError from the primary provider (outage, usage limit, revoked
      // credential) runStages retries the stage once on this provider — same as the reviewer's fallback.
      // Every stage on the primary gets it (simplifier, planner…): the provider that failed the
      // implementer fails them too, and a rescued implementer whose simplifier dies still loses the PR.
      if (agents.fallbackAgent !== undefined) {
        pipeline = withPrimaryFallback(
          pipeline,
          { provider: agents.fallbackAgent, ...(deps.fallbackModel !== undefined ? { model: deps.fallbackModel } : {}) },
        );
      }
      const probe = await probePromise;
      if (probe !== undefined && deps.signal?.aborted !== true) {
        await persistDecisionProbe(deps.repoPath, adapter.taskId(task), probe).catch(() => undefined);
        console.log(
          `vanguard: ${task.id} difficulty probe (${probe.model}, ${probe.latencyMs}ms): first-try ${probe.completesFirstTry.toFixed(2)}, difficulty ${probe.difficulty.toFixed(2)}/4, spec clear ${probe.specClear.toFixed(2)}`,
        );
      }
      // A conformance stage's narrative rides on the reviewer verdict comment (publishReviewVerdict
      // appends it as a `## Conformance` section). `--conformance` appends the stage to ANY flow, so on
      // a reviewer-less one (flow-b: adversary+repairer) it would run, cost money, and publish nothing.
      // Fail at assembly rather than surface nothing the user explicitly asked for. Giving conformance
      // its own standalone comment would need its own body format + dedupe marker; this error is that TODO.
      if (pipeline.some((s) => s.name === STAGE.CONFORMANCE) && !pipeline.some((s) => s.name === STAGE.REVIEWER)) {
        throw new Error(
          `--conformance needs a flow with a reviewer stage (its verdict rides on the review comment); flow "${flow ?? 'default'}" has none`,
        );
      }
      const runMeta = { flow: flow ?? 'default', provider: agents.agent.name };
      // One RunWriter for the whole run: it owns the timestamp, so proof.json, visual-proof.json and
      // every stage record share one prefix and the hub/desktop readers can match a run's proof to
      // its stage records by name.
      const writer = beginRun(deps.repoPath, adapter.taskId(task), undefined, { secretEnvVars: providerKeyEnvNames(deps) });
      const onEvent = (event: RunEvent): void => {
        markerWrites = markerWrites.then(async () => {
          if (event.type === 'stage-start') {
            await writeStageMarker(deps.repoPath, {
              taskId: adapter.taskId(task), stage: event.name, index: event.index, of: event.of,
              updatedAt: new Date().toISOString(),
            });
          } else if (event.type === 'run-end' || event.type === 'run-error' || event.type === 'run-cancelled') {
            await clearStageMarker(deps.repoPath, adapter.taskId(task));
          }
        }).catch(() => undefined);
        deps.onEvent?.(event);
      };
      onEvent({
        type: 'run-start',
        taskId: adapter.taskId(task),
        ...runMeta,
        stages: pipeline.map((s) => s.name),
      });
      outcomes = await runStages(ctx, pipeline, {
        agent: agents.agent,
        variables: {
          ...taskToVariables(task, { allowedAuthors: deps.feedbackAuthors }),
          ...(adapter.variables?.(issueRef, task) ?? {}),
          RETROSPECTIVE_MEMORY: escapePromptTags(retrospectiveMemory),
        },
        ...(deps.forkN !== undefined
          ? { fork: { n: deps.forkN, complete: sandboxComplete(ctx, agents.agent), ...(forkScore !== undefined ? { score: forkScore } : {}) } }
          : {}),
        onEvent,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      // Deterministic spec-manifest vs diff conformance gate, joined with the verify command into a
      // single shared-cap repair loop: either gate failing resumes the implementer's own session with
      // a combined gap report (bounded, budget/turn caps already apply to the resumed stage) —
      // "iterate the implement loop", not "open PR and hope". Exhausting the cap (or having no
      // resumable session) falls through to a declared-partial PR (reviewRequestBody below), never a
      // silent `Closes` with either gate red.
      const trust = { allowedAuthors: deps.feedbackAuthors, issueAuthor: task.author };
      const specText = trustedSpecText(task, trust);
      const manifest = parseSpecManifest(specText);
      // A *parseable* manifest only: prose that merely names the tag must not downgrade delivery.
      const untrustedManifestDropped = manifest === undefined && task.comments.some(
        (c) => !isTrustedComment(c, trust) && parseSpecManifest(c.body) !== undefined,
      );
      if (untrustedManifestDropped) console.log(`vanguard: ${task.id} ignoring <spec_manifest> from untrusted comment author(s) — declaring partial scope (Part of)`);
      const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});

      // The implementer's position in `outcomes` is fixed while its session is resumable (repairUntilGreen
      // merges each repair into that entry in place).
      const implementerIdx = outcomes.findIndex((o) => o.name === STAGE.IMPLEMENTER);
      let conformance: ConformanceResult = PASSING_RESULT;
      let verification: VerificationResult | undefined;
      let implementerDone = false;
      let gatePassed = false;
      // try/finally so the per-stage cost table is printed even when a repair call throws or the run
      // is cancelled mid-loop — and, on the happy path, after the loop so repairs show up in it.
      try {
        const fallbackHolder = agents.fallbackAgent !== undefined && outcomes[implementerIdx]?.providerName === agents.fallbackAgent.name ? agents.fallbackAgent : undefined;
        const onFallback = fallbackHolder !== undefined;
        const repair = await repairUntilGreen(ctx, {
          label: task.id,
          gate: async () => {
            // Only touch the worktree diff when there is a manifest to check against — a legacy/no-manifest
            // spec skips the conformance half of the gate entirely.
            conformance = manifest !== undefined ? checkConformance(manifest, await ctx.wm.diff(ctx.worktreePath)) : PASSING_RESULT;
            verification = verifyCmd !== undefined ? await runVerification(ctx.sandbox, verifyCmd) : undefined;
            // Completion is part of the gate (dogfood #352): an implementer that hit its turn cap or timeout
            // mid-task can leave residue that still typechecks and tests green. Gate on `completed`, NOT on
            // exitReason === 'maxTurns': the SDK counts internal steps as turns while vanguard counts real
            // ones. A provider that finishes but never emits <promise>COMPLETE</promise> is re-nudged and,
            // if it still won't signal, downgraded to a Part-of PR — an unverifiable "done" must not
            // auto-close the issue.
            implementerDone = implementerIdx === -1 || outcomes[implementerIdx]?.result.completed === true;
            const pass = conformance.pass && (verification === undefined || verification.passed) && implementerDone;
            const feedback = [
              !implementerDone
                ? 'The previous session ended before the task was finished (turn cap or timeout). Continue and complete the remaining work.'
                : undefined,
              !conformance.pass ? renderConformanceFeedback(conformance) : undefined,
              verification !== undefined && !verification.passed ? renderVerificationFeedback(verification) : undefined,
            ].filter((part): part is string => part !== undefined).join('\n\n');
            return { pass, feedback };
          },
          // Resume on the provider that actually ran the stage: after a fallback the session belongs to it.
          agent: fallbackHolder ?? agents.agent,
          outcomes,
          pipeline,
          // NOTE: with an explicit --max-repair-iterations N, an incomplete implementer can be resumed up
          // to ~2N times total — N in-stage (resumeUntilComplete inside runStages) plus N here.
          maxIterations: deps.maxRepairIterations ?? MAX_REPAIR_ITERATIONS,
          // --escalate-model names a model of the implementer's provider; handed to the fallback CLI it is
          // an AgentError, so the fallback repairs on its own model only.
          ...(deps.escalateModel !== undefined && !onFallback ? { escalateModel: deps.escalateModel } : {}),
          // A per-task label is the human's own escalation call; the fleet-wide --escalate-model does not
          // override it (it could even downgrade).
          modelPinned: labelModel !== undefined,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        });
        gatePassed = repair.passed;
      } finally {
        console.log(summarizeOutcomes(outcomes));
      }
      console.log(`vanguard: gate ${gatePassed ? 'PASSED' : 'FAILED — declaring partial scope'} for ${task.id}`);

      const visualProof = await resolveAndRunVisualProof(
        ctx.sandbox,
        ctx.worktreePath,
        deps.visualProofCmd !== undefined ? { cmd: deps.visualProofCmd } : {},
      );

      await Promise.all([
        verification !== undefined ? writer.writeProof(verification) : undefined,
        visualProof !== undefined ? writer.writeVisualProof(visualProof) : undefined,
      ]);

      // Verification participates in the Closes/Part-of decision alongside conformance: a red result
      // forces the declared-partial path even when conformance itself passed.
      const verificationFailed = verification !== undefined && !verification.passed;
      const visualProofFailed = visualProof !== undefined && !visualProof.passed;
      const partial = !gatePassed || untrustedManifestDropped;
      const baseBody = reviewRequestBody(task.id, {
        closeIssueOnMerge: !!adapter.closeIssueOnMerge,
        ...(untrustedManifestDropped ? { untrustedManifest: true } : {}),
        ...(manifest !== undefined ? { conformance, manifest } : {}),
        ...(verificationFailed ? { verificationFailed: true } : {}),
        ...(!implementerDone ? { implementerIncomplete: true } : {}),
        ...(whiteLabel ? { hideAttribution: true } : {}),
      });
      // deliverChange owns the order: secret scan → commit → closing-keyword scan → rebase/push → PR.
      // The body is built after the commit so a partial result can carry commit-level `Closes #N`
      // leaks as a blocking warning. White-label mode keeps the body to just the Closes/Part-of line —
      // no automated proof-of-work blocks — so the PR reads like a plain human PR.
      const scope = primaryModuleScope(manifest);
      const bugLabel = task.labels.includes('bug');
      const reviewerOutcome = outcomes.find((o) => o.name === STAGE.REVIEWER);
      const delivery = await deliverChange(ctx, {
        taskId: task.id,
        // Default and white-label share the same type/scope logic as the PR title (conventionalPrTitle):
        // no second prefix when the title already has one, `fix:` for a `bug` label, `feat:` otherwise.
        // White-label additionally lower-cases the subject and caps the header at 100 chars so a target
        // repo's commitlint passes.
        commitMessage: whiteLabel
          ? conventionalCommitMessage(task.title, adapter.taskId(task), { bugLabel })
          : `${conventionalPrTitle(task.title, { bugLabel, ...(scope !== undefined ? { scope } : {}) })} (${task.id})`,
        ...(deps.commitAuthor !== undefined ? { commitAuthor: deps.commitAuthor } : {}),
        ...(partial ? { closingKeywordScan: true } : {}),
        // A custom provider's key env var is repo-configured: the secret gate cannot know its name.
        secretEnvVars: providerKeyEnvNames(deps),
        target: {
          kind: 'new-pr',
          title: `${task.title} (${task.id})`,
          bugLabel,
          ...(scope !== undefined ? { scope } : {}),
          // Ready for review only after verification and every configured proof passed.
          draft: partial || verifyCmd === undefined || visualProofFailed,
          ...(adapter.reviewCli !== undefined ? { cli: adapter.reviewCli } : {}),
          // Same PAT revise pushes with: a PR it opens fires the repo's pull_request workflows (CI).
          ...(process.env.VANGUARD_PUSH_TOKEN ? { prToken: process.env.VANGUARD_PUSH_TOKEN } : {}),
          body: ({ commitLeaks }) => whiteLabel
            ? baseBody
            : [
                baseBody,
                commitLeaks.length > 0 ? commitLeakWarningBlock(commitLeaks) : undefined,
                verification !== undefined ? proofBlock(verification) : verifySkippedBlock(),
                visualProof !== undefined ? visualProofBlock(visualProof) : undefined,
                reviewerOutcome !== undefined ? reviewVerdictLine(reviewVerdictOf(reviewerOutcome.result.finalText)) : undefined,
              ].filter((s): s is string => s !== undefined).join('\n\n'),
        },
      });
      if (delivery.kind === 'secret-blocked') {
        // The blocked diff holds the secret the scan caught: keep it (and the bundle) off disk.
        await writer.writeStages(outcomes, { ...runMeta, omitDiff: true });
        await stepSummary('secret-blocked');
        // White-label runs keep the automation invisible in the client repo: no secret-blocked label,
        // no branded comment. The operator still gets the masked findings on stderr + run record.
        if (!whiteLabel) await adapter.signalSecretBlock(issueRef, task, delivery.block);
        onEvent({ type: 'run-end', secretBlocked: true });
        return { task, secretBlocked: true };
      }
      if (delivery.kind === 'no-changes') {
        await writer.writeStages(outcomes, runMeta);
        await stepSummary('no-changes');
        onEvent({ type: 'run-end' });
        return { task };
      }
      if (delivery.kind !== 'delivered-pr') throw new VanguardError(`unexpected delivery outcome ${delivery.kind} for a new-pr target`);
      const pr = { prUrl: delivery.prUrl, headSha: delivery.headSha };
      // White-label mode delivers a plain PR: no Vanguard review comment and no issue link-back comment.
      // A flow without a `reviewer` stage (e.g. flow-b: adversary+repairer) has no verdict to surface,
      // so skip the verdict comment entirely. The no-silence guarantee still fires for reviewer-bearing
      // flows: publishReviewVerdict throws if a `reviewer` stage ran but produced no outcome. (A
      // conformance stage can only reach here alongside a reviewer — the assembly check above rejects
      // conformance on a reviewer-less flow — so this skip can never swallow a conformance narrative.)
      const pipelineHasReviewer = pipeline.some((s) => s.name === STAGE.REVIEWER);
      if (!whiteLabel && pipelineHasReviewer) {
        const conformanceOutcome = outcomes.find((o) => o.name === STAGE.CONFORMANCE);
        await adapter.publishVerdict({
          prUrl: pr.prUrl,
          // The pre-push rebase may have rewritten the commit; the marker names the pushed head.
          headSha: pr.headSha,
          reviewerOutcome,
          conformanceOutcome,
          attribution: buildReviewerAttribution(reviewerOutcome, agents.agent.name),
          ...(deps.reviewGate === true ? { gate: true } : {}),
        });
      }
      await writer.writeStages(outcomes, { ...runMeta, prUrl: pr.prUrl });
      await stepSummary(verificationFailed ? 'verify-failed' : 'completed', { prUrl: pr.prUrl });
      if (verification !== undefined && !verification.passed) await adapter.addFailureLabel(pr.prUrl, 'verify');
      if (visualProofFailed) await adapter.addFailureLabel(pr.prUrl, 'visual-proof');
      if (!whiteLabel) await adapter.linkPr(issueRef, task, pr.prUrl);
      onEvent({ type: 'run-end', prUrl: pr.prUrl });
      return { task, prUrl: pr.prUrl };
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      throw error;
    } finally {
      await refreshRetrospectiveMemory(deps.repoPath).catch((err: unknown) => {
        console.error('retrospective memory refresh failed (non-fatal):', err);
      });
      await markerWrites;
      await clearStageMarker(deps.repoPath, adapter.taskId(task)).catch(() => undefined);
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
