import { execa } from 'execa';
import { GitHubTaskFetcher, linkPullRequest, addPrFailureLabel, editGithubLabels, commentGithubIssue, defaultGhRunner } from '../tasks/github.js';
import { GitHubProjectFetcher } from '../tasks/github-project.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { publishReviewVerdict } from '../pipeline/review-publish.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { fanOut } from '../pipeline/fan-out.js';
import { runSourcedIssue } from './source-adapter.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { githubFailureLabel, GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { GhRunner } from '../tasks/github.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { FanOutOutcome } from '../pipeline/fan-out.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { RunIssueDeps, RunIssueResult, SourceAdapter, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitHub issue end to end. */
export interface RunGithubIssueDeps extends RunIssueDeps {
  repoSlug: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld PR is not read as "no changes". */
export type RunGithubIssueResult = RunIssueResult;

/**
 * @internal Exported for unit tests; production callers use runGithubIssue. Only `signalSecretBlock`
 * goes through the injected `gh`; `prepare`, `linkPr` and `addFailureLabel` still reach the real CLI.
 */
export function githubAdapter(deps: RunGithubIssueDeps, gh: GhRunner = defaultGhRunner): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const task = await new GitHubTaskFetcher(deps.repoSlug).fetch(issueRef);
      return { task };
    },
    taskId: (task) => `gh-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    publishVerdict: publishReviewVerdict,
    async addFailureLabel(prUrl: string, kind: ProofFailureKind) {
      await addPrFailureLabel(deps.repoPath, prUrl, githubFailureLabel(kind));
    },
    async linkPr(issueRef: string, _task: Task, prUrl: string) {
      await linkPullRequest(deps.repoSlug, issueRef, prUrl);
    },
    async signalSecretBlock(issueRef: string, _task: Task, block: SecretBlock) {
      // `gh issue edit --add-label` fails on a repo that never created the label, which would leave
      // the held issue with no Vanguard label at all. Ensure it first (the same pre-step as
      // addPrFailureLabel and the revise path); every step stays best-effort.
      const label = gh(['label', 'create', GITHUB_SECRET_BLOCKED_LABEL, '--repo', deps.repoSlug, '--force'])
        .catch(() => undefined)
        .then(() => editGithubLabels(deps.repoSlug, issueRef, { add: [GITHUB_SECRET_BLOCKED_LABEL] }, gh))
        .catch(() => undefined);
      // No recovery procedure here: this adapter also serves one-shot `vanguard run` and Projects,
      // whose release steps differ. The watch primitive that holds the issue posts the resume line.
      await Promise.all([label, commentGithubIssue(deps.repoSlug, issueRef, renderSecretBlockComment(block), gh).catch(() => undefined)]);
    },
  };
}

/**
 * Run one GitHub issue end to end: fetch via `gh`, run the canonical implement/review/simplify
 * pipeline (the issue title/body go in as variables — no skill needed), open a draft PR, and comment
 * the PR link back onto the issue. GitHub is both the source and the review surface.
 */
export async function runGithubIssue(issueRef: string, deps: RunGithubIssueDeps): Promise<RunGithubIssueResult> {
  return runSourcedIssue(issueRef, deps, githubAdapter(deps));
}

/**
 * Board tasks whose `owner/repo#N` id belongs to `repoSlug` (case-insensitive). runGithubIssue is
 * pinned to the configured repo, so an item from another repo would run the local issue with the
 * same number; those are skipped with a warning, as the board watch does.
 */
export function sameRepoTasks(tasks: Task[], repoSlug: string): Task[] {
  return tasks.filter((task) => {
    const itemRepo = task.id.slice(0, task.id.lastIndexOf('#'));
    if (itemRepo.toLowerCase() === repoSlug.toLowerCase()) return true;
    console.warn(`vanguard: project item ${task.id} belongs to another repository than ${repoSlug}; skipped`);
    return false;
  });
}

/**
 * Run every issue on a GitHub Projects v2 board (optionally filtered by label) as its own run + PR,
 * concurrently and with failure isolation. The owner defaults to the repo slug's owner.
 */
export async function runGithubProject(
  deps: RunGithubIssueDeps,
  opts: { projectNumber: number; owner?: string; label?: string; concurrency?: number },
): Promise<{ tasks: Task[]; outcomes: FanOutOutcome<Task, RunGithubIssueResult>[] }> {
  const owner = opts.owner ?? (deps.repoSlug.split('/')[0] as string);
  const fetcher = new GitHubProjectFetcher({ owner, projectNumber: opts.projectNumber, repo: deps.repoSlug });
  const tasks = sameRepoTasks(await fetcher.list(opts.label !== undefined ? { labels: [opts.label] } : undefined), deps.repoSlug);
  const outcomes = await fanOut(tasks, (task) => runGithubIssue(task.id, deps), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  });
  return { tasks, outcomes };
}

/** Read the run dependencies from the environment (+ flag overrides), resolving the repo slug from origin. */
export async function githubDepsFromEnv(repoPath: string, repoSlug?: string, choice: ProviderChoice = {}): Promise<RunGithubIssueDeps> {
  // The whole choice, so every provider that may run (reviewer, implementer fallback) is counted
  // when deciding whether the Anthropic credential must be injected.
  const auth = agentAuthFromEnv(choice);
  const slug = repoSlug ?? process.env.GITHUB_REPO ?? (await detectRepoSlug(repoPath));
  return { ...(auth !== undefined ? { auth } : {}), repoPath, repoSlug: slug };
}

/** Extract the owner/repo slug from the origin remote. */
export async function detectRepoSlug(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd });
  const match = stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match?.[1] === undefined) throw new Error(`Could not detect repo from origin: ${stdout.trim()}`);
  return match[1];
}
