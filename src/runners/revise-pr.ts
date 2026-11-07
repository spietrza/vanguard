import { describeIgnoredAuthor } from '../tasks/comment-trust.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parsePullRequestRef, fetchPullRequestForReview, postPullRequestReview, commentPullRequest } from './pr-review.js';
import {
  fetchPullRequestFeedback,
  partitionActionableFeedback,
  buildRevisionPrompt,
  replyAndResolveThread,
  countRevisionRoundsFromFeedback,
  revisionMarker,
  buildItemReply,
  buildRevisionSummary,
  buildRevisionDryRun,
  parseRevisionDiff,
  formatFileChanges,
  describeItemChange,
  guardedPoint,
} from './pr-feedback.js';
import type { FeedbackItem } from './pr-feedback.js';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import type { RunContext } from '../core/vanguard.js';
import { baseBranchOrDefault } from '../core/base-branch.js';
import { literalPrompt } from '../context/prompt-engine.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import { resolveVerifyCommand, runVerification, renderVerificationFeedback } from '../pipeline/verify.js';
import { reviewRequestBody } from './review-body.js';
import { repairUntilGreen } from '../pipeline/repair-gate.js';
import { beginRun } from '../core/run-store.js';
import { appendStepSummary } from '../core/step-summary.js';
import type { StepSummary, StepSummaryExit } from '../core/step-summary.js';
import type { StageOutcome } from '../pipeline/pipeline.js';
import { GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { deliverChange, scanOutgoingForSecrets } from './deliver-change.js';
import { extractTaskIdFromPrBody, scanCommitClosingKeywords } from '../pipeline/conformance-gate.js';
import type { VerificationResult } from '../pipeline/verify.js';
import {
  implementReviewSimplifyStages,
  runStages,
  withStageProvider,
  withStageModel,
  withStageModelExcept,
  withStageFallback,
  STAGE,
} from '../pipeline/pipeline.js';
import { droppedCiPathsNote } from '../pipeline/remote-branch.js';
import { defaultGhRunner } from '../tasks/github.js';
import { DockerSandboxProvider, sandboxImage } from '../sandbox/docker.js';
import { sandboxResourceLimits } from '../sandbox/limits.js';
import { llmProxySandboxEnv } from '../sandbox/egress-proxy.js';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { authSecrets } from '../agents/auth.js';
import { selectAgents, providerKeyEnvNames } from '../agents/registry.js';
import { GITHUB_REVIEW_LABEL } from '../github-labels.js';
import { WorktreeManager } from '../worktree/manager.js';
import { VanguardError } from '../core/errors.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestForReview } from './pr-review.js';
import type { CommandRunner } from '../pipeline/remote-branch.js';
import type { LlmProxyDep } from '../sandbox/llm-proxy.js';
import type { AgentAuth } from '../agents/auth.js';
import type { ProviderChoice, SelectedAgents } from '../agents/registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';
import type { AgentProvider } from '../agents/provider.js';

const NEEDS_REVISION_LABEL = 'needs revision';
const VANGUARD_REVISING_LABEL = 'vanguard:revising';
const DEFAULT_MAX_ROUNDS = 2;
// secret-blocked is removed too: a round that pushes cleanly after the human stripped the secret must
// not leave the PR mapped to verify-failed on the board.
const HAND_BACK_LABELS = { remove: [NEEDS_REVISION_LABEL, VANGUARD_REVISING_LABEL, GITHUB_SECRET_BLOCKED_LABEL], add: [GITHUB_REVIEW_LABEL] };

/** Cap on implement-session resumes triggered by a red verification in the revise pass — one bounded repair. */
const MAX_VERIFY_REPAIRS = 1;

export interface ReviseGithubPrDeps extends ProviderChoice {
  feedbackAuthors?: string[];
  auth?: AgentAuth;
  repoPath: string;
  repoSlug?: string;
  gh?: GhRunner;
  /** LLM-proxy sidecar wiring (from startSandboxContext when --llm-proxy is active). */
  llmProxy?: LlmProxyDep;
  /** Egress proxy URL for the sandbox (from startSandboxContext when --egress is active). */
  proxyUrl?: string;
  /** Docker network for the sandbox (from startSandboxContext). */
  network?: string;
  /** Model for the implementer/simplifier stages. */
  providerModel?: string;
  /** Model for the review stage. */
  reviewModel?: string;
  /** Git author for the revision commits + white-label toggle: drops the "vanguard" token from the revision marker so a client repo carries no automation branding. Set via --commit-author. */
  commitAuthor?: { name: string; email: string };
  /** Dry-run: write the diff + proposed thread replies to this local file and push/comment NOTHING. Set via --out. */
  out?: string;
  /** Skip the simplifier stage. */
  noSimplify?: boolean;
  /** Maximum revision rounds before capping (default 2). */
  maxRounds?: number;
  /** Explicit verification command (else auto-detected from the worktree). */
  verifyCmd?: string;
  /** --skills dir, merged with the repo's .github/vanguard-skills/ (read from repoPath, not the PR head). */
  skillsDir?: string;
  /** Extra logins to treat as bots (beyond the built-in heuristic). */
  botLogins?: string[];
  log?: (line: string) => void;
  /** Cancels an in-flight repair resume (observed when the current agent exec ends). */
  signal?: AbortSignal;
  // Test hooks
  /** Injected sandbox provider (avoids Docker in unit tests). */
  _sandbox?: IsolatedSandboxProvider;
  /** Injected agent provider (avoids real provider CLIs and credential checks in unit tests). */
  _agent?: AgentProvider;
  /** Injected WorktreeManager (avoids requiring a real git remote in unit tests). */
  _worktrees?: WorktreeManager;
  /** Injected CommandRunner for git push (pushToExistingBranch). */
  _pushRunner?: CommandRunner;
  /**
   * Start the worktree from this branch (a 'base' start that keeps a local copy that is ahead) instead
   * of fetching the PR head. Use in tests, on a repo without an origin, to point at a local branch.
   */
  _baseBranch?: string;
}

export interface ReviseGithubPrResult {
  ignoredFeedback?: Array<{ author: string; association: string }>;
  pr: PullRequestForReview;
  /** Number of feedback items addressed this round (threads replied+resolved, non-thread items commented on). */
  addressed: number;
  committed: boolean;
  pushed: boolean;
  undrafted: boolean;
  /** Absolute path of the dry-run preview file, when --out was given (push/comment were skipped). */
  dryRunOut?: string;
  /** The revision diff carried a secret (or the scan failed): nothing was committed or pushed; `addressed` counts the items abandoned. */
  secretBlocked?: boolean;
}

function editPrLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<string> {
  const args = ['pr', 'edit', String(number), '--repo', repoSlug];
  for (const label of labels.remove ?? []) args.push('--remove-label', label);
  for (const label of labels.add ?? []) args.push('--add-label', label);
  return gh(args);
}

async function handBackPrLabels(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  log: (line: string) => void,
): Promise<void> {
  try {
    await gh(['label', 'create', GITHUB_REVIEW_LABEL, '--repo', repoSlug, '--force']);
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: label ensure -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }

  try {
    log(`revise-pr ${repoSlug}#${number}: labels -> needs-human-review`);
    await editPrLabels(gh, repoSlug, number, HAND_BACK_LABELS);
  } catch (err) {
    log(`revise-pr ${repoSlug}#${number}: labels -> manual label check (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Un-draft the PR. With a pushToken, try `pr ready` as the token's owner first (GH_TOKEN for this one
 * call): a `ready_for_review` event from the ambient GITHUB_TOKEN starts no workflows, so the review
 * workflow's label-factory-pr job never fires on the final commit (#557). Refused (e.g. no Pull
 * requests: write) → retry with the ambient credential so the PR still leaves draft.
 */
async function markReady(
  gh: GhRunner,
  repoSlug: string,
  number: number,
  pushToken: string | undefined,
  log: (line: string) => void,
): Promise<void> {
  const args = ['pr', 'ready', String(number), '--repo', repoSlug];
  if (pushToken) {
    try {
      await gh(args, { GH_TOKEN: pushToken });
      return;
    } catch {
      log(`revise-pr ${repoSlug}#${number}: pr ready with VANGUARD_PUSH_TOKEN failed, retrying with the ambient credential`);
    }
  }
  await gh(args);
}

/**
 * Run one PR revision round: read human review feedback, apply fixes on the existing PR branch,
 * reply to and resolve addressed threads, un-draft the PR, and flip the labels.
 */
export async function runRevisePullRequest(prRef: string, deps: ReviseGithubPrDeps): Promise<ReviseGithubPrResult> {
  const gh = deps.gh ?? defaultGhRunner;
  const log = deps.log ?? console.log;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const target = parsePullRequestRef(prRef, deps.repoSlug);
  log(`revise-pr ${target.repoSlug}#${target.number}: fetch -> pr & feedback`);
  const [pr, fb] = await Promise.all([
    fetchPullRequestForReview(target, gh),
    fetchPullRequestFeedback(target, gh, log),
  ]);

  // --out: a dry run that touches NEITHER the branch NOR the PR — the preview goes to the operator's
  // file and the absolute path comes back for `dryRunOut`.
  const writeDryRun = async (out: string, preview: string): Promise<string> => {
    const path = resolve(out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, preview, 'utf8');
    log(`revise-pr ${target.repoSlug}#${target.number}: dry-run -> ${path} (nothing pushed or commented)`);
    return path;
  };

  const { actionable, ignoredAuthors } = partitionActionableFeedback(fb, {
    feedbackAuthors: deps.feedbackAuthors,
    headRefOid: pr.headRefOid,
    ...(deps.botLogins !== undefined ? { botLogins: deps.botLogins } : {}),
  });

  const ignoredFeedback = [...new Map(ignoredAuthors.map((item) => [
    `${item.author} ${item.authorAssociation}`,
    { author: item.author, association: item.authorAssociation },
  ])).values()];
  const notes = ignoredFeedback.map(({ author, association }) =>
    `revise-pr ${target.repoSlug}#${target.number}: ignored feedback from ${describeIgnoredAuthor(author, association)}`);
  for (const note of notes) log(note);

  /**
   * Explain on the PR why no revision was applied and hand the routing labels back to a human, so the
   * PR never sits in `vanguard:revising` with no trace. Notices stay unbranded: a white-label run must
   * not name the automation (or its flags) in a client repo.
   */
  const handBackWithNotice = async (reason: string, message: string): Promise<void> => {
    log(`revise-pr ${target.repoSlug}#${target.number}: ${reason}, posting notice`);
    await postPullRequestReview(target, message, 'comment', gh);
    await handBackPrLabels(gh, target.repoSlug, target.number, log);
  };

  if (actionable.length === 0) {
    if (notes.length > 0) {
      // Everything this round was gated out on author trust — hand it back exactly as the round cap
      // does. --out is a dry-run that touches NEITHER the branch NOR the PR, so it only logs.
      if (deps.out === undefined) {
        await handBackWithNotice('all feedback untrusted', [
          'No automated revision was applied: every review comment in this round came from an author whose feedback is not trusted for automated revisions.',
          '',
          ...ignoredFeedback.map(({ author, association }) => `- ${describeIgnoredAuthor(author, association)}`),
          '',
          'Trusted feedback comes from a repository OWNER, MEMBER or COLLABORATOR, or from an explicitly allowed login.',
        ].join('\n'));
      }
      await appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: `${target.repoSlug}#${target.number}`, flow: 'revise-pr', provider: deps.provider ?? 'unknown',
        exit: 'no-changes', outcomes: [], notes,
      });
    }
    log(`revise-pr ${target.repoSlug}#${target.number}: no actionable feedback — skipping`);
    return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  const rounds = countRevisionRoundsFromFeedback(fb, deps);
  if (rounds >= maxRounds) {
    await handBackWithNotice(`cap -> ${rounds} rounds`,
      `Revision cap reached (${rounds}/${maxRounds} rounds). No further automated revisions will be applied.`);
    return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  if (pr.isCrossRepository) {
    // A fork PR's head branch is not on origin: fetching refs/heads/<headRefName> there (resolveStartRef
    // in vanguard.ts) would silently land on a same-named base-repo branch instead, and the push below
    // would land on it too. Refuse before any fetch, worktree or push — there is no safe revise path
    // for a fork head. Placed after the early returns above so a re-run with nothing actionable left,
    // or one past the round cap, stays as quiet here as it is for a same-repo PR.
    const notice = `Cannot revise: this PR's head branch is on ${pr.headRepositoryOwner !== '' ? `${pr.headRepositoryOwner}'s fork` : 'a fork'}, not ${target.repoSlug}. Automated revision only pushes to branches in this repository — please revise manually.`;
    log(`revise-pr ${target.repoSlug}#${target.number}: cross-repo -> cannot revise`);
    if (deps.out !== undefined) {
      // --out was asked for a file: write the refusal there too, so the operator never gets a silent
      // "no changes" with no preview.
      const dryRunOut = await writeDryRun(deps.out, `# Revision dry run: ${target.repoSlug}#${target.number}\n\n${notice}\n`);
      return { pr, addressed: 0, committed: false, pushed: false, undrafted: false, dryRunOut };
    }
    await postPullRequestReview(target, notice, 'comment', gh);
    await handBackPrLabels(gh, target.repoSlug, target.number, log);
    return { pr, addressed: 0, committed: false, pushed: false, undrafted: false };
  }

  const agents: SelectedAgents =
    deps._agent !== undefined
      ? {
          agent: deps._agent,
          secrets: {},
          proxySecrets: {},
          injectAnthropicAuth: true,
        }
      : selectAgents(deps, process.env, { proxyMode: deps.llmProxy !== undefined });

  const providerProxies = await startProviderProxies({
    proxySecrets: agents.proxySecrets,
    ...(deps.network !== undefined ? { network: deps.network } : {}),
  });
  try {
    const env = llmProxySandboxEnv(deps.proxyUrl, deps.llmProxy, providerProxies.openai);
    const sandbox =
      deps._sandbox ??
      new DockerSandboxProvider({
        image: sandboxImage(),
        secrets: {
          ...(deps.llmProxy === undefined && deps.auth !== undefined && agents.injectAnthropicAuth
            ? authSecrets(deps.auth)
            : {}),
          ...agents.secrets,
        },
        ...sandboxResourceLimits(),
        ...(env !== undefined ? { env } : {}),
        ...(deps.network !== undefined ? { network: deps.network } : {}),
      });

    const taskId = `revise-pr-${target.repoSlug.replace(/[^a-zA-Z0-9]/g, '-')}-${target.number}`;
    // One RunWriter for the whole revision round, shared by the two (mutually exclusive) writeStages
    // calls below, for consistency with runSourcedIssue's writer.
    const writer = beginRun(deps.repoPath, taskId, undefined, { secretEnvVars: providerKeyEnvNames(deps) });
    const revisionStageMeta = { flow: 'revise', provider: agents.agent.name };
    let outcomes: StageOutcome[] = [];
    // One block per revision in the Actions job's Summary tab (no GITHUB_STEP_SUMMARY ⇒ no-op).
    const stepSummary = (exit: StepSummaryExit, extra: Pick<StepSummary, 'error'> = {}): Promise<void> => {
      const model = outcomes.find((o) => o.name === STAGE.IMPLEMENTER)?.result.model ?? deps.providerModel;
      return appendStepSummary(process.env.GITHUB_STEP_SUMMARY, {
        taskId: `${target.repoSlug}#${target.number}`,
        flow: 'revise-pr',
        provider: agents.agent.name,
        ...(model !== undefined ? { model } : {}),
        outcomes,
        notes,
        exit,
        prUrl: pr.url,
        ...extra,
      });
    };

    // Starting the worktree can fail before there is a context to dispose: gh reported no head ref or
    // no head sha, or the head moved between `gh pr view` and the fetch (resolveStartRef pins the PR's
    // own sha, so a moved head is refused rather than revised). Report it and hand the labels back like
    // every other giving-up path, instead of leaving the PR in `vanguard:revising` with no comment.
    let ctx: RunContext;
    try {
      if (deps._baseBranch === undefined && (pr.headRefName === '' || pr.headRefOid === '')) {
        throw new VanguardError(`PR ${target.repoSlug}#${target.number} has no head ref to fetch`);
      }
      ctx = await prepareContext(
        {
          taskId,
          localRepoPath: deps.repoPath,
          sandbox,
          agentName: agents.agent.name,
          // The worktree starts from the PR head as fetched from origin, not the base (see prepareContext
          // for the same-repo caveat). Tests point it at a local branch instead, which has no origin.
          ...(deps._baseBranch !== undefined
            ? { baseBranch: deps._baseBranch, start: 'base' as const, keepLocalIfAhead: true }
            : {
                baseBranch: baseBranchOrDefault(pr.baseRefName, `PR ${target.repoSlug}#${target.number}`),
                start: { prHead: pr.headRefName, headRefOid: pr.headRefOid },
              }),
        },
        { skills: await skillRegistryForRun(deps.skillsDir, deps.repoPath), ...(deps._worktrees !== undefined ? { worktrees: deps._worktrees } : {}) },
      );
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      // --out is a dry run that touches neither the branch nor the PR.
      if (deps.out === undefined) {
        const notice = `Cannot revise: could not start from this PR's head branch (\`${pr.headRefName}\` at \`${pr.headRefOid}\`) — it may have moved while this run was reading the PR. Re-label \`${NEEDS_REVISION_LABEL}\` to try again.`;
        await postPullRequestReview(target, notice, 'comment', gh).catch(() => undefined);
        await handBackPrLabels(gh, target.repoSlug, target.number, log);
      }
      throw error;
    }
    try {
      const allStages = implementReviewSimplifyStages();
      const base = deps.noSimplify === true ? allStages.filter((s) => s.name !== STAGE.SIMPLIFIER) : allStages;
      let pipeline = agents.reviewAgent !== undefined ? withStageProvider(base, agents.reviewAgent) : base;
      if (deps.providerModel !== undefined) {
        const crossProviderReview =
          deps.reviewProvider !== undefined && deps.reviewProvider !== (deps.provider ?? 'claude');
        pipeline = crossProviderReview
          ? withStageModelExcept(pipeline, deps.providerModel, STAGE.REVIEWER)
          : withStageModel(pipeline, deps.providerModel);
      }
      if (deps.reviewModel !== undefined) pipeline = withStageModel(pipeline, deps.reviewModel, STAGE.REVIEWER);
      if (agents.reviewAgent !== undefined) {
        pipeline = withStageFallback(pipeline, {
          provider: agents.agent,
          ...(deps.providerModel !== undefined ? { model: deps.providerModel } : {}),
        });
      }

      // Override the implementer's promptTemplate with the revision prompt. It holds review comments and
      // the diff, so it goes in as a variable and is never expanded as a template (see literalPrompt).
      const { promptTemplate, variables } = literalPrompt(buildRevisionPrompt(pr, actionable));
      pipeline = pipeline.map((stage) =>
        stage.name === STAGE.IMPLEMENTER ? { ...stage, promptTemplate } : stage,
      );

      log(`revise-pr ${target.repoSlug}#${target.number}: agent -> implementing`);
      outcomes = await runStages(ctx, pipeline, { agent: agents.agent, variables });

      // Run the resolved verification command after applying changes and before pushing, with one
      // bounded repair iteration on red — reusing renderVerificationFeedback and the same resume
      // pattern as runSourcedIssue so a red revision never silently ships (alpha-window#901: 5
      // NameError tests pushed through revise). Auto-detect only touches the worktree, no manifest.
      const verifyCmd = await resolveVerifyCommand(ctx.worktreePath, deps.verifyCmd !== undefined ? { cmd: deps.verifyCmd } : {});
      // Same repair gate as the first delivery (shared caps, cost accounting, cancel): a red revision
      // never silently ships (alpha-window#901: 5 NameError tests pushed through revise).
      let verification: VerificationResult | undefined;
      if (verifyCmd !== undefined) {
        const cmd = verifyCmd;
        await repairUntilGreen(ctx, {
          label: `${target.repoSlug}#${target.number}`,
          gate: async () => {
            verification = await runVerification(ctx.sandbox, cmd);
            return { pass: verification.passed, feedback: verification.passed ? '' : renderVerificationFeedback(verification) };
          },
          agent: agents.agent,
          outcomes,
          pipeline,
          maxIterations: MAX_VERIFY_REPAIRS,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          log,
        });
      }
      const verificationFailed = verification !== undefined && !verification.passed;

      // Capture round diff BEFORE commit — post-commit git diff HEAD is empty. A git failure here must
      // not lose the cost trace the persist below exists for: record the outcomes and rethrow.
      let revisionDiff: string;
      // The gate scans the attribute-proof rendering; revisionDiff stays the stored/previewed diff.
      let gateDiff: string;
      try {
        revisionDiff = await ctx.wm.diff(ctx.worktreePath);
        gateDiff = await ctx.wm.outgoingDiff(ctx.worktreePath);
      } catch (err) {
        // Nothing is known about the content on this path (the scan never ran): keep the payloads off disk.
        await writer.writeStages(outcomes, { ...revisionStageMeta, omitDiff: true });
        throw err;
      }
      const whiteLabel = deps.commitAuthor !== undefined;

      // Same gate as the first delivery (runSourcedIssue): a secret in the agent's diff must never reach
      // a commit, the PR branch, or the --out preview a human will read and share. A scan error blocks
      // too. The block is made visible the same way: masked comment on the PR (not in white-label mode)
      // and the routing labels handed back, so the PR does not sit in `vanguard:revising`. Residual gaps,
      // shared with the first delivery: scanForSecrets skips `*.test.ts` / `tests/**` (isTestPath).
      // A custom provider's key env var is repo-configured: the secret gate cannot know its name.
      const secretEnvVars = providerKeyEnvNames(deps);
      const block = scanOutgoingForSecrets(gateDiff, `${target.repoSlug}#${target.number}`, 'revise push', secretEnvVars);
      // Repair cost merged into the implementer outcome by the gate reaches `vanguard stats` only if
      // the outcomes are persisted — the first delivery does this in runSourcedIssue. Persisted after
      // the scan so a blocked round leaves no `.diff` / `.bundle` on disk (the diff holds the secret).
      await writer.writeStages(outcomes, {
        ...revisionStageMeta,
        ...(block !== undefined ? { omitDiff: true } : {}),
      });
      if (block !== undefined) {
        // --out is a dry-run that touches NEITHER the branch NOR the PR: report the block on stderr only,
        // write no preview (it would carry the raw secret), and leave the labels alone.
        if (deps.out === undefined) {
          await handBackPrLabels(gh, target.repoSlug, target.number, log);
          // White-label runs keep the automation invisible in the client repo: no branded comment and no
          // secret-blocked label (same rule as the first delivery); the hand-back label is the one the
          // revise loop already relies on.
          if (!whiteLabel) {
            const notice = [
              renderSecretBlockComment(block, 'revision'),
              'Remove the secret from the revision and re-label `needs revision`.',
              droppedCiPathsNote(ctx.droppedCiPaths),
            ].filter((part) => part !== '').join('\n\n');
            await commentPullRequest(target, notice, gh).catch(() => undefined);
            // Same marker as the first delivery, so the board maps it to verify-failed, not to a clean hand-back.
            await gh(['label', 'create', GITHUB_SECRET_BLOCKED_LABEL, '--repo', target.repoSlug, '--force']).catch(() => undefined);
            await gh(['pr', 'edit', String(target.number), '--repo', target.repoSlug, '--add-label', GITHUB_SECRET_BLOCKED_LABEL]).catch(() => undefined);
          }
        }
        await stepSummary('secret-blocked');
        return { pr, ignoredFeedback, addressed: actionable.length, committed: false, pushed: false, undrafted: false, secretBlocked: true };
      }

      // Diff-true "what changed" point per feedback item — uses the diff, not a commit sha, so the
      // dry-run below can build proposed replies without committing.
      const diffFiles = parseRevisionDiff(revisionDiff);
      const globalPoint = formatFileChanges(diffFiles, 3, 3);
      const pointFor = (item: FeedbackItem): string =>
        guardedPoint(describeItemChange(item, diffFiles) || globalPoint, revisionDiff);

      // --out: dry-run. Write the diff + the reply we would post to each addressed item to a local file.
      // The operator reviews it, then re-runs without --out to apply. No commit / push / comment here.
      if (deps.out !== undefined) {
        const status = verification === undefined ? 'unknown' : verification.passed ? 'pass' : 'fail';
        const preview = buildRevisionDryRun({
          repoSlug: target.repoSlug,
          number: target.number,
          headRefName: pr.headRefName,
          diff: revisionDiff,
          items: actionable.map((item) => ({ item, point: pointFor(item) })),
          verification: { typecheck: status, test: status },
        });
        const dryRunOut = await writeDryRun(deps.out, preview);
        await stepSummary(verificationFailed ? 'verify-failed' : 'completed');
        return { pr, ignoredFeedback, addressed: actionable.length, committed: false, pushed: false, undrafted: false, dryRunOut };
      }

      log(`revise-pr ${target.repoSlug}#${target.number}: commit -> staging`);
      const pushToken = process.env.VANGUARD_PUSH_TOKEN;
      // deliverChange owns the order: secret scan on the revision diff → commit → push onto the PR branch.
      const delivery = await deliverChange(ctx, {
        taskId: `${target.repoSlug}#${target.number}`,
        commitMessage: `fix: address review feedback (${target.repoSlug}#${target.number})`,
        ...(deps.commitAuthor !== undefined ? { commitAuthor: deps.commitAuthor } : {}),
        secretEnvVars,
        target: {
          kind: 'existing-branch',
          prHeadRef: pr.headRefName,
          ...(pushToken ? { pushToken, host: 'github.com' } : {}),
          ...(deps._pushRunner !== undefined ? { runner: deps._pushRunner } : {}),
        },
      });
      if (delivery.kind === 'secret-blocked') {
        // The gate above scanned the same worktree before the --out branch and handled the block
        // (comment, labels). Reaching here means the worktree changed in between — fail loudly rather
        // than strand the PR silently.
        throw new VanguardError(`revise-pr ${target.repoSlug}#${target.number}: secret found at delivery after a clean pre-scan`);
      }
      if (delivery.kind === 'no-changes') {
        log(`revise-pr ${target.repoSlug}#${target.number}: no changes — skipping push`);
        await stepSummary('no-changes');
        return { pr, ignoredFeedback, addressed: 0, committed: false, pushed: false, undrafted: false };
      }
      if (delivery.kind !== 'delivered-push') throw new VanguardError(`unexpected delivery outcome ${delivery.kind} for an existing-branch target`);
      log(`revise-pr ${target.repoSlug}#${target.number}: pushed -> ${pr.headRefName}${pushToken ? ' (VANGUARD_PUSH_TOKEN)' : ''}`);
      const sha = delivery.sha;

      // Re-derive the PR body from the CURRENT diff on every cycle so a stale `Closes #N` can never
      // survive a revision that regressed (alpha-window#901 kept a stale Closes through two review
      // requests). The referenced issue is recovered from the existing body; a red verification
      // forces the `Part of #N` path, and a commit-level closing keyword is downgraded to `Part of`.
      const issueTaskId = extractTaskIdFromPrBody(pr.body);
      if (issueTaskId !== undefined) {
        const closeIssueOnMerge = scanCommitClosingKeywords([pr.body], issueTaskId).length > 0;
        const newBody = reviewRequestBody(issueTaskId, {
          closeIssueOnMerge,
          ...(verificationFailed ? { verificationFailed: true } : {}),
        });
        if (newBody !== pr.body) {
          log(`revise-pr ${target.repoSlug}#${target.number}: body -> re-derived (${verificationFailed ? 'Part of' : closeIssueOnMerge ? 'Closes' : 'no-close'})`);
          await gh(['pr', 'edit', String(target.number), '--repo', target.repoSlug, '--body', newBody]);
        }
      }

      // Reply to and resolve each addressed thread (one reply per unique thread).
      // Map each threadId to its first actionable item to derive a per-thread point.
      const threadIdToItem = new Map<string, FeedbackItem>();
      for (const item of actionable) {
        if (item.source === 'thread' && item.threadId !== undefined && !threadIdToItem.has(item.threadId)) {
          threadIdToItem.set(item.threadId, item);
        }
      }
      await Promise.all(
        [...threadIdToItem.entries()].map(([threadId, item]) => {
          const p = pointFor(item);
          const detail = p ? `: ${p}` : '.';
          return replyAndResolveThread(threadId, `Addressed in commit ${sha}${detail}\n\n${revisionMarker(pr.headRefOid, whiteLabel)}`, gh);
        }),
      );

      // Post a per-item referencing reply for each non-threadable feedback item.
      const nonThreadItems = actionable.filter((item) => item.source !== 'thread');
      await Promise.all(
        nonThreadItems.map((item) => commentPullRequest(target, buildItemReply(item, pointFor(item), sha, pr.headRefOid, whiteLabel), gh)),
      );

      // Post the single final round summary.
      const verificationStatus = verification === undefined ? 'unknown' : verification.passed ? 'pass' : 'fail';
      const summaryText = buildRevisionSummary({
        repoSlug: target.repoSlug,
        number: target.number,
        headRefOid: pr.headRefOid,
        commitSha: sha,
        addressed: actionable.map((item) => ({ item, point: pointFor(item) })),
        deferred: [],
        verification: { typecheck: verificationStatus, test: verificationStatus },
        whiteLabel,
      });
      await commentPullRequest(target, [summaryText, droppedCiPathsNote(ctx.droppedCiPaths)].filter((part) => part !== '').join('\n\n'), gh);

      log(`revise-pr ${target.repoSlug}#${target.number}: undraft -> pr ready${pushToken ? ' (VANGUARD_PUSH_TOKEN)' : ''}`);
      await markReady(gh, target.repoSlug, target.number, pushToken, log);

      await handBackPrLabels(gh, target.repoSlug, target.number, log);

      await stepSummary(verificationFailed ? 'verify-failed' : 'completed');
      return {
        pr,
        ignoredFeedback,
        addressed: actionable.length,
        committed: true,
        pushed: true,
        undrafted: true,
      };
    } catch (error) {
      await stepSummary('error', { error: String(error) });
      throw error;
    } finally {
      await disposeContext(ctx);
    }
  } finally {
    await providerProxies.destroy();
  }
}
