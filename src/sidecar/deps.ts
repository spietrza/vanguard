import { capabilities } from '../api/capabilities.js';
import { assertFlowResolvable, deleteRepoFlow, listRepoFlows, readRepoFlow, writeRepoFlow } from '../flows/repo.js';
import { fetchTaskSpec, listBoardTasks } from '../tasks/board-list.js';
import { listRepoFiles, readRepoFile } from '../tasks/repo-files.js';
import { VanguardError } from '../core/errors.js';
import { loadCustomProviders } from '../agents/custom.js';
import {
  assertProvidersResolvable,
  customEgressHosts,
  validateProviderChoice,
  assertEgressCompatible,
  llmProxySupported,
  subscriptionCredentialProvider,
} from '../agents/registry.js';
import { createGithubIssue, createGitlabIssue, createLinearIssue } from '../tasks/create.js';
import { beginRun, endRun } from './cancel.js';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { githubDepsFromEnv, runGithubIssue } from '../runners/github.js';
import { gitlabDepsFromEnv, runGitlabIssue } from '../runners/gitlab.js';
import { runLinearIssue } from '../runners/linear.js';
import { agentAuthFromEnv } from '../agents/auth.js';
import { BadRequestError } from './sidecar.js';
import { AgentError } from '../core/errors.js';
import type { ProviderChoice } from '../agents/registry.js';
import type { AgentAuth } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { RunEvent } from '../pipeline/events.js';
import type { SidecarDeps, CreateRunParams, CreateRunResult } from './sidecar.js';

/**
 * Resolve the run's provider choice against the target repo's customs (S6): load, validate the
 * pairing rules (the sync protocol validator only shape-checks the name now), and reject plain-http
 * customs — this path is always-egress. AgentError wraps into BadRequestError so a bad name/entry
 * classifies `bad-request` in the loop's catch, not `internal`.
 */
async function resolveRunChoice(params: CreateRunParams): Promise<ProviderChoice> {
  const customProviders = await loadCustomProviders(params.repoPath);
  const choice: ProviderChoice = {
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(customProviders.length > 0 ? { customProviders } : {}),
  };
  try {
    assertProvidersResolvable(choice);
    validateProviderChoice(choice, {});
    assertEgressCompatible(choice); // createRun hardwires egress: true below
  } catch (error) {
    if (error instanceof AgentError) throw new BadRequestError(error.message);
    throw error;
  }
  return choice;
}

/** Env-derived required linear deps (mirrors run.ts `linearDeps`): key + skills dir + repo path. */
function linearExtras(
  repoPath: string,
  auth: AgentAuth | undefined,
): Pick<RunLinearIssueDeps, 'linearKey' | 'skillsDir' | 'repoPath' | 'auth'> {
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so the in-sandbox linear CLI can read the issue.');
  }
  const skillsDir = process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Set SKILLS_DIR (a clone of schpet/linear-cli /skills) for --linear runs.');
  }
  return { linearKey, skillsDir, repoPath, ...(auth !== undefined ? { auth } : {}) };
}

/**
 * Production wiring: build a sandbox context + provider auth from env, then dispatch to the same
 * source runner the CLI uses (mirrors `src/cli/run.ts`), with `onEvent` + the cancel `signal` threaded
 * in. Smoke-verified (needs Docker + creds), not unit-tested. The sidecar child is spawned WITHOUT a
 * project cwd (sidecar.rs runs `sh -c 'exec vanguard __sidecar'`, inheriting the app cwd — unlike
 * spawn.rs's raw-CLI path which sets current_dir), so the target repo must arrive explicitly as
 * `params.repoPath`, per run. Keep this thin — logic belongs in the runners, not here.
 */
