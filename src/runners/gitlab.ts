import { execa } from 'execa';
import { agentAuthFromEnv } from '../agents/auth.js';
import { GitLabTaskFetcher, linkMergeRequest, addMrFailureLabel, editGitlabLabels, commentGitlabIssue, defaultGlabRunner } from '../tasks/gitlab.js';
import { implementReviewSimplifyStages } from '../pipeline/pipeline.js';
import { parseMergeRequestRef, postMergeRequestNote, mergeRequestReviewMarker } from './mr-review.js';
import { REVIEW_INCOMPLETE, stripReviewMarkers } from './review-prompt.js';
import type { MergeRequestReviewTarget } from './mr-review.js';
import { renderConformanceSection, hasBlockingFinding } from '../pipeline/review-publish.js';
import { runSourcedIssue } from './source-adapter.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import { gitlabFailureLabel, GITLAB_SECRET_BLOCKED_LABEL } from '../gitlab-labels.js';
import type { Task } from '../tasks/fetcher.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { RunIssueDeps, RunIssueResult, SourceAdapter, PublishVerdictInput, ProofFailureKind } from './source-adapter.js';

/** Everything needed to run a single GitLab issue end to end. */
export interface RunGitlabIssueDeps extends RunIssueDeps {
  /** GitLab project path, e.g. `group/project`. */
  project: string;
}

/** The shared run result, unnarrowed: `secretBlocked` must reach the watch loop so a withheld MR is not read as "no changes". */
export type RunGitlabIssueResult = RunIssueResult;

/** @internal Exported for unit tests; production callers use runGitlabIssue. */
export function gitlabAdapter(deps: RunGitlabIssueDeps, glab?: GlabRunner): SourceAdapter {
  return {
    async prepare(issueRef: string) {
      const task = await new GitLabTaskFetcher(deps.project, glab).fetch(issueRef);
      return { task };
    },
    taskId: (task: Task) => `gl-${task.id.replace(/[^a-zA-Z0-9]/g, '-')}`,
    stages: implementReviewSimplifyStages,
    closeIssueOnMerge: true,
    reviewCli: 'glab',
    publishVerdict: (input: PublishVerdictInput) => publishGitlabVerdict(deps.project, input, glab),
    addFailureLabel: (mrUrl: string, kind: ProofFailureKind) => addGitlabFailureLabel(deps.project, mrUrl, kind, glab),
    async linkPr(issueRef: string, _task: Task, mrUrl: string) {
      await linkMergeRequest(deps.project, issueRef, mrUrl, glab);
    },
    async signalSecretBlock(issueRef: string, _task: Task, block: SecretBlock) {
      // `glab issue update --label` is a silent no-op on a project lacking the label (see
      // addMrFailureLabel), which would leave the held issue with no Vanguard label at all. Ensure
      // it first; every step stays best-effort.
      const label = (glab ?? defaultGlabRunner)(['label', 'create', '--repo', deps.project, '--name', GITLAB_SECRET_BLOCKED_LABEL])
        .catch(() => undefined)
        .then(() => editGitlabLabels(deps.project, issueRef, { add: [GITLAB_SECRET_BLOCKED_LABEL] }, glab))
        .catch(() => undefined);
      // No recovery procedure here (the watch primitive that holds the issue posts the resume line).
      await Promise.all([label, commentGitlabIssue(deps.project, issueRef, renderSecretBlockComment(block), glab).catch(() => undefined)]);
    },
  };
}

/**
 * Post the reviewer verdict (+ optional conformance section) as a note on a GitLab MR. Shared by
 * every source whose review surface is GitLab; `project` resolves a bare MR iid.
 */
