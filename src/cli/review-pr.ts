import { githubDefaultBranch, defaultGhRunner } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import { overlayInstructionFiles } from '../context/instruction-files.js';
import type { InstructionOverlay } from '../context/instruction-files.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { agentAuthFromEnv, authSecrets } from '../agents/auth.js';
import { selectAgents } from '../agents/registry.js';
import { prepareContext, runAgent, disposeContext } from '../core/vanguard.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import { baseBranchOrDefault } from '../core/base-branch.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { adversarySystemPrompt } from '../pipeline/pipeline.js';
import { buildPullRequestReviewPrompt, PullRequestReviewIncompleteError, reviewPullRequest } from '../runners/pr-review.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import type { SummaryOutcome } from '../core/run-summary.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type { PullRequestForReview, PullRequestReviewAttempt, PullRequestReviewOutcome, PullRequestReviewer, ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';
import { DEFAULT_REVIEW_MAX_TURNS } from './args.js';
import type { Command } from './args.js';

type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;
type ReviewPullRequestRunner = (ref: string, deps: ReviewPullRequestDeps) => Promise<ReviewPullRequestResult>;

export interface ReviewPrCommandDeps {
  gh?: GhRunner;
  reviewer?: PullRequestReviewer;
  reviewPullRequest?: ReviewPullRequestRunner;
  log?: (line: string) => void;
}

/** Review an existing GitHub PR and post a non-blocking GitHub review comment. */
export async function reviewPrCommand(cmd: ReviewPrCommand, deps: ReviewPrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewPullRequest ?? reviewPullRequest;
  const toFile = cmd.out !== undefined;

  // On Actions each review leaves one block in the job's Summary tab (no GITHUB_STEP_SUMMARY ⇒ no-op).
  // The default reviewer records its agent calls here; an injected one records nothing.
  const outcomes: SummaryOutcome[] = [];
  const stepSummary = (taskId: string, exit: StepSummaryExit, extra: Pick<StepSummary, 'prUrl' | 'verdict' | 'risk' | 'error'> = {}): Promise<void> => {
    const model = outcomes.at(-1)?.result.model ?? cmd.reviewModel;
    return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
      taskId,
      flow: 'pr-review',
      provider: cmd.provider ?? 'claude',
      ...(model !== undefined ? { model } : {}),
      outcomes,
      exit,
      ...extra,
    });
  };

  // --out routes the review to a local file and suppresses the PR comment — a no-trace review for
  // client repos (nothing is posted to the tracker). Default posts the comment, as before.
  const deliver = async (result: ReviewPullRequestResult): Promise<void> => {
    await stepSummary(`${result.pr.repoSlug}#${result.pr.number}`, 'completed', {
      prUrl: result.pr.url,
      ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
      ...(result.risk !== undefined ? { risk: result.risk } : {}),
    });
    if (cmd.out !== undefined) {
      await mkdir(dirname(cmd.out), { recursive: true });
      await writeFile(cmd.out, result.commentBody, 'utf8');
      log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: written to ${resolve(cmd.out)} (no PR comment)`);
      return;
    }
    log(`review-pr ${result.pr.repoSlug}#${result.pr.number}: done`);
  };

  const runAndDeliver = async (reviewer: PullRequestReviewer): Promise<void> => {
    try {
      await deliver(
        await runReview(cmd.prRef, {
          reviewer,
          ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
          log,
          publish: !toFile,
          ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
        }),
      );
    } catch (error) {
      const pr = error instanceof PullRequestReviewIncompleteError ? error.pr : undefined;
      await stepSummary(pr !== undefined ? `${pr.repoSlug}#${pr.number}` : cmd.prRef, 'error', { error: String(error) });
      // --out callers still get the incomplete notice on disk; the rethrow keeps the exit code truthful.
      if (cmd.out !== undefined && error instanceof PullRequestReviewIncompleteError) {
        await mkdir(dirname(cmd.out), { recursive: true });
        await writeFile(cmd.out, error.commentBody, 'utf8');
        log(`review-pr ${error.pr.repoSlug}#${error.pr.number}: incomplete notice written to ${resolve(cmd.out)} (no PR comment)`);
      }
      throw error;
    }
  };

  if (deps.reviewer !== undefined) {
    await runAndDeliver(deps.reviewer);
    return;
  }

  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  const sandboxContext = await startSandboxContext({
    egress: cmd.egress,
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });
  try {
    await runAndDeliver((pr, opts) => runDefaultReviewer(pr, cmd, auth, sandboxContext, opts, outcomes, deps.gh ?? defaultGhRunner));
  } finally {
    await sandboxContext.destroy();
  }
}

async function runDefaultReviewer(
  pr: PullRequestForReview,
  cmd: ReviewPrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
  opts: PullRequestReviewAttempt,
  outcomes: SummaryOutcome[],
  gh: GhRunner,
): Promise<PullRequestReviewOutcome> {
  const agents = selectAgents(cmd, process.env, { proxyMode: sandboxContext.llmProxy !== undefined });

  // Per-run provider sidecars (e.g. OpenAI for Codex) hold the real key out of the sandbox. Created
  // before prepareContext so the finally below tears them down even if context provisioning throws.
  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(sandboxContext.proxyUrl, sandboxContext.llmProxy, providerProxies.openai);
    const sandbox = new DockerSandboxProvider({
      image: sandboxImage(),
      secrets: {
        ...(sandboxContext.llmProxy === undefined && auth !== undefined && agents.injectAnthropicAuth ? authSecrets(auth) : {}),
        ...agents.secrets,
      },
      ...sandboxResourceLimits(),
      ...(env !== undefined ? { env } : {}),
      ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
    });
    const taskId = `pr-review-${pr.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${pr.number}`;
    // The reviewer reads the tree the change lands on: the PR's base as origin has it.
    const baseBranch = baseBranchOrDefault(pr.baseRefName, `PR ${pr.repoSlug}#${pr.number}`);
    const instructionRef = await githubDefaultBranch(pr.repoSlug, gh);
    let overlay: InstructionOverlay | undefined;
    const ctx = await prepareContext({ taskId, localRepoPath: cmd.repoPath, sandbox, agentName: agents.agent.name, baseBranch, start: 'base' }, {
      // Load repo skills after the trusted default-branch instructions have been overlaid.
      skills: (worktreePath) => skillRegistryForRun(cmd.skillsDir, worktreePath),
      ...(instructionRef !== baseBranch ? { seedWorktree: async (worktreePath: string) => {
        overlay = await overlayInstructionFiles({ repoPath: cmd.repoPath, worktreePath, ref: instructionRef });
      } } : {}),
    });
    const baseTurns = cmd.maxTurns ?? DEFAULT_REVIEW_MAX_TURNS;
    try {
      const result = await runAgent(ctx, {
        stageName: 'pr-review',
        agent: agents.agent,
        ...literalPrompt(buildPullRequestReviewPrompt(pr, { retryTriage: opts.isRetry, ...(overlay !== undefined ? { instructions: overlay } : {}) })),
        systemPrompt: adversarySystemPrompt(),
        effort: opts.isRetry ? 'xhigh' : 'high',
        maxTurns: opts.isRetry ? Math.min(Math.ceil(baseTurns * 1.5), Number.MAX_SAFE_INTEGER) : baseTurns,
        copyBack: false,
        ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}),
      });
      outcomes.push({ name: opts.isRetry ? 'pr-review-retry' : 'pr-review', result, ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}) });
      return { text: result.finalText, completed: result.completed };
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