export function productionDeps(): SidecarDeps {
  return {
    capabilities,
    // The first WRITE to an external system from the app, and it cannot be undone from inside it.
    // Params are validated at the protocol boundary (validateCreateTask) before we get here.
    createTask: async (params) => {
      const input = {
        title: params.title,
        body: params.body,
        ...(params.labels !== undefined && params.labels.length > 0 ? { labels: params.labels } : {}),
      };
      if (params.source === 'linear') {
        // Labels are NOT applied on Linear: IssueCreateInput takes labelIds (uuids), not the names
        // AppConfig holds, so honouring them needs a name->id resolution we do not do. Not passed at all
        // rather than passed-and-ignored, so the omission is visible here instead of buried one layer down.
        // team is guaranteed by validateCreateTask — an issue in the wrong team is real work in the wrong
        // place, with no undo.
        const { labels: _dropped, ...linearInput } = input;
        return createLinearIssue(params.team as string, linearInput);
      }
      if (params.source === 'gitlab') return createGitlabIssue(params.repoPath, input);
      return createGithubIssue(params.repoPath, input);
    },
    // Flow-file methods (S5): thin pass-throughs to core. FlowError → bad-request in the loop's catch.
    listFlows: async ({ repoPath }) => ({ flows: await listRepoFlows(repoPath) }),
    // Custom-provider listing (S6): health report, never a throw — broken entries come back flagged.
    listProviders: async ({ repoPath }) => ({
      providers: (await loadCustomProviders(repoPath)).map(({ index, name, error }) => ({
        index,
        ...(name !== undefined ? { name } : {}),
        ...(error !== undefined ? { error } : {}),
      })),
    }),
    readFlow: ({ repoPath, file }) => readRepoFlow(repoPath, file),
    writeFlow: ({ repoPath, file, doc }) => writeRepoFlow(repoPath, file, doc),
    deleteFlow: async ({ repoPath, file }) => {
      await deleteRepoFlow(repoPath, file);
      return {};
    },
    // Board read path (S9): user-fixable failures (no source, wrong team key, not logged in,
    // undetectable remote) arrive as VanguardError — wrap to bad-request so the board shows the
    // actionable message instead of an 'internal' shrug.
    listTasks: async ({ repoPath }) => {
      try {
        return await listBoardTasks(repoPath);
      } catch (error) {
        if (error instanceof VanguardError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    fetchSpec: async ({ repoPath, taskId }) => {
      try {
        return await fetchTaskSpec(repoPath, taskId);
      } catch (error) {
        if (error instanceof VanguardError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    // Composer `@`-mention autocomplete + inlining (Editor UX 7/7): repo-scoped reads. A git/FS
    // failure (not a repo, git absent, unreadable file) is user-fixable — wrap to bad-request so the
    // picker shows the actionable message instead of an 'internal' shrug, like the board path.
    listRepoFiles: async ({ repoPath }) => {
      try {
        return await listRepoFiles(repoPath);
      } catch (error) {
        if (error instanceof VanguardError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    readRepoFile: async ({ repoPath, path }) => {
      try {
        return await readRepoFile(repoPath, path);
      } catch (error) {
        if (error instanceof VanguardError) throw new BadRequestError(error.message);
        throw error;
      }
    },
    createRun: async (params: CreateRunParams, onEvent: (e: RunEvent) => void): Promise<CreateRunResult> => {
      // FIRST statements, before beginRun() and the sandbox: an unresolvable flow (typo, broken or
      // duplicate .hcl) or provider (unknown name, broken customs entry, http custom on this
      // always-egress path) must cost nothing and classify bad-request — and must not leave an
      // armed AbortController behind (endRun's finally only wraps the post-sandbox region). Pure
      // checks: no lowering, no ref import — repo TS must not execute on the untimed run pipe (S5 D6).
      if (params.flow !== undefined) await assertFlowResolvable(params.flow, params.repoPath);
      const choice = await resolveRunChoice(params);
      const transport = params.transport ?? 'github';
      const provider = params.provider;
      const customProviders = choice.customProviders;
      const repoPath = params.repoPath;
      // Auth is resolved BEFORE beginRun: it is a pure env read, and a missing key must not leave
      // an armed AbortController behind (same rationale as the resolvability checks above). Wrapped
      // as bad-request: a missing env var is caller-correctable, same class as an unknown name —
      // without the wrap it is the ONE dispatch-time failure that classified `internal`.
      let auth: AgentAuth | undefined;
      try {
        auth = agentAuthFromEnv(choice);
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error));
      }
      const extraEgressHosts = customEgressHosts(choice);
      // A used provider's subscription credential (Codex's CODEX_AUTH_JSON) lands in the sandbox
      // verbatim regardless of llmProxy (providerSecrets forwards it before consulting proxyMode) —
      // the proxy offers it no protection.
      const subscriptionProvider = subscriptionCredentialProvider(choice);
      // The hub always wants the credential OUT of the sandbox: attempt --llm-proxy for any choice
      // structurally eligible for it (same combinations the CLI accepts) — there is no hub/sidecar
      // knob to turn this off for an eligible choice (see docs/hub.md) — UNLESS doing so would only
      // demand a primary-sidecar (Claude-family) credential this run has no other use for, to protect
      // a subscription credential the proxy can't touch anyway (a pure Codex-subscription run, no
      // Claude token set): that combination must still start, not fail on a credential nobody needs.
      const llmProxy = llmProxySupported(choice) && (subscriptionProvider === undefined || auth !== undefined);
      const signal = beginRun();
      const ctx = await startSandboxContext({
        egress: true,
        llmProxy,
        ...(auth !== undefined ? { auth } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(extraEgressHosts.length > 0 ? { extraEgressHosts } : {}),
      });
      if (subscriptionProvider !== undefined) {
        onEvent({
          type: 'warning',
          message:
            `${subscriptionProvider}'s subscription credential is not covered by the LLM proxy and is visible ` +
            'to the agent inside the sandbox for this run.',
        });
      }
      try {
        // The RunOptions the sidecar exposes + the sandbox wiring + the event seam, shared across transports.
        const common = {
          onEvent,
          signal,
          ...(provider !== undefined ? { provider } : {}),
          ...(customProviders !== undefined ? { customProviders } : {}),
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.baseBranch !== undefined ? { baseBranch: params.baseBranch } : {}),
          // Named-flow dispatch: pass the validated flow key straight through. runSourcedIssue
          // resolves it via FLOWS[flow].build() (Subsystem 2). Any registered FLOWS entry works with
          // no per-flow wiring here; validation happened in sidecar.ts::validateCreateRun.
          ...(params.flow !== undefined ? { flow: params.flow } : {}),
          ...(ctx.proxyUrl !== undefined ? { proxyUrl: ctx.proxyUrl } : {}),
          ...(ctx.network !== undefined ? { network: ctx.network } : {}),
          ...(ctx.llmProxy !== undefined ? { llmProxy: ctx.llmProxy } : {}),
        };
        const authChoice = {
          ...(provider !== undefined ? { provider } : {}),
          ...(customProviders !== undefined ? { customProviders } : {}),
        };
        if (transport === 'gitlab') {
          const deps = await gitlabDepsFromEnv(repoPath, undefined, authChoice);
          return await runGitlabIssue(params.issueRef, { ...deps, ...common });
        }
        if (transport === 'linear') {
          return await runLinearIssue(params.issueRef, { ...common, ...linearExtras(repoPath, auth) });
        }
        const deps = await githubDepsFromEnv(repoPath, undefined, authChoice);
        return await runGithubIssue(params.issueRef, { ...deps, ...common });
      } finally {
        await ctx.destroy();
        endRun();
      }
    },
  };
}