export async function publishGitlabVerdict(project: string, input: PublishVerdictInput, glab?: GlabRunner): Promise<void> {
  if (input.reviewerOutcome === undefined) {
    throw new Error(`publishVerdict: no reviewer outcome for ${input.prUrl} — silence is not ok`);
  }
  const target = parseMergeRequestRef(input.prUrl, project);
  const verdictText = input.reviewerOutcome.result.finalText;
  // Build the comment body with attribution header and MR dedupe marker.
  const body = stripReviewMarkers(verdictText.replace(/<promise>\s*COMPLETE\s*<\/promise>/gi, '')).trim();
  const sha7 = input.headSha.slice(0, 7);
  const header = `Reviewed by ${input.attribution} @ ${sha7}`;
  // The glab user writes this note, so its marker would make review-mr skip the head for good: an
  // incomplete review gets none.
  const completed = input.reviewerOutcome.result.completed;
  const visible = !completed
    ? `## Vanguard Review\n\n${header}: ${REVIEW_INCOMPLETE}${body === '' ? '' : `\n\n${body}`}`
    : body === ''
      ? `## Vanguard Review\n\n${header}: no blocking issues`
      : `## Vanguard Review\n\n${header}:\n\n${body}`;
  let commentBody = completed ? `${visible}\n\n${mergeRequestReviewMarker(input.headSha)}` : visible;

  const conformanceResult = input.conformanceOutcome?.result;
  if (conformanceResult !== undefined) {
    const section = renderConformanceSection(conformanceResult);
    if (section !== undefined) {
      commentBody = `${commentBody}\n\n## Conformance\n\n${section}`;
    }
  }

  // Gate degrades to a plain note on GitLab — no --request-changes equivalent.
  // Warn when blocking findings exist so silence ≠ enforcement.
  if (input.gate === true) {
    const conformanceGateText = conformanceResult?.completed === false ? undefined : conformanceResult?.finalText;
    const blocking =
      hasBlockingFinding(verdictText) || (conformanceGateText !== undefined && hasBlockingFinding(conformanceGateText));
    if (blocking) {
      commentBody = `${commentBody}\n\n> ⚠️ Blocking findings detected — review gate is not enforced on GitLab (no \`--request-changes\` equivalent). Please review manually.`;
    }
  }

  await postMergeRequestNote(target, commentBody, glab);
}

/** Add a proof-failure label to a GitLab MR; `project` resolves a bare MR iid. */
export async function addGitlabFailureLabel(
  project: string,
  mrUrl: string,
  kind: ProofFailureKind,
  glab?: GlabRunner,
): Promise<void> {
  const label = gitlabFailureLabel(kind);
  // Best-effort: a bad URL must never block the run (publishGitlabVerdict uses the same parser).
  let target: MergeRequestReviewTarget;
  try {
    target = parseMergeRequestRef(mrUrl, project);
  } catch {
    return;
  }
  await addMrFailureLabel(target.project, target.iid, label, glab);
}

/**
 * Run one GitLab issue end to end: fetch via `glab`, run the canonical implement/review/simplify
 * pipeline (plus optional conformance), open a draft MR, publish the reviewer verdict, and comment
 * the MR link back onto the issue.
 */
export async function runGitlabIssue(issueRef: string, deps: RunGitlabIssueDeps): Promise<RunGitlabIssueResult> {
  return runSourcedIssue(issueRef, deps, gitlabAdapter(deps));
}

