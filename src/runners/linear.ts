import { LinearCliTaskFetcher, linkLinearIssue, commentLinearIssue } from '../tasks/linear-cli.js';
import { implementReviewSimplifyStages, retrospectiveMemoryBlock } from '../pipeline/pipeline.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { addPrFailureLabel } from '../tasks/github.js';
import { fanOut } from '../pipeline/fan-out.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { runSourcedIssue } from './source-adapter.js';
import { knownGitlabProjectFromOrigin, publishGitlabVerdict, addGitlabFailureLabel } from './gitlab.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { githubFailureLabel } from '../github-labels.js';
import type { PipelineStage } from '../pipeline/pipeline.js';
import type { Task, SubTask } from '../tasks/fetcher.js';
import type { CustomProviderEntry } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { RunIssueDeps, RunIssueResult, SourceAdapter, PublishVerdictInput, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single Linear issue end to end. */
export interface RunLinearIssueDeps extends RunIssueDeps {
  linearKey: string;
  /** Required here: the agent reads the issue through the linear-cli skill in this dir. */
  skillsDir: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld PR is not read as "no changes". */
export type RunLinearIssueResult = RunIssueResult;

/**
 * The canonical implement/review/simplify pipeline with only the implementer's prompt swapped, so
 * the agent reads the issue from Linear via the injected linear-cli skill. The review and simplify
 * stages stay canonical (no duplicated prompts, no silently dropped review).
 */
function linearStages(): PipelineStage[] {
  const base = implementReviewSimplifyStages();
  const implementer = base[0];
  if (implementer === undefined) throw new Error('implementReviewSimplifyStages() returned no stages');
  const readAndImplement = [
    'Use the linear-cli skill to read Linear issue {{ISSUE}} for the full spec:',
    'run `linear issue view {{ISSUE}} --json` (the `linear` CLI is installed and LINEAR_API_KEY is set).',
    '',
    'Implement it in the current repo, keeping the change minimal. If the description is too vague to',
    'write code, add or update NOTES.md summarising the issue instead.',
    '',
    retrospectiveMemoryBlock(),
    '',
    'When done, write <promise>COMPLETE</promise>.',
    '',
    'Title: {{TITLE}}',
  ].join('\n');
  return [{ ...implementer, promptTemplate: readAndImplement }, ...base.slice(1)];
}

/**
 * @internal Exported for unit tests; production callers use runLinearIssue. `gitlabProject` is set
 * when origin is on gitlab.com or GITLAB_HOST: the draft MR, verdict note and failure labels then go
 * through glab.
 */
export function linearAdapter(deps: RunLinearIssueDeps, gitlabProject?: string, glab?: GlabRunner): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      return { task: await new LinearCliTaskFetcher().fetch(issueRef) };
    },
    secrets: { LINEAR_API_KEY: deps.linearKey },
    taskId: (task) => `linear-${task.id.toLowerCase()}`,
    stages: linearStages,
    variables: (issueRef: string) => ({ ISSUE: issueRef }),
    ...(gitlabProject !== undefined ? { reviewCli: 'glab' as const } : {}),
    publishVerdict: gitlabProject === undefined
      ? publishReviewVerdict
      : (input: PublishVerdictInput) => publishGitlabVerdict(gitlabProject, input, glab),
    async addFailureLabel(prUrl: string, kind: ProofFailureKind) {
      if (gitlabProject !== undefined) return addGitlabFailureLabel(gitlabProject, prUrl, kind, glab);
      await addPrFailureLabel(deps.repoPath, prUrl, githubFailureLabel(kind));
    },
    async linkPr(_issueRef: string, task: Task, prUrl: string) {
      await linkLinearIssue(task.id, prUrl);
    },
    async signalSecretBlock(_issueRef: string, task: Task, block: SecretBlock) {
      // Linear uses workflow states, not labels; the comment is the primary signal. The watch
      // primitive that holds the issue posts how to release it (it knows the configured states).
      try {
        await commentLinearIssue(task.id, renderSecretBlockComment(block));
      } catch { /* best-effort */ }
    },
  };
}

/**
 * Run one Linear issue end to end: the agent reads it from inside the sandbox via the injected
 * linear-cli skill, runs the canonical implement/review/simplify pipeline, opens a draft GitHub PR
 * (a draft GitLab MR when origin is on gitlab.com or GITLAB_HOST), and comments the PR/MR link back
 * onto the issue. Each call provisions its own sandbox, so callers can fan several out concurrently
 * (see runLinearParent).
 */
export async function runLinearIssue(issueRef: string, deps: RunLinearIssueDeps): Promise<RunLinearIssueResult> {
  return runSourcedIssue(issueRef, deps, linearAdapter(deps, await knownGitlabProjectFromOrigin(deps.repoPath)));
}

/** Fan a Linear parent issue out into one independent run (and PR) per sub-issue. */
export async function runLinearParent(
  parentRef: string,
  deps: RunLinearIssueDeps,
  opts: { concurrency?: number } = {},
): Promise<{ parent: Task; outcomes: FanOutOutcome<SubTask, RunLinearIssueResult>[] }> {
  const parent = await new LinearCliTaskFetcher().fetch(parentRef);
  const outcomes = await fanOut(parent.children, (child) => runLinearIssue(child.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { parent, outcomes };
}

/** Read the run dependencies from the environment, throwing actionable errors when one is missing. */
export function linearDepsFromEnv(provider?: string, customProviders?: readonly CustomProviderEntry[]): RunLinearIssueDeps {
  const auth = agentAuthFromEnv({
    ...(provider !== undefined ? { provider } : {}),
    ...(customProviders !== undefined ? { customProviders } : {}),
  });
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR to a directory of skills (e.g. a clone of schpet/linear-cli /skills).');
  }
  return { ...(auth !== undefined ? { auth } : {}), linearKey, skillsDir, repoPath: process.env.REPO_PATH ?? process.cwd() };
}
