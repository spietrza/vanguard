import { gitlabDefaultBranch, defaultGlabRunner } from '../tasks/gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import { overlayInstructionFiles } from '../context/instruction-files.js';
import type { InstructionOverlay } from '../context/instruction-files.js';
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
import { buildMergeRequestReviewPrompt, reviewMergeRequest } from '../runners/mr-review.js';
import type { SandboxContext } from '../sandbox/sandbox-context.js';
import type { AgentAuth } from '../agents/auth.js';
import type {
  MergeRequestForReview,
  MergeRequestReviewAttempt,
  MergeRequestReviewOutcome,
  MergeRequestReviewer,
  ReviewMergeRequestDeps,
  ReviewMergeRequestResult,
} from '../runners/mr-review.js';
import { DEFAULT_REVIEW_MAX_TURNS } from './args.js';
import type { Command } from './args.js';

type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;
type ReviewMergeRequestRunner = (ref: string, deps: ReviewMergeRequestDeps) => Promise<ReviewMergeRequestResult>;

export interface ReviewMrCommandDeps {
  glab?: GlabRunner;
  reviewer?: MergeRequestReviewer;
  reviewMergeRequest?: ReviewMergeRequestRunner;
  log?: (line: string) => void;
  /** See ReviewMergeRequestDeps.headDedupe. */
  headDedupe?: boolean;
}

/** Review an existing GitLab MR and post a non-blocking Vanguard review note. */
export async function reviewMrCommand(cmd: ReviewMrCommand, deps: ReviewMrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runReview = deps.reviewMergeRequest ?? reviewMergeRequest;
  const headDedupe = deps.headDedupe !== undefined ? { headDedupe: deps.headDedupe } : {};
  if (deps.reviewer !== undefined) {
    const result = await runReview(String(cmd.iid), { reviewer: deps.reviewer, project: cmd.project, ...(deps.glab !== undefined ? { glab: deps.glab } : {}), log, ...headDedupe });
    logDone(result, log);
    return;
  }

  const auth = agentAuthFromEnv(cmd.provider !== undefined ? { provider: cmd.provider } : {});
  // Started on the first reviewer call, so an already-reviewed head never starts a sandbox, and shared by
  // the incomplete-retry so it does not rebuild the egress network and llm-proxy sidecar. The promise is
  // cached, not the context, so overlapping attempts could never start a second one. A failed start fails
  // the first attempt, and a thrown attempt ends the review (only an incomplete one is retried), so a
  // cached rejection is never awaited by a retry.
  let sandboxContext: Promise<SandboxContext> | undefined;
  const reviewer: MergeRequestReviewer = async (mr, opts) => {
    sandboxContext ??= startSandboxContext({
      egress: cmd.egress,
      llmProxy: cmd.llmProxy === true,
      ...(auth !== undefined ? { auth } : {}),
      ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
    });
    return await runDefaultMrReviewer(mr, cmd, auth, await sandboxContext, opts, deps.glab ?? defaultGlabRunner);
  };
  try {
    const result = await runReview(String(cmd.iid), { reviewer, project: cmd.project, ...(deps.glab !== undefined ? { glab: deps.glab } : {}), log, ...headDedupe });
    logDone(result, log);
  } finally {
    const started = await sandboxContext?.catch(() => undefined);
    await started?.destroy();
  }
}

/** A skipped head already logged "already reviewed -> skip"; "done" would read as a fresh review. */
function logDone(result: ReviewMergeRequestResult, log: (line: string) => void): void {
  if (result.commentBody !== undefined) log(`review-mr ${result.mr.project}!${result.mr.iid}: done`);
}

async function runDefaultMrReviewer(
  mr: MergeRequestForReview,
  cmd: ReviewMrCommand,
  auth: AgentAuth | undefined,
  sandboxContext: SandboxContext,
  opts: MergeRequestReviewAttempt,
  glab: GlabRunner,
): Promise<MergeRequestReviewOutcome> {
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
    const taskId = `mr-review-${mr.project.replace(/[^a-zA-Z0-9]/g, '-')}-${mr.iid}`;
    // The reviewer reads the tree the change lands on: the MR's target branch as origin has it.
    const baseBranch = baseBranchOrDefault(mr.targetBranch, `MR ${mr.project}!${mr.iid}`);
    const instructionRef = await gitlabDefaultBranch(mr.project, glab);
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
        stageName: 'mr-review',
        agent: agents.agent,
        ...literalPrompt(buildMergeRequestReviewPrompt(mr, { retryTriage: opts.isRetry, ...(overlay !== undefined ? { instructions: overlay } : {}) })),
        systemPrompt: adversarySystemPrompt(),
        effort: opts.isRetry ? 'xhigh' : 'high',
        maxTurns: opts.isRetry ? Math.min(Math.ceil(baseTurns * 1.5), Number.MAX_SAFE_INTEGER) : baseTurns,
        copyBack: false,
        ...(cmd.reviewModel !== undefined ? { model: cmd.reviewModel } : {}),
      });
      return { text: result.finalText, completed: result.completed };
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
