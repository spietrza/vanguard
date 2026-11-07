import { loadProviderChoice } from './provider-choice.js';
import { customEgressHosts } from '../agents/registry.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { runRevisePullRequest } from '../runners/revise-pr.js';
import type { ReviseGithubPrDeps, ReviseGithubPrResult } from '../runners/revise-pr.js';
import type { Command } from './args.js';

type RevisePrCommand = Extract<Command, { kind: 'revise-pr' }>;
type RevisePullRequestRunner = (ref: string, deps: ReviseGithubPrDeps) => Promise<ReviseGithubPrResult>;

export interface RevisePrCommandDeps {
  revisePullRequest?: RevisePullRequestRunner;
  log?: (line: string) => void;
}

/** Read human review feedback on a bot PR, apply fixes, and hand it back ready to merge. */
export async function revisePrCommand(cmd: RevisePrCommand, deps: RevisePrCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const runRevise = deps.revisePullRequest ?? runRevisePullRequest;

  // Ctrl-C during a repair resume aborts it (observed when the current agent exec ends), as in watch-prs.
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const choice = await loadProviderChoice(cmd);
  const baseDeps = {
    ...choice,
    ...(cmd.feedbackAuthors !== undefined ? { feedbackAuthors: cmd.feedbackAuthors } : {}),
    repoPath: cmd.repoPath,
    signal: controller.signal,
    ...(cmd.repoSlug !== undefined ? { repoSlug: cmd.repoSlug } : {}),
    ...(cmd.fallbackModel !== undefined ? { fallbackModel: cmd.fallbackModel } : {}),
    ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
    ...(cmd.maxRounds !== undefined ? { maxRounds: cmd.maxRounds } : {}),
    ...(cmd.commitAuthor !== undefined ? { commitAuthor: cmd.commitAuthor } : {}),
    ...(cmd.out !== undefined ? { out: cmd.out } : {}),
    ...(cmd.skillsDir !== undefined ? { skillsDir: cmd.skillsDir } : {}),
    log,
  };

  if (deps.revisePullRequest !== undefined) {
    logResult(await runRevise(cmd.prRef, baseDeps), log);
    return;
  }

  const auth = agentAuthFromEnv(choice);
  const sandboxContext = await startSandboxContext({
    egress: cmd.egress,
    extraEgressHosts: customEgressHosts(choice),
    llmProxy: cmd.llmProxy === true,
    ...(auth !== undefined ? { auth } : {}),
    ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
  });
  try {
    const result = await runRevise(cmd.prRef, {
      ...baseDeps,
      ...(auth !== undefined ? { auth } : {}),
      ...(cmd.llmProxy === true ? { llmProxy: sandboxContext.llmProxy } : {}),
      ...(sandboxContext.proxyUrl !== undefined ? { proxyUrl: sandboxContext.proxyUrl } : {}),
      ...(sandboxContext.network !== undefined ? { network: sandboxContext.network } : {}),
    });
    logResult(result, log);
  } finally {
    await sandboxContext.destroy();
  }
}

function logResult(result: ReviseGithubPrResult, log: (line: string) => void): void {
  // Ignored-author lines are logged by runRevisePullRequest itself (through this same `log`) — printing
  // them here too would duplicate every line.
  const id = `${result.pr.repoSlug}#${result.pr.number}`;
  if (result.secretBlocked === true) {
    log(`revise-pr ${id}: BLOCKED — the revision diff carries a secret; nothing pushed (${result.addressed} item(s) abandoned)`);
    return;
  }
  if (result.dryRunOut !== undefined) {
    log(`revise-pr ${id}: dry-run written to ${result.dryRunOut} (nothing pushed or commented)`);
    return;
  }
  if (!result.committed) {
    log(`revise-pr ${id}: done (no changes committed)`);
  } else {
    log(`revise-pr ${id}: done (pushed, undrafted: ${String(result.undrafted)})`);
  }
}