/** Extract `group/project` from a scp-like SSH remote or any `scheme://` remote URL (HTTPS, `ssh://` with a port). */
export function parseGitlabProjectFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed.includes('://')) return trimmed.match(/^[^:]+:(.+?)(?:\.git)?\/*$/)?.[1];
  try {
    return new URL(trimmed).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The GitLab project a git remote URL points at, or undefined for a known non-GitLab host
 * (GitHub, Bitbucket, Azure DevOps) or an unparseable URL. Any other host counts as GitLab,
 * so self-hosted instances are detected.
 */
export function gitlabProjectFromRemote(remoteUrl: string): string | undefined {
  const host = remoteHostname(remoteUrl);
  if (host !== undefined && /(^|\.)(github\.com|bitbucket\.org|dev\.azure\.com)$/.test(host)) return undefined;
  return parseGitlabProjectFromRemote(remoteUrl);
}

/** A remote URL fit for logs: `scheme://user:token@host/...` loses its userinfo (CI remotes carry a job token). */
export function redactRemote(remoteUrl: string): string {
  // Greedy to the last `@` before the path, so an unencoded `@` in the password cannot leave a fragment.
  return remoteUrl.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');
}

/** Lower-cased hostname of a URL or a bare `host[:port]` (a GITLAB_HOST value), without scheme, user or port. */
function hostnameOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  // scp-like `user@host:path`, or a bare `host[:port]`.
  return /^(?:[^@/]+@)?([^:/]+)/.exec(trimmed)?.[1]?.toLowerCase();
}

/**
 * Lower-cased host of a git remote, or undefined for a local path. Git reads a remote without a scheme
 * as scp-like only when a colon comes before any slash; `../mirror.git` or `mirror.git` is a path.
 */
export function remoteHostname(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.includes('://')) return hostnameOf(trimmed);
  return /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed)?.[1]?.toLowerCase();
}

/**
 * Whether a remote's host is GitLab by explicit signal: gitlab.com, or the host in glab's
 * GITLAB_HOST. Stricter than gitlabProjectFromRemote because it serves sources whose review surface
 * defaults to GitHub (Linear): a GitHub Enterprise or other unknown host must keep that default.
 */
export function isKnownGitlabRemote(remoteUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = remoteHostname(remoteUrl);
  if (host === undefined) return false;
  const selfHosted = env.GITLAB_HOST === undefined ? undefined : hostnameOf(env.GITLAB_HOST);
  return host === 'gitlab.com' || host === selfHosted;
}

/**
 * The GitLab project the `origin` remote of `repoPath` points at when isKnownGitlabRemote accepts
 * it; undefined for any other host or when origin is unreadable (preflight then checks gh, too).
 * Throws when origin is on GitLab but names no project: falling back to gh would publish to the
 * wrong forge after the agent work is done.
 */
export async function knownGitlabProjectFromOrigin(repoPath: string): Promise<string | undefined> {
  let origin: string;
  try {
    origin = (await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath })).stdout;
  } catch {
    return undefined;
  }
  if (!isKnownGitlabRemote(origin)) return undefined;
  const project = parseGitlabProjectFromRemote(origin);
  if (project === undefined) throw new Error(`origin ${redactRemote(origin)} is on GitLab but names no group/project; fix the remote.`);
  return project;
}

/** Assemble `RunGitlabIssueDeps` from environment + CLI flags (mirrors `githubDepsFromEnv`). */
export async function gitlabDepsFromEnv(repoPath: string, project: string | undefined, choice: ProviderChoice = {}): Promise<RunGitlabIssueDeps> {
  // Resolve auth first (mirrors githubDepsFromEnv order), so a missing-credential error surfaces
  // before git-remote detection. Without this, deps.auth is undefined and runSourcedIssue injects
  // no token into the sandbox — `run --gitlab` agents fail "Not logged in". The whole choice, so a
  // claude fallback behind a codex implementer gets its credential too.
  const auth = agentAuthFromEnv(choice);
  let resolvedProject = project;
  if (resolvedProject === undefined) {
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const remote = stdout.trim();
    resolvedProject = gitlabProjectFromRemote(remote);
    if (resolvedProject === undefined) {
      throw new Error(`Cannot detect a GitLab project from the origin remote (${redactRemote(remote)}). Pass --gitlab-project explicitly.`);
    }
  }
  return {
    ...(auth !== undefined ? { auth } : {}),
    repoPath,
    project: resolvedProject,
    ...(choice.provider !== undefined ? { provider: choice.provider } : {}),
    ...(choice.reviewProvider !== undefined ? { reviewProvider: choice.reviewProvider } : {}),
  };
}
