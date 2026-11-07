import { parseArgs } from 'node:util';
import { isProviderName, validateProviderChoice, PROVIDER_NAMES } from '../agents/registry.js';
import type { ProviderName } from '../agents/registry.js';
import type { RunOptions } from '../runners/source-adapter.js';
import { assertSafeBaseBranch } from '../core/base-branch.js';

type WatchSource = 'linear' | 'github' | 'project' | 'gitlab';

export type Command =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean; abandoned: boolean }
  | {
      kind: 'review-pr';
      prRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
      /** Write the review to this local file instead of posting a PR comment (no trace on the tracker). */
      out?: string;
    }
  | {
      kind: 'research';
      /** GitHub issue ref: owner/repo#n, or a bare number with --github-repo. */
      issueRef: string;
      repoSlug?: string;
      repoPath: string;
      egress: boolean;
      llmProxy?: boolean;
      /** Declare that web egress is available; the prompt/comment will reflect web-research mode. */
      webAccess?: boolean;
      provider?: ProviderName;
      researchModel?: string;
      /** White-label the research comment (drop "Vanguard" heading/marker). Presence toggles it; the author value is unused (no commit). */
      commitAuthor?: { name: string; email: string };
    }
  | {
      kind: 'spec';
      /** GitHub issue ref: owner/repo#n, or a bare number with --github-repo. */
      issueRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      /** Model for the tech-spec stage (e.g. a planner-tier model). */
      specModel?: string;
      /** Override the tech-spec stage turn cap (default: techSpecStage's own default). Backs --max-turns. */
      maxTurns?: number;
      /** Branch the spec worktree is cut from — the "baseline" Fable researches against (default: main). */
      baseBranch?: string;
      /** Write the spec to this local file instead of posting an issue comment (no trace on the tracker; pairs with `run --spec-file`). */
      out?: string;
      /** White-label the spec comment (drop the "Vanguard" heading). Presence toggles it; the author value is unused (no commit). */
      commitAuthor?: { name: string; email: string };
    }
  | {
      kind: 'revise-pr';
      feedbackAuthors?: string[];
      prRef: string;
      repoSlug?: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      /**
       * When set, every stage on the primary provider retries once on this provider after an
       * AgentError (outage, usage limit, revoked credential, rate limit) — same contract as `run`/`watch`.
       */
      fallbackProvider?: ProviderName;
      /** Model for every stage that fell back (default: that provider's default). */
      fallbackModel?: string;
      reviewModel?: string;
      maxRounds?: number;
      /** Git author for the revision commits + white-label the revision marker (client repos carry no automation branding). */
      commitAuthor?: { name: string; email: string };
      /** Dry-run: write the diff + proposed thread replies to this local file and push/comment nothing. */
      out?: string;
    }
  | {
      kind: 'watch-prs';
      repoSlug: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      /** Only review PRs opened by this GitHub login (self-review-only when set). */
      author?: string;
      /** Review this PR even when the label-filtered scan misses it (from --pr or the CI label event). */
      pr?: number;
      /** PR-author logins trusted beyond OWNER/MEMBER/COLLABORATOR (pass the workflow's allowed-actors here). */
      feedbackAuthors?: string[];
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'doctor-prs';
      repoSlug: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      provider?: ProviderName;
      llmProxy?: boolean;
    }
  | ({
      kind: 'doctor';
      /** Repair what the checks can repair (today: refresh the sandbox image's claude CLI). */
      fix?: boolean;
      source: 'linear' | 'github' | 'project' | 'gitlab';
      label?: string;
      projectNumber?: number;
      /** GitLab project path (e.g. group/project); required when source === 'gitlab'. */
      project?: string;
      team?: string;
      triggerState?: string;
      triggerStateName?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      /** Cap on ready tasks per poll; parsed with watch's flags, read by nothing doctor runs. */
      maxTasks?: number;
      specModel?: string;
      specLabel?: string;
      agentLabel?: string;
      needsInfoLabel?: string;
      specClaimedLabel?: string;
      specState?: string;
      specStateName?: string;
      agentState?: string;
      needsInfoState?: string;
      specClaimedState?: string;
      specOnly?: boolean;
      llmProxy?: boolean;
    } & Omit<SharedRunOptions, StageOnlyKey>)
  | ({
      kind: 'run';
      source: 'linear' | 'github' | 'project' | 'gitlab';
      id: string;
      parent: boolean;
      gcBefore: boolean;
      egress: boolean;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      reuse?: boolean;
      repoPath: string;
      concurrency: number;
      repoSlug?: string;
      label?: string;
      /** GitLab project path (e.g. group/project); optional for --source gitlab (falls back to git remote auto-detect). */
      project?: string;
      /** Run the implementer stage as N variants via forkAndSelect, keeping the best-scored diff. */
      forkN?: number;
    } & RunOptions)
  | ({
      kind: 'watch';
      source: 'linear' | 'github' | 'project' | 'gitlab';
      /** Required for linear/github; optional for project (label-filter on the board). */
      label?: string;
      /** Project number; required when source === 'project'. */
      projectNumber?: number;
      /** GitLab project path (e.g. group/project); required when source === 'gitlab'. */
      project?: string;
      team?: string;
      triggerState?: string;
      triggerStateName?: string;
      claimedState?: string;
      reviewState?: string;
      repoSlug?: string;
      repoPath: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      /** Cap the number of ready tasks claimed and processed per poll. Unset: process all of them. */
      maxTasks?: number;
      /** Hold the provider credential (Anthropic, or z.ai with --provider zai) in a trusted sidecar; the sandbox gets only a per-run nonce (implies egress). */
      llmProxy?: boolean;
      // --- Loop v1 flags ---
      /** (loop-v1) Cheap model for the spec-generation stage. */
      specModel?: string;
      // GitHub loop-v1
      /** (github loop-v1) Label that triggers the spec pass (issues with this label are specced). */
      specLabel?: string;
      /** (github loop-v1) Label the agent pass triggers on (set after spec is generated). */
      agentLabel?: string;
      /** (github loop-v1) Label set when a ticket is too vague (e.g. 'needs info'). */
      needsInfoLabel?: string;
      /**
       * (github loop-v1) Label the spec pass moves a claimed ticket to while speccing
       * (default: 'vanguard:speccing'). Omitted when absent — the default is used.
       */
      specClaimedLabel?: string;
      // Linear loop-v1
      /** (linear loop-v1) State TYPE that triggers the spec pass (e.g. 'triage'). */
      specState?: string;
      /**
       * (linear loop-v1) Display NAME of the spec-trigger state — used to revert the issue on
       * spec-pass failure so the next poll re-picks it (e.g. 'Spec'). Required alongside --spec-state.
       */
      specStateName?: string;
      /** (linear loop-v1) State NAME the spec pass advances to (agent-pass trigger, e.g. 'Todo'). */
      agentState?: string;
      /** (linear loop-v1) State NAME for vague tickets that need more info (e.g. 'Needs Info'). */
      needsInfoState?: string;
      /**
       * (linear loop-v1) State NAME the spec pass moves a claimed ticket to while speccing
       * (default: 'Speccing'). Omitted when absent — the default is used.
       */
      specClaimedState?: string;
      /** (loop-v1) Run only the spec pass each tick; the agent pass is skipped (no list, claim or run). */
      specOnly?: boolean;
      // customProviders stays: dispatch loads the repo customs onto the command (watch.ts); only RunOnlyKey is excluded.
    } & Omit<RunOptions, RunOnlyKey>)
  | {
      kind: 'review-mr';
      iid: number;
      project: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'watch-mrs';
      project: string;
      repoPath: string;
      /** --skills dir, merged with the repo's .github/vanguard-skills/ (see skillRegistryForRun). */
      skillsDir?: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      /** Only review MRs opened by this GitLab username (self-review-only when set). */
      author?: string;
      concurrency: number;
      intervalMs: number;
      once: boolean;
      egress: boolean;
      llmProxy?: boolean;
      provider?: ProviderName;
      reviewModel?: string;
      /** First-attempt turn cap (default DEFAULT_REVIEW_MAX_TURNS); the retry after an incomplete review gets 1.5x. */
      maxTurns?: number;
    }
  | {
      kind: 'doctor-mrs';
      project: string;
      repoPath: string;
      label: string;
      reviewingLabel: string;
      reviewedLabel: string;
      provider?: ProviderName;
      llmProxy?: boolean;
    }
  | { kind: 'stats'; repoPath: string; json: boolean; /** Read the metrics file from this remote branch instead of the local .vanguard/runs. */ branch?: string }
  | { kind: 'metrics'; action: 'push'; repoPath: string; branch?: string }
  | { kind: 'approve'; prNumber: number; repoSlug: string; repoPath: string; mode: 'shadow'; json: boolean; dryRun: boolean; branch?: string }
  | { kind: 'memory'; repoPath: string; limit?: number; json: boolean }
  | {
      kind: 'eval';
      json: boolean;
      judgeModel?: string;
      produceModel?: string;
      /** Draft eval-corpus candidates from retrospective memory instead of running the corpus (suggest-only). */
      suggest: boolean;
      repoPath: string;
      limit?: number;
      /** Also write the drafted candidates to this scratch path (refused if under src/evals/corpus/). */
      out?: string;
    }
  | { kind: 'sidecar' }
  | { kind: 'complete' }
  | { kind: 'hub'; repoPath: string; host: string; port: number; uiDir?: string; open: boolean; allowedHosts?: string[] }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** The repo-configured provider-name grammar (S6, mirrors custom.ts) — every built-in matches too. */
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** `--fork-scorer` value: undefined when absent, null when unrecognised. */
function parseForkScorer(raw: unknown): 'llm' | 'decision' | undefined | null {
  if (raw === undefined) return undefined;
  return raw === 'llm' || raw === 'decision' ? raw : null;
}

/**
 * RunOptions keys only `run` sets: one spec file describes one task, and fork variants need one
 * implementer stage. watch processes every ready ticket per poll and never forks, so it rejects them.
 */
type RunOnlyKey = 'forkScorer' | 'specFile';

/**
 * The RunOptions run and watch read off the same flags. `customProviders` is loaded from the target
 * repo at dispatch (provider-choice.ts), never parsed.
 */
export type SharedRunOptions = Omit<RunOptions, RunOnlyKey | 'customProviders'>;

/** Shared keys only a running stage reads: doctor's preflight never runs one, so they stay off its command. */
type StageOnlyKey = 'visualProofCmd' | 'conformance' | 'conformanceModel';

/**
 * Every key of T, present or not — so a RunOptions field added without a line in parseRunOptions
 * is a type error, not a flag one subcommand silently drops.
 */
export type Exhaustive<T> = { readonly [K in keyof T]-?: T[K] | undefined };

/** Drop the undefined entries: an absent flag leaves no key on the command (callers test with `in`). */
function present<T extends object>(exhaustive: Exhaustive<T>): T {
  return Object.fromEntries(Object.entries(exhaustive).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Shared flags other commands validate too (provider gates, --commit-author, --flow/--plan, the
 * turn caps): parseCli checks them once, before any subcommand branch, and hands the results in.
 */
type CheckedRunFlags = Exhaustive<
  Pick<SharedRunOptions, 'provider' | 'reviewProvider' | 'fallbackProvider' | 'fallbackModel' | 'commitAuthor' | 'flow' | 'maxTurns' | 'maxRepairIterations'>
>;

/** `--feedback-authors a, b ,A` -> ['a','b']; an empty or separator-only value -> undefined, not []. */
function parseFeedbackAuthors(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const seen = new Set<string>();
  const authors = value.split(',').map((a) => a.trim()).filter((a) => {
    if (!a || seen.has(a.toLowerCase())) return false;
    seen.add(a.toLowerCase());
    return true;
  });
  return authors.length > 0 ? authors : undefined;
}

/** The one CLI → RunOptions mapping, used by run and watch so the two cannot drift. */
function parseRunOptions(values: Record<string, string | boolean | undefined>, checked: CheckedRunFlags): SharedRunOptions {
  return present<SharedRunOptions>({
    feedbackAuthors: parseFeedbackAuthors(values['feedback-authors']),
    provider: checked.provider,
    reviewProvider: checked.reviewProvider,
    fallbackProvider: checked.fallbackProvider,
    fallbackModel: checked.fallbackModel,
    providerModel: typeof values['provider-model'] === 'string' ? values['provider-model'] : undefined,
    reviewModel: typeof values['review-model'] === 'string' ? values['review-model'] : undefined,
    escalateModel: typeof values['escalate-model'] === 'string' ? values['escalate-model'] : undefined,
    noSimplify: values['no-simplify'] === true ? true : undefined,
    verifyCmd: typeof values.verify === 'string' ? values.verify : undefined,
    visualProofCmd: typeof values['visual-proof'] === 'string' ? values['visual-proof'] : undefined,
    conformance: values.conformance === true ? true : undefined,
    conformanceModel: typeof values['conformance-model'] === 'string' ? values['conformance-model'] : undefined,
    commitAuthor: checked.commitAuthor,
    plan: values.plan === true ? true : undefined,
    flow: checked.flow,
    baseBranch: typeof values.base === 'string' ? values.base : undefined,
    maxTurns: checked.maxTurns,
    maxRepairIterations: checked.maxRepairIterations,
    skillsDir: typeof values.skills === 'string' ? values.skills : undefined,
  });
}

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LOOP_V1_OWNERSHIP_LABEL = 'vanguard';
const DEFAULT_GITHUB_SPEC_LABEL = 'ready for spec';
export const DEFAULT_GITHUB_AGENT_LABEL = 'ready for agent';
const DEFAULT_GITHUB_NEEDS_INFO_LABEL = 'needs info';
const DEFAULT_LINEAR_SPEC_STATE = 'triage';
const DEFAULT_LINEAR_SPEC_STATE_NAME = 'Spec';
const DEFAULT_LINEAR_NEEDS_INFO_STATE = 'Needs Info';
/** State NAME the Linear spec pass advances to when --agent-state is absent. */
export const DEFAULT_LINEAR_AGENT_STATE = 'Todo';
/** First-attempt turn cap of a review-pr or review-mr run without --max-turns; the retry gets 1.5x. */
export const DEFAULT_REVIEW_MAX_TURNS = 16;
const DEFAULT_PR_REVIEWING_LABEL = 'vanguard:reviewing';
const DEFAULT_PR_REVIEWED_LABEL = 'vanguard:reviewed';
const DEFAULT_GITLAB_MR_REVIEWING_LABEL = 'vanguard::reviewing';
const DEFAULT_GITLAB_MR_REVIEWED_LABEL = 'vanguard::reviewed';
/** VANGUARD_HUB_HOST default (spec §2.10) — loopback-only, so a fresh install binds nothing reachable off-box. */
const DEFAULT_HUB_HOST = '127.0.0.1';
/** VANGUARD_HUB_PORT default (spec §2.10). */
const DEFAULT_HUB_PORT = 7777;

function fail(message: string): Command {
  return { kind: 'error', message };
}

// Case and surrounding spaces are not trusted to tell two names apart; a false match only rejects the config.
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Parse a positive-integer flag (--limit, --max-turns, --max-tasks, --max-repair-iterations, ...), or undefined
 * if absent or invalid. A huge value is clamped to Number.MAX_SAFE_INTEGER, so it still means "effectively
 * unlimited" and never reaches a CLI argument as Infinity or in exponent notation.
 */
function parseLimit(raw: string | boolean | undefined): number | undefined {
  const limit = Number(raw);
  return Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), Number.MAX_SAFE_INTEGER) : undefined;
}

/**
 * Parse a `--commit-author` value in git's `Name <email>` form into { name, email }. Returns undefined
 * when absent. Throws (as a caught string) on a malformed value so the caller can `return fail(...)`.
 */
function parseCommitAuthor(raw: string | boolean | undefined): { name: string; email: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*(.+?)\s*<([^<>]+)>\s*$/.exec(raw);
  const name = match?.[1];
  const email = match?.[2];
  if (name === undefined || email === undefined) {
    throw `Invalid --commit-author "${raw}". Use the form: "Name <email@example.com>".`;
  }
  return { name, email };
}

/**
 * Parse argv (without the node/script prefix) into a typed command. Pure: cwd is passed in so this is
 * unit-testable. Unknown options or a missing/unknown command resolve to `help`; invalid flag
 * combinations for a recognised command resolve to `error` with an actionable message.
 */
export function parseCli(argv: string[], cwd: string): Command {
  let values: Record<string, string | boolean | undefined>;
  let allowedHosts: string[] | undefined;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        // gc
        repo: { type: 'string' },
        'max-age-hours': { type: 'string' },
        remote: { type: 'string' },
        'dry-run': { type: 'boolean' },
        abandoned: { type: 'boolean' },
        // run
        linear: { type: 'string' },
        github: { type: 'string' },
        gitlab: { type: 'string' },
        'github-pr': { type: 'string' },
        'gitlab-project': { type: 'string' },
        mr: { type: 'string' },
        project: { type: 'string' },
        source: { type: 'string' },
        parent: { type: 'boolean' },
        'gc-before': { type: 'boolean' },
        egress: { type: 'boolean' },
        'llm-proxy': { type: 'boolean' },
        reuse: { type: 'boolean' },
        skills: { type: 'string' },
        'github-repo': { type: 'string' },
        label: { type: 'string' },
        'reviewing-label': { type: 'string' },
        'reviewed-label': { type: 'string' },
        author: { type: 'string' },
        concurrency: { type: 'string' },
        // watch-prs: review this PR even when the label-filtered scan misses it
        pr: { type: 'string' },
        // watch
        team: { type: 'string' },
        'trigger-state': { type: 'string' },
        'trigger-state-name': { type: 'string' },
        'claimed-state': { type: 'string' },
        'review-state': { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean' },
        'max-tasks': { type: 'string' },
        fix: { type: 'boolean' },
        'loop-v1': { type: 'boolean' },
        // watch loop-v1
        'spec-label': { type: 'string' },
        'spec-file': { type: 'string' },
        'feedback-authors': { type: 'string' },
        'agent-label': { type: 'string' },
        'needs-info-label': { type: 'string' },
        'spec-claimed-label': { type: 'string' },
        'spec-state': { type: 'string' },
        'spec-state-name': { type: 'string' },
        'agent-state': { type: 'string' },
        'needs-info-state': { type: 'string' },
        'spec-claimed-state': { type: 'string' },
        'spec-model': { type: 'string' },
        'spec-only': { type: 'boolean' },
        // provider selection (run + watch)
        provider: { type: 'string' },
        'review-provider': { type: 'string' },
        'fallback-provider': { type: 'string' },
        'fallback-model': { type: 'string' },
        // model selection per stage (run + watch)
        'provider-model': { type: 'string' },
        'review-model': { type: 'string' },
        // model for the 2nd+ gate repair — escalate only once the cheap model has demonstrably failed
        'escalate-model': { type: 'string' },
        // fork-variant scorer: 'llm' (one-shot agent verdict, default) or 'decision' (decision model)
        'fork-scorer': { type: 'string' },
        // skip the simplifier stage (lean run: implement -> review only)
        'no-simplify': { type: 'boolean' },
        // conformance review pass (opt-in; planner-tier model checks diff against spec)
        conformance: { type: 'boolean' },
        'conformance-model': { type: 'string' },
        // git author for the commit (run + watch); default `Vanguard <vanguard@local>`
        'commit-author': { type: 'string' },
        // run a dedicated opus planning stage before implement/review (run + watch)
        plan: { type: 'boolean' },
        // named workflow selection (run + watch); a FLOWS registry key, e.g. flow-b. --plan == --flow plan
        flow: { type: 'string' },
        // base branch to branch off and target the PR at (run + watch); default main
        base: { type: 'string' },
        // opt-in overrides to let a single run finish a large task (run + watch)
        'max-turns': { type: 'string' },
        'max-repair-iterations': { type: 'string' },
        // fork-and-select (run)
        fork: { type: 'string' },
        // proof-of-work verification (run + watch)
        verify: { type: 'string' },
        'visual-proof': { type: 'string' },
        // research
        web: { type: 'boolean' },
        'research-model': { type: 'string' },
        // revise-pr
        'max-rounds': { type: 'string' },
        // stats / memory / metrics
        json: { type: 'boolean' },
        // stats --branch / metrics push --branch: the orphan branch that holds durable metrics
        branch: { type: 'string' },
        limit: { type: 'string' },
        // approve
        mode: { type: 'string' },
        // eval
        'judge-model': { type: 'string' },
        'produce-model': { type: 'string' },
        // eval --suggest
        suggest: { type: 'boolean' },
        out: { type: 'string' },
        // hub
        port: { type: 'string' },
        host: { type: 'string' },
        'ui-dir': { type: 'string' },
        'no-open': { type: 'boolean' },
        'allowed-host': { type: 'string', multiple: true },
        help: { type: 'boolean' },
      },
    });
    const { 'allowed-host': hosts, ...singleValues } = parsed.values;
    allowedHosts = hosts;
    values = singleValues;
    positionals = parsed.positionals;
  } catch {
    return { kind: 'help' };
  }

  if (values.help === true) return { kind: 'help' };

  // Hidden desktop entrypoint: a persistent stdio JSON server (not a documented subcommand). Takes no
  // flags; parsed before provider validation so it never touches the run/watch surface.
  if (positionals[0] === '__sidecar') return { kind: 'sidecar' };
  // Hidden one-shot doc-chat completion (Subsystem 3): reads one JSON request on stdin, writes one
  // JSON line. A separate process per turn so it never queues behind the run sidecar's mutex.
  if (positionals[0] === '__complete') return { kind: 'complete' };

  const repoPath = typeof values.repo === 'string' ? values.repo : cwd;

  // The option table is shared, so every other command would accept --spec-only and silently do its full work.
  if (values['spec-only'] === true && positionals[0] !== 'watch' && positionals[0] !== 'doctor') {
    return fail('--spec-only is only supported with watch and doctor.');
  }

  // Provider flags. run/watch/doctor also accept repo-configured custom provider names (S6): those
  // shapes relax to the name grammar here — this parser is synchronous and cannot read the repo's
  // app.json, so resolution (and the "which names exist" error) happens at dispatch. Every other
  // command keeps the closed built-in set, and --review-provider is built-ins-only everywhere
  // (customs never review — spec §2/§3).
  const providerRaw = typeof values.provider === 'string' ? values.provider : undefined;
  const reviewProviderRaw = typeof values['review-provider'] === 'string' ? values['review-provider'] : undefined;
  const fallbackProviderRaw = typeof values['fallback-provider'] === 'string' ? values['fallback-provider'] : undefined;
  const fallbackModel = typeof values['fallback-model'] === 'string' ? values['fallback-model'] : undefined;
  const customsAllowed = positionals[0] === 'run' || positionals[0] === 'watch' || positionals[0] === 'doctor';
  if (providerRaw !== undefined && !isProviderName(providerRaw)) {
    if (!customsAllowed || !CUSTOM_NAME_RE.test(providerRaw)) {
      return fail(`Unknown provider "${providerRaw}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
    }
  }
  if (reviewProviderRaw !== undefined && !isProviderName(reviewProviderRaw)) {
    return fail(`Unknown review-provider "${reviewProviderRaw}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  const provider: string | undefined = providerRaw;
  if (fallbackProviderRaw !== undefined && !isProviderName(fallbackProviderRaw)) {
    return fail(`Unknown fallback-provider "${fallbackProviderRaw}". Choose one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  if (fallbackModel !== undefined && fallbackProviderRaw === undefined) {
    return fail('--fallback-model needs --fallback-provider.');
  }
  const reviewProvider: ProviderName | undefined = reviewProviderRaw;
  const fallbackProvider: ProviderName | undefined = fallbackProviderRaw;
  // Closed-set shapes: the gate above guarantees a built-in there; this re-narrow is for the compiler.
  const builtinProvider: ProviderName | undefined =
    provider !== undefined && isProviderName(provider) ? provider : undefined;

  // Named flow (run + watch). --flow selects a FLOWS entry or a repo `.vanguard/flows/*.hcl` flow
  // (S5); --plan stays the alias for flow 'plan'. No name check here: this parser is synchronous
  // and cannot see the repo's flow files — an unknown name fails in the async dispatch, which
  // lists built-ins + discovered repo flows.
  const flowRaw = typeof values.flow === 'string' ? values.flow : undefined;
  if (flowRaw !== undefined && values.plan === true) {
    return fail('Use either --plan or --flow <name>, not both — --plan is the alias for --flow plan.');
  }

  let commitAuthor: { name: string; email: string } | undefined;
  try {
    commitAuthor = parseCommitAuthor(values['commit-author']);
  } catch (message) {
    return fail(String(message));
  }

  // Checked once here for run, watch and spec, so a bad --base exits before any ticket is claimed.
  if (typeof values.base === 'string') {
    try {
      assertSafeBaseBranch(values.base);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  // Opt-in overrides to let a single run finish a large task (run + watch). Positive integers only;
  // 0/negative/non-numeric are rejected at parse (no override set), same semantics as parseLimit.
  const maxTurns = parseLimit(values['max-turns']);
  const maxRepairIterations = parseLimit(values['max-repair-iterations']);

  if (positionals[0] === 'stats') {
    return {
      kind: 'stats',
      repoPath,
      json: values.json === true,
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    };
  }

  if (positionals[0] === 'approve') {
    const prRaw = typeof values.pr === 'string' ? values.pr : positionals[1];
    const prNumber = prRaw !== undefined ? Number(prRaw) : NaN;
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    if (repoSlug === undefined) return fail('approve requires --github-repo <owner/repo>.');
    if (!Number.isInteger(prNumber) || prNumber < 1) return fail(`approve requires a positive --pr <n>, got "${String(prRaw)}".`);
    const modeRaw = typeof values.mode === 'string' ? values.mode : 'shadow';
    if (modeRaw === 'live') return fail('approve: live mode is not implemented (shadow only in v1).');
    if (modeRaw !== 'shadow') return fail(`approve: unknown --mode "${modeRaw}" (shadow only in v1).`);
    return {
      kind: 'approve',
      prNumber,
      repoSlug,
      repoPath,
      mode: 'shadow',
      json: values.json === true,
      dryRun: values['dry-run'] === true,
      ...(typeof values.branch === 'string' ? { branch: values.branch } : {}),
    };
  }

  if (positionals[0] === 'metrics') {
    if (positionals[1] !== 'push') return fail('metrics expects a subcommand: vanguard metrics push [--repo <path>] [--branch <name>].');
    return { kind: 'metrics', action: 'push', repoPath, ...(typeof values.branch === 'string' ? { branch: values.branch } : {}) };
  }

  if (positionals[0] === 'memory') {
    const limit = parseLimit(values.limit);
    return {
      kind: 'memory',
      repoPath,
      ...(limit !== undefined ? { limit } : {}),
      json: values.json === true,
    };
  }

  if (positionals[0] === 'eval') {
    const limit = parseLimit(values.limit);
    return {
      kind: 'eval',
      json: values.json === true,
      ...(typeof values['judge-model'] === 'string' ? { judgeModel: values['judge-model'] } : {}),
      ...(typeof values['produce-model'] === 'string' ? { produceModel: values['produce-model'] } : {}),
      suggest: values.suggest === true,
      repoPath,
      ...(limit !== undefined ? { limit } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
    };
  }

  if (positionals[0] === 'gc') {
    const hours = Number(values['max-age-hours']);
    const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
    return {
      kind: 'gc',
      repoPath,
      maxAgeMs,
      dryRun: values['dry-run'] === true,
      abandoned: values.abandoned === true,
      ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
    };
  }

  if (positionals[0] === 'hub') {
    const hostRaw = typeof values.host === 'string' ? values.host : process.env.VANGUARD_HUB_HOST;
    const host = hostRaw !== undefined && hostRaw.trim() !== '' ? hostRaw : DEFAULT_HUB_HOST;

    const portRaw = typeof values.port === 'string' ? values.port : undefined;
    let port: number;
    if (portRaw !== undefined) {
      const parsed = Number(portRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return fail(`--port expects an integer between 1 and 65535, got "${portRaw}".`);
      }
      port = parsed;
    } else {
      const envPort = Number(process.env.VANGUARD_HUB_PORT);
      port = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : DEFAULT_HUB_PORT;
    }

    return {
      kind: 'hub',
      repoPath,
      host,
      port,
      ...(typeof values['ui-dir'] === 'string' ? { uiDir: values['ui-dir'] } : {}),
      open: values['no-open'] !== true,
      ...(allowedHosts?.length ? { allowedHosts } : {}),
    };
  }

  const proxyMode = values['llm-proxy'] === true;
  // Skipped when the provider is a (possible) custom name: this call dereferences the built-in
  // table and the customs live on disk, invisible to the sync parser. The dispatch entry point
  // re-runs it with the loaded customs BEFORE any sandbox cost (run.ts/watch.ts). reviewProvider
  // cannot be non-built-in (gate above), so built-in pairs keep failing right here at parse.
  if (provider === undefined || isProviderName(provider)) {
    try {
      validateProviderChoice(
        {
          ...(provider !== undefined ? { provider } : {}),
          ...(reviewProvider !== undefined ? { reviewProvider } : {}),
          ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
        },
        { proxyMode },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (positionals[0] === 'review-pr') {
    // Accept the PR ref as a positional, --github-pr <n>, or --github <ref> — the last for parity with
    // spec/run/research, which all take --github (a natural thing to reach for).
    const prRef =
      typeof values['github-pr'] === 'string'
        ? values['github-pr']
        : typeof values.github === 'string'
        ? values.github
        : positionals[1];
    if (prRef === undefined) {
      return fail('review-pr requires a PR reference: a URL, owner/repo#number, --github <ref>, or --github-pr <number>.');
    }
    return {
      kind: 'review-pr',
      prRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
    };
  }

  if (positionals[0] === 'research') {
    const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
    if (issueRef === undefined) return { kind: 'help' };
    return {
      kind: 'research',
      issueRef,
      repoPath,
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(values.web === true ? { webAccess: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['research-model'] === 'string' ? { researchModel: values['research-model'] } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
    };
  }

  if (positionals[0] === 'spec') {
    const issueRef = typeof values.github === 'string' ? values.github : positionals[1];
    if (issueRef === undefined) return { kind: 'help' };
    return {
      kind: 'spec',
      issueRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(typeof values.base === 'string' ? { baseBranch: values.base } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
    };
  }

  if (positionals[0] === 'revise-pr') {
    const prRef =
      typeof values['github-pr'] === 'string'
        ? values['github-pr']
        : typeof values.github === 'string'
        ? values.github
        : positionals[1];
    if (prRef === undefined) return { kind: 'help' };
    const maxRounds = parseLimit(values['max-rounds']);
    const feedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'revise-pr',
      ...(feedbackAuthors !== undefined ? { feedbackAuthors } : {}),
      prRef,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(commitAuthor !== undefined ? { commitAuthor } : {}),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
    };
  }

  if (positionals[0] === 'watch-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return fail('watch-prs requires --github-repo <owner/repo> and --label <name>.');
    const concurrency = Number(values.concurrency);
    const interval = Number(values.interval);
    const prNumber = typeof values.pr === 'string' ? Number(values.pr) : undefined;
    if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
      return fail('watch-prs --pr expects a positive PR number.');
    }
    const prFeedbackAuthors = parseFeedbackAuthors(values['feedback-authors']);
    return {
      kind: 'watch-prs',
      ...(prFeedbackAuthors !== undefined ? { feedbackAuthors: prFeedbackAuthors } : {}),
      repoSlug,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
      ...(typeof values.author === 'string' ? { author: values.author } : {}),
      ...(prNumber !== undefined ? { pr: prNumber } : {}),
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  if (positionals[0] === 'doctor-prs') {
    const repoSlug = typeof values['github-repo'] === 'string' ? values['github-repo'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (repoSlug === undefined || label === undefined) return fail('doctor-prs requires --github-repo <owner/repo> and --label <name>.');
    return {
      kind: 'doctor-prs',
      repoSlug,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_PR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_PR_REVIEWED_LABEL,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
    };
  }

  if (positionals[0] === 'review-mr') {
    const iidRaw = typeof values.mr === 'string' ? Number(values.mr) : undefined;
    const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
    if (iidRaw === undefined || !Number.isInteger(iidRaw) || project === undefined) return { kind: 'help' };
    return {
      kind: 'review-mr',
      iid: iidRaw,
      project,
      repoPath,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  if (positionals[0] === 'watch-mrs' || positionals[0] === 'doctor-mrs') {
    const commandKind = positionals[0];
    const project = typeof values['gitlab-project'] === 'string' ? values['gitlab-project'] : undefined;
    const label = typeof values.label === 'string' ? values.label : undefined;
    if (project === undefined || label === undefined) return { kind: 'help' };
    const concurrency = Number(values.concurrency);
    const interval = Number(values.interval);
    const shared = {
      project,
      repoPath,
      label,
      reviewingLabel: typeof values['reviewing-label'] === 'string' ? values['reviewing-label'] : DEFAULT_GITLAB_MR_REVIEWING_LABEL,
      reviewedLabel: typeof values['reviewed-label'] === 'string' ? values['reviewed-label'] : DEFAULT_GITLAB_MR_REVIEWED_LABEL,
      ...(typeof values.author === 'string' ? { author: values.author } : {}),
      ...(values['llm-proxy'] === true ? { llmProxy: true } : {}),
      ...(builtinProvider !== undefined ? { provider: builtinProvider } : {}),
      ...(typeof values['review-model'] === 'string' ? { reviewModel: values['review-model'] } : {}),
    };
    if (commandKind === 'doctor-mrs') return { kind: 'doctor-mrs', ...shared };
    return {
      kind: 'watch-mrs',
      ...shared,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      egress: values.egress === true,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  // Shared by the two branches below; every command above returned already.
  const runOptions = parseRunOptions(values, {
    provider,
    reviewProvider,
    fallbackProvider,
    fallbackModel,
    commitAuthor,
    flow: flowRaw,
    maxTurns,
    maxRepairIterations,
  });

  if (positionals[0] === 'run') {
    const sources: Array<['linear' | 'github' | 'project' | 'gitlab', string]> = [];
    if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
    if (typeof values.github === 'string') sources.push(['github', values.github]);
    if (typeof values.project === 'string') sources.push(['project', values.project]);
    if (typeof values.gitlab === 'string') sources.push(['gitlab', values.gitlab]);
    // Exactly one source is required.
    const picked = sources[0];
    if (sources.length !== 1 || picked === undefined) {
      return fail('run requires exactly one of --linear <id>, --github <ref>, or --project <number>.');
    }
    if (values.parent === true && picked[0] !== 'linear') {
      return fail('--parent is only supported with --linear.');
    }
    // One spec file cannot describe N different tasks — fan-out modes would inject it into every run.
    if (typeof values['spec-file'] === 'string' && (picked[0] === 'project' || values.parent === true)) {
      return fail('--spec-file is only supported for a single-issue run (not --parent / --project fan-out).');
    }
    if (picked[0] === 'project') {
      const projectNum = Number(picked[1]);
      if (!Number.isInteger(projectNum) || projectNum < 1) {
        return fail(`--project expects a board number, got "${picked[1]}".`);
      }
    }
    const concurrency = Number(values.concurrency);
    const forkN = Number(values.fork);
    const forkScorer = parseForkScorer(values['fork-scorer']);
    if (forkScorer === null) return fail(`--fork-scorer expects llm or decision, got "${String(values['fork-scorer'])}".`);
    if (forkScorer !== undefined && !(Number.isFinite(forkN) && forkN >= 2)) return fail('--fork-scorer only applies with --fork <n> (n>=2).');
    // forkAndSelect runs every variant on the primary agent and returns before the stage fallback is
    // consulted, so the flag would be accepted and silently never fire.
    if (fallbackProvider !== undefined && Number.isFinite(forkN) && forkN >= 2) return fail('--fallback-provider does not apply to --fork variants; drop one of them.');
    // The single-task RunOptions (see RunOnlyKey): typed exhaustively so a new run-only field lands here.
    const runOnly = present<Pick<RunOptions, RunOnlyKey>>({
      forkScorer,
      specFile: typeof values['spec-file'] === 'string' ? values['spec-file'] : undefined,
    });
    return {
      kind: 'run',
      source: picked[0],
      id: picked[1],
      parent: values.parent === true,
      gcBefore: values['gc-before'] === true,
      egress: values.egress === true,
      repoPath,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      ...(proxyMode ? { llmProxy: true } : {}),
      ...(Number.isFinite(forkN) && forkN >= 2 ? { forkN: Math.floor(forkN) } : {}),
      ...(values.reuse === true ? { reuse: true } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(typeof values.label === 'string' ? { label: values.label } : {}),
      ...(typeof values['gitlab-project'] === 'string' && picked[0] === 'gitlab' ? { project: values['gitlab-project'] } : {}),
      ...runOptions,
      ...runOnly,
    };
  }

  if (positionals[0] === 'watch' || positionals[0] === 'doctor') {
    const commandKind = positionals[0];
    const source: WatchSource =
      values.source === 'github' || (values.source === undefined && typeof values['github-repo'] === 'string')
        ? 'github'
        : values.source === 'project'
          ? 'project'
          : values.source === 'gitlab'
            ? 'gitlab'
            : 'linear';
    // project number is required when source === 'project'
    const projectNumber = typeof values.project === 'string' ? Number(values.project) : undefined;
    if (source === 'project' && (projectNumber === undefined || !Number.isFinite(projectNumber))) {
      return fail(`${commandKind} --source project requires --project <number>.`);
    }

    let label = typeof values.label === 'string' ? values.label : undefined;
    let specLabel = typeof values['spec-label'] === 'string' ? values['spec-label'] : undefined;
    let agentLabel = typeof values['agent-label'] === 'string' ? values['agent-label'] : undefined;
    let needsInfoLabel = typeof values['needs-info-label'] === 'string' ? values['needs-info-label'] : undefined;
    let specState = typeof values['spec-state'] === 'string' ? values['spec-state'] : undefined;
    let specStateName = typeof values['spec-state-name'] === 'string' ? values['spec-state-name'] : undefined;
    const agentState = typeof values['agent-state'] === 'string' ? values['agent-state'] : undefined;
    let needsInfoState = typeof values['needs-info-state'] === 'string' ? values['needs-info-state'] : undefined;

    const hasGithubLoopFlags =
      specLabel !== undefined ||
      agentLabel !== undefined ||
      needsInfoLabel !== undefined ||
      typeof values['spec-claimed-label'] === 'string';
    const hasLinearLoopFlags =
      specState !== undefined ||
      specStateName !== undefined ||
      agentState !== undefined ||
      needsInfoState !== undefined ||
      typeof values['spec-claimed-state'] === 'string';
    const repoOnlyGithubLoop =
      source === 'github' && label === undefined && !hasGithubLoopFlags && !hasLinearLoopFlags;
    const isLoopV1 = values['loop-v1'] === true || hasGithubLoopFlags || hasLinearLoopFlags || repoOnlyGithubLoop;

    if (isLoopV1 && (source === 'github' || source === 'gitlab') && hasLinearLoopFlags) {
      return fail('Linear loop-v1 flags (--spec-state etc.) are not compatible with --source github/gitlab.');
    }
    if (isLoopV1 && source === 'linear' && hasGithubLoopFlags) {
      return fail('GitHub loop-v1 flags (--spec-label etc.) are not compatible with --source linear.');
    }
    if (isLoopV1 && (source === 'github' || source === 'gitlab')) {
      specLabel ??= DEFAULT_GITHUB_SPEC_LABEL;
      agentLabel ??= DEFAULT_GITHUB_AGENT_LABEL;
      needsInfoLabel ??= DEFAULT_GITHUB_NEEDS_INFO_LABEL;
    } else if (isLoopV1 && source === 'linear') {
      label ??= DEFAULT_LOOP_V1_OWNERSHIP_LABEL;
      specState ??= DEFAULT_LINEAR_SPEC_STATE;
      specStateName ??= DEFAULT_LINEAR_SPEC_STATE_NAME;
      needsInfoState ??= DEFAULT_LINEAR_NEEDS_INFO_STATE;
    }

    if (isLoopV1) {
      // Loop v1 validation per source.
      if (source === 'github' || source === 'gitlab') {
        if (specLabel === undefined || agentLabel === undefined || needsInfoLabel === undefined) {
          return fail('github/gitlab loop-v1 requires --spec-label, --agent-label, and --needs-info-label.');
        }
        if (source === 'gitlab' && label === undefined) {
          return fail('gitlab loop-v1 requires --label <name>.');
        }
        if (values['spec-only'] === true && sameName(agentLabel, DEFAULT_GITHUB_AGENT_LABEL)) {
          return fail(`${commandKind} --spec-only requires --agent-label <review label> other than "${DEFAULT_GITHUB_AGENT_LABEL}"; that default is the build trigger, so specced issues would get no review window.`);
        }
        if (values['spec-only'] === true && sameName(agentLabel, specLabel)) {
          return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger label "${specLabel}"; set --agent-label to another label, or the spec pass specs the same issues again on every poll.`);
        }
        // --label is an optional extra ownership filter in github loop-v1. A repo-scoped shorthand
        // watches the routing labels directly; explicit --label narrows that further when desired.
      } else if (source === 'linear') {
        if (specState === undefined || specStateName === undefined || needsInfoState === undefined) {
          return fail('--spec-state requires --spec-state-name and --needs-info-state (linear loop-v1).');
        }
        // --label is still the shared ownership label across both passes. Defaults keep the filter,
        // not a status-only scan over the whole Linear workspace.
        if (label === undefined) {
          return fail(`${commandKind} --source linear loop-v1 requires --label <name>.`);
        }
        if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, DEFAULT_LINEAR_AGENT_STATE)) {
          return fail(`${commandKind} --spec-only requires --agent-state <review state> other than "${DEFAULT_LINEAR_AGENT_STATE}"; that default is the build trigger, so specced issues would get no review window.`);
        }
        // The spec pass lists by state TYPE (--spec-state); --spec-state-name is only its revert target. This
        // name check catches the obvious case and assumes --spec-state-name is a state of the --spec-state type.
        if (values['spec-only'] === true && sameName(agentState ?? DEFAULT_LINEAR_AGENT_STATE, specStateName)) {
          return fail(`${commandKind} --spec-only cannot advance specced issues into the spec trigger state "${specStateName}"; set --agent-state to another state, or the spec pass specs the same issues again on every poll.`);
        }
      } else {
        // project source does not support loop-v1
        return fail('loop-v1 is not supported with --source project.');
      }
    } else {
      if (values['spec-only'] === true) {
        return fail(`${commandKind} --spec-only requires loop-v1, which any loop-v1 flag turns on (for example --loop-v1, --spec-state or --spec-label); single-pass watch has no spec pass.`);
      }
      // Existing single-pass validation: label is required for linear/github/gitlab; optional for project.
      if (source !== 'project' && label === undefined) {
        return fail(`${commandKind} --source ${source} requires --label <name>.`);
      }
    }

    const interval = Number(values.interval);
    const concurrency = Number(values.concurrency);
    const maxTasks = parseLimit(values['max-tasks']);
    // A blast-radius cap must not fall through to "process all" on a typo, 0 or a negative.
    if (values['max-tasks'] !== undefined && maxTasks === undefined) {
      return fail(`--max-tasks needs a positive integer, got "${String(values['max-tasks'])}".`);
    }
    // The single-task flags (RunOnlyKey + --fork): on watch each would be a silent no-op or a spurious failure.
    if (values['fork-scorer'] !== undefined) return fail(`--fork-scorer applies to \`run --fork <n>\` only; ${commandKind} does not fork.`);
    if (values.fork !== undefined) return fail(`--fork applies to run only; ${commandKind} does not fork.`);
    if (values['spec-file'] !== undefined) return fail(`--spec-file applies to a single-issue run only; ${commandKind} has no single issue to attach it to.`);
    type WatchCommon = Omit<Extract<Command, { kind: 'watch' }>, 'kind' | 'concurrency' | 'intervalMs' | 'once' | 'egress'>;
    const common: WatchCommon = {
      source,
      repoPath,
      ...(maxTasks !== undefined ? { maxTasks } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(projectNumber !== undefined ? { projectNumber } : {}),
      ...(typeof values['gitlab-project'] === 'string' ? { project: values['gitlab-project'] } : {}),
      ...(typeof values.team === 'string' ? { team: values.team } : {}),
      ...(typeof values['trigger-state'] === 'string' ? { triggerState: values['trigger-state'] } : {}),
      ...(typeof values['trigger-state-name'] === 'string' ? { triggerStateName: values['trigger-state-name'] } : {}),
      ...(typeof values['claimed-state'] === 'string' ? { claimedState: values['claimed-state'] } : {}),
      ...(typeof values['review-state'] === 'string' ? { reviewState: values['review-state'] } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...runOptions,
      ...(proxyMode ? { llmProxy: true } : {}),
      // Loop v1 fields (omitted when not supplied, preserving existing behaviour when absent).
      ...(typeof values['spec-model'] === 'string' ? { specModel: values['spec-model'] } : {}),
      ...(specLabel !== undefined ? { specLabel } : {}),
      ...(agentLabel !== undefined ? { agentLabel } : {}),
      ...(needsInfoLabel !== undefined ? { needsInfoLabel } : {}),
      ...(typeof values['spec-claimed-label'] === 'string' ? { specClaimedLabel: values['spec-claimed-label'] } : {}),
      ...(specState !== undefined ? { specState } : {}),
      ...(specStateName !== undefined ? { specStateName } : {}),
      ...(agentState !== undefined ? { agentState } : {}),
      ...(needsInfoState !== undefined ? { needsInfoState } : {}),
      ...(typeof values['spec-claimed-state'] === 'string' ? { specClaimedState: values['spec-claimed-state'] } : {}),
      ...(values['spec-only'] === true ? { specOnly: true } : {}),
    };

    if (commandKind === 'doctor') {
      // StageOnlyKey: the proof/conformance knobs stay off the doctor command.
      const { visualProofCmd: _visualProofCmd, conformance: _conformance, conformanceModel: _conformanceModel, ...checks } = common;
      return { kind: 'doctor', ...checks, ...(values.fix === true ? { fix: true } : {}) };
    }

    return {
      kind: 'watch',
      ...common,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
      once: values.once === true,
      egress: values.egress === true,
    };
  }

  return { kind: 'help' };
}

/** Option lines run and watch print verbatim — one source, so the two usage blocks cannot drift either. */
const SHARED_RUN_OPTIONS_USAGE = `    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider that runs every stage (default: claude)
                           run/watch/doctor also accept a custom provider name from the repo's
                           .vanguard/app.json customProviders (S6) — direct mode only.
    --review-provider <claude|codex|cursor|zai|openrouter|meridian>   Run only the review stage on this provider (cross-provider review)
    --fallback-provider <name>  Retry on this provider when the primary one fails (outage, limit, revoked credential) — the implementer and every other stage on its provider; must sit on a different transport (e.g. codex for a claude implementer)
    --fallback-model <model>    Model for every stage that fell back (default: that provider's default)
    --provider-model <m>     Model for the implementer/simplifier stages (default: provider's default; zai -> glm-5.2)
    --review-model <m>       Model for the review stage (default: provider's default)
    --escalate-model <m>     Model for the 2nd and later gate repairs, once a repair on the implementer
                             model has failed (default: stay on the implementer model)
    --no-simplify            Skip the simplifier stage (lean: implement -> review only)
    --verify <cmd>           Verification command for Proof of Work (overrides VANGUARD_VERIFY_CMD and auto-detect)
    --visual-proof <cmd>     Visual proof command for UI artifacts (overrides VANGUARD_VISUAL_PROOF_CMD)
    --conformance            Run the conformance pass (planner-tier model checks diff against spec; opt-in)
    --conformance-model <m>  Model for the conformance stage (default: same as implementer; 'opus' for planner-tier)
    --commit-author <a>      Git author for the commit, "Name <email>" (also enables white-label mode: feat/<n> branch, no Vanguard branding/review comment)
    --plan                   Add a dedicated planning stage first (opus, high effort) before implement/review
    --flow <name>            Run a named workflow (e.g. flow-b: plan -> implement -> adversary -> repair). --plan == --flow plan`;

/** Printed after each section's own --base/--max-turns lines. */
const MAX_REPAIR_ITERATIONS_USAGE = '    --max-repair-iterations <n> Override the conformance/verify repair loop-back cap (default: 2)';

export const USAGE = `vanguard <command>

Commands:
  run    Run an agent on a task and open a draft PR for review.
  watch  Poll Linear or GitHub and run each newly-ready issue automatically (the AFK factory loop).
  doctor Check whether watch can run AFK before any issue is claimed.
  review-pr Review an existing GitHub PR and post a non-blocking Vanguard review comment.
  revise-pr Read human review feedback on a Vanguard draft PR, apply fixes, and hand it back ready to merge.
  watch-prs Poll GitHub PRs by label and run the non-blocking Vanguard review loop.
  doctor-prs Check whether watch-prs can run AFK before any PR is claimed.
  review-mr Review an existing GitLab MR and post a non-blocking Vanguard review comment.
  watch-mrs Poll GitLab MRs by label and run the non-blocking Vanguard review loop.
  doctor-mrs Check whether watch-mrs can run AFK before any MR is claimed.
  stats  Aggregate .vanguard/runs/metrics.jsonl into a cost/token/time rollup (per task, per stage,
         per model, probe); --branch reads the durable copy from the metrics branch instead.
  metrics push  Append this checkout's metrics.jsonl lines to the orphan vanguard-metrics branch and
         push, so an ephemeral CI run leaves a durable trace (idempotent; needs push rights).
  approve Compute a deterministic APPROVE/ESCALATE decision for a factory PR from typed facts and the
         base-branch policy; publish a neutral check run + PR comment and record the decision
         (shadow mode: never merges, approves, or edits labels).
  memory Refresh .vanguard/memory/retrospective.md from run artifacts and print it.
  eval   Run the committed eval corpus and print a per-kind pass-rate report.
  gc     Reap stale sandbox containers, prune worktrees, and (with --remote) delete merged
         remote chore/vanguard-* branches.
  hub    Serve the Inspector UI over HTTP/SSE (node:http), backed by a real .vanguard/ directory.

  watch options (trigger = state/label + label):
    --source <linear|github|project|gitlab>  Task source (default: linear)
    --label <name>         Required for linear/github; optional label-filter for project
    --team <KEY>           (linear) limit to a team
    --github-repo <o/r>    (github/project) repo slug (default: detected from origin)
    --project <number>     (project) GitHub Projects v2 project number (required with --source project)
    --trigger-state <x>    Status option name for ready items (project default: "Todo";
                           linear: state type, default "unstarted")
    --trigger-state-name <x>
                           Linear display state name matching --trigger-state; used to restore
                           no-change issues (default for Linear single-pass: "Todo")
    --claimed-state <x>    Status/label set on claim (project default: "In Progress";
                           linear: state default "In Progress"; github: label "vanguard:running")
    --review-state <x>     Status/label set after a PR opens (project default: "In Review";
                           linear: "In Review"; github: "vanguard:needs-human-review")
    --interval <seconds>   Poll interval (default: 60); --once does a single pass
    --max-tasks <n>        Cap the ready tasks claimed and processed per poll, for each phase
                           (spec, then agent); the rest stay unclaimed for the next poll
                           (default: unlimited)
    --loop-v1              Use Loop v1 defaults (GitHub labels "ready for spec"/"ready for agent"/
                           "needs info"; Linear ownership label "vanguard", state type "triage",
                           state name "Spec", needs-info state "Needs Info"). For GitHub, a repo-only
                           watch without --label also uses the routing-label defaults.
    --skills <dir> --repo <path> --concurrency <n> --egress   (as for run)
${SHARED_RUN_OPTIONS_USAGE}
    --base <branch>          Base branch to branch off and target the PR at; also the loop-v1 spec pass's research baseline (default: main)
    --max-turns <n>            Override the implementer (or loop-v1 spec pass's tech-spec) stage turn cap (default: 30; opt-in, higher cost)
${MAX_REPAIR_ITERATIONS_USAGE}
    Note (project): Status option names must match the project's Status field exactly.
      Resolve field and option IDs with: gh project field-list <number> --owner <owner> --format json

  watch loop-v1 options (add --loop-v1 or any routing flag to activate; spec pass runs first each tick):
    GitHub loop-v1 (--source github):
      --spec-label <name>        Label that triggers the spec pass (e.g. "ready for spec")
      --agent-label <name>       Label set after spec generation — the agent-pass trigger (e.g. "ready for agent")
      --needs-info-label <name>  Label set when a ticket is too vague for spec or agent (e.g. "needs info")
      --label <name>             OWNERSHIP label: issues must carry this label in addition to the routing label
                                 (e.g. "vanguard"; optional for repo-scoped GitHub watch).
                                 --claimed-state / --review-state still apply to the agent pass.
      --spec-claimed-label <l>   Label the spec pass moves a claimed issue to while speccing
                                 (default: "vanguard:speccing"); use this if your workspace uses a different label.

    Linear loop-v1 (--source linear):
      --spec-state <type>        State TYPE that triggers the spec pass (e.g. "triage")
      --spec-state-name <name>   Display NAME of that state, for failure revert (e.g. "Spec")
      --needs-info-state <name>  State NAME for tickets that are too vague (e.g. "Needs Info")
      --agent-state <name>       State NAME the spec pass advances to (default: "Todo"); the agent
                                 triggers on the TYPE given by --trigger-state (default: "unstarted")
      --spec-claimed-state <s>   State NAME the spec pass moves a claimed issue to while speccing
                                 (default: "Speccing"); use this if your workspace lacks that state.
      (--label, --trigger-state, --claimed-state, --review-state still apply to the agent pass)

    Shared:
      --spec-model <m>           Cheap model for the spec-generation stage (e.g. "haiku")
      --spec-only                Run only the spec pass each tick; never list, claim or run the agent pass
                                 (works with --once; --max-tasks then caps the spec pass only). Flags only the
                                 agent pass reads (--claimed-state, --review-state, --plan, --flow, ...) have no effect.
                                 Review window: a spec-only job advances specced issues to a review state/label
                                 (--agent-state/--agent-label), a human moves approved ones to the agent trigger,
                                 and a separate single-pass watch builds them. --spec-only requires --agent-state
                                 (Linear) or --agent-label (GitHub/GitLab) other than the default build trigger,
                                 which would give no review window. Only the default is checked: Vanguard cannot
                                 see a build job that triggers on another state or label. On Linear both passes
                                 list issues by state type, so the review state's type must differ from the
                                 --spec-state type (or it is specced again on every poll) and from the build job's
                                 trigger type (unstarted by default). With the default --spec-state triage, use a
                                 backlog-type review state. On GitHub/GitLab the build job's --label must be the
                                 approval label a human applies (e.g. "ready for agent"), not the loop-v1 ownership
                                 --label: the spec pass leaves that label on every issue, so a build job on it would
                                 also build issues in review and issues not yet specced.

    Example (GitHub, defaults):
      vanguard watch --source github --github-repo owner/repo

    Example (GitHub, custom labels/model):
      vanguard watch --source github --github-repo owner/repo --label vanguard \\
        --agent-label "ready for agent" --spec-label "ready for spec" \\
        --needs-info-label "needs info" --spec-model haiku

    Example (Linear, defaults):
      vanguard watch --loop-v1 --label vanguard

    Example (Linear, custom state names/model):
      vanguard watch --loop-v1 --label vanguard --spec-state triage --spec-state-name Spec \\
        --needs-info-state "Needs Info" --agent-state Todo --spec-model haiku

  run options (exactly one source):
    --linear <ID>          Run a Linear issue (reads it via the in-sandbox linear-cli skill)
    --github <owner/repo#n> Run a GitHub issue
    --gitlab <group/project#n> Run a GitLab issue
    --project <number>     Run every issue on a GitHub Projects v2 board (one run + PR each)
    --parent               (Linear) fan the issue's sub-tasks out, one run + PR each
    --label <name>         (project) only run board items with this label
    --gc-before            Reap stale sandboxes + prune worktrees before starting (clean slate)
    --egress               Restrict sandbox egress to an allowlist (anthropic/github/linear/registries)
    --llm-proxy            Hold the Anthropic credential in a trusted sidecar; the sandbox gets only a per-run nonce (implies --egress, Claude + Codex; Cursor stays direct)
    --reuse                Reuse an existing chore/vanguard-<taskId>-* branch/worktree instead of minting a new run id
    --repo <path>          Local git repo to work in (default: cwd)
    --skills <dir>         Skills directory to inject (Linear: the linear-cli skill); the repo's .github/vanguard-skills/ is merged in
    --github-repo <o/r>    GitHub repo slug (default: detected from origin)
    --concurrency <n>      (parent/project) max tasks at once (default: 2)
${SHARED_RUN_OPTIONS_USAGE}
    --base <branch>          Base branch to branch off and target the PR at (default: main)
    --max-turns <n>            Override the implementer stage turn cap (default: 30; opt-in, higher cost)
${MAX_REPAIR_ITERATIONS_USAGE}
    --fork <n>               Run the implementer as n variants (n>=2) and keep the best-scored diff
    --fork-scorer <llm|decision>  How --fork variants are scored: a one-shot LLM verdict (default) or a
                             decision model (clef; needs CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_AUTH_TOKEN or VANGUARD_DECISION_URL)
    --feedback-authors <a,b> Extra GitHub/GitLab logins whose PR feedback and <spec_manifest>/<tech_spec> comments are trusted, beyond OWNER/MEMBER/COLLABORATOR and the issue author (pass the workflow's allowed-actors here)
    --spec-file <file>       Inject a local spec file as a virtual issue comment (implementer + conformance read it; nothing is posted to the tracker)

  review-pr options:
    <url-or-number>        GitHub PR URL, owner/repo#number, or bare number with --github-repo
    --github <ref>         PR ref (alternative to positional; same as spec/run/research)
    --github-pr <n>        PR number (alternative to positional)
    --github-repo <o/r>    Required for bare PR numbers
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider used for the PR review (default: claude)
    --review-model <m>     Model for the PR review
    --max-turns <n>        Agent CLI turn cap for the first review attempt (default: ${DEFAULT_REVIEW_MAX_TURNS}; opt-in, higher cost).
                           Tool calls count as turns. The retry after an incomplete review gets 1.5x
    --out <file>           Write the review to this local file instead of posting a PR comment (no trace on the tracker)
    --egress --llm-proxy --skills <dir> --repo <path>  As for run/watch (--skills: the repo's .github/vanguard-skills/ is merged in)

  research options:
    <owner/repo#number>     GitHub issue to research
    --github <ref>          Issue ref (alternative to positional)
    --github-repo <o/r>     Required for bare issue numbers
    --web                   Declare that web egress/search is available; otherwise comments say model-knowledge only
    --research-model <m>    Model for the research pass
    --commit-author <a>     White-label the comment (drop "Vanguard" heading/marker); the author value is unused
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider used for research (default: claude)
    --egress --llm-proxy --repo <path>         As for run/watch

  spec options:
    <owner/repo#number>     GitHub issue to spec: researches the codebase read-only and posts a tech-spec comment on the issue. One-shot — no labels are read or written (unlike the watch spec pass)
    --github <ref>          Issue ref (alternative to positional)
    --github-repo <o/r>     Required for bare issue numbers
    --spec-model <m>        Model for the tech-spec stage (e.g. a planner-tier model)
    --max-turns <n>         Override the tech-spec stage turn cap (default: 30; opt-in, higher cost)
    --base <branch>         Branch to research against — the "baseline" the spec is written from (default: main)
    --out <file>            Write the spec to this local file instead of posting an issue comment (pairs with run --spec-file)
    --commit-author <a>     White-label the comment (drop the "Vanguard" heading); the author value is unused
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider used for the spec pass (default: claude)
    --egress --llm-proxy --skills <dir> --repo <path>  As for run/watch (--skills: the repo's .github/vanguard-skills/ is merged in)

  revise-pr options:
    <url-or-number>        GitHub PR URL, owner/repo#number, or bare number with --github-repo
    --github <ref>         PR ref (alternative to positional; same as spec/run/review-pr)
    --github-pr <n>        PR number (alternative to positional)
    --commit-author <a>    White-label: author the revision commits as this identity and drop the "vanguard" token from the revision marker (for client repos)
    --out <file>           Dry-run: write the diff + proposed thread replies to this file; push and comment NOTHING (review, then re-run without --out to apply)
    --github-repo <o/r>    Required for bare PR numbers
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider for the implementer/review stages (default: claude)
    --fallback-provider <name>  Retry on this provider when the primary one fails (outage, limit, revoked credential, rate limit) — must sit on a different transport
    --fallback-model <model>    Model for every stage that fell back (default: that provider's default)
    --review-model <m>     Model for the review stage
    --feedback-authors <a,b> Extra GitHub/GitLab logins whose PR feedback and <spec_manifest>/<tech_spec> comments are trusted, beyond OWNER/MEMBER/COLLABORATOR and the issue author (pass the workflow's allowed-actors here)
    --max-rounds <n>       Maximum revision rounds (default: 2)
    --egress --llm-proxy --skills <dir> --repo <path>  As for run/watch (--skills: the repo's .github/vanguard-skills/ is merged in)

    Triggered by the "needs revision" label on a Vanguard draft PR. Reads feedback from
    review threads, review summaries, and PR comments; applies fixes to the existing PR branch;
    replies to and resolves addressed threads; un-drafts the PR; and sets the label to
    "vanguard:needs-human-review" for the next human action.

  watch-prs options:
    --github-repo <o/r>    Required repo slug
    --label <name>         Required trigger label (e.g. "ready for vanguard review")
    --reviewing-label <l>  Label added while a PR is being reviewed (default: "vanguard:reviewing")
    --reviewed-label <l>   Label added after review succeeds (default: "vanguard:reviewed")
    --author <login>       Only review PRs opened by this GitHub login (self-review-only when set)
    --feedback-authors <a,b> PR authors trusted beyond OWNER/MEMBER/COLLABORATOR; a PR by anyone else
                           is skipped (pass the workflow's allowed-actors here)
    --pr <number>          Also review this PR even if the label scan misses it (label-triggered
                           CI runs pin the event's PR automatically via GITHUB_EVENT_PATH)
    --interval <seconds>   Poll interval (default: 60); --once does a single pass
    --concurrency <n>      Max PRs reviewed at once (default: 2)
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider used for PR review (default: claude)
    --review-model <m>     Model for the PR review
    --max-turns <n>        As for review-pr
    --egress --llm-proxy --skills <dir> --repo <path>  As for run/watch (--skills: the repo's .github/vanguard-skills/ is merged in)

    Example:
      vanguard watch-prs --github-repo owner/repo --label "ready for vanguard review"

    Dedupe: successful Vanguard reviews include a hidden head SHA marker; watch-prs skips
      the same PR commit if the trigger label is re-added accidentally. The PR pinned by --pr or
      the triggering label event is always reviewed, and incomplete notices carry no marker, so a
      failed review is retried on the next re-label or sweep. Only markers from trusted authors
      (repo members, --feedback-authors, Vanguard's bot) count.

  doctor-prs options:
    Uses the same repo and label routing flags as watch-prs, but only runs AFK preflight checks and exits.
    Example:
      vanguard doctor-prs --github-repo owner/repo --label "ready for vanguard review"

  review-mr options:
    --mr <iid>               GitLab MR IID (integer)
    --gitlab-project <g/p>   GitLab project path (required, e.g. group/project)
    --provider --review-model --max-turns --egress --llm-proxy --skills --repo  As for review-pr

  watch-mrs options:
    --gitlab-project <g/p>   Required project path (e.g. group/project)
    --label <name>           Required trigger label (e.g. "ready for review")
    --reviewing-label <l>    Label added while an MR is being reviewed (default: "vanguard::reviewing")
    --reviewed-label <l>     Label added after review succeeds (default: "vanguard::reviewed")
    --author <username>      Only review MRs opened by this GitLab username
    --interval <seconds>     Poll interval (default: 60); --once does a single pass
    --concurrency <n>        Max MRs reviewed at once (default: 2)
    --provider <claude|codex|cursor|zai|openrouter|meridian>          Provider used for MR review (default: claude)
    --review-model <m>       Model for the MR review
    --max-turns <n>          As for review-pr
    --egress --llm-proxy --skills <dir> --repo <path>  As for run/watch (--skills: the repo's .github/vanguard-skills/ is merged in)

    Example:
      vanguard watch-mrs --gitlab-project group/project --label "ready for review"

  doctor-mrs options:
    Uses the same flags as watch-mrs, but only runs AFK preflight checks and exits.
    Example:
      vanguard doctor-mrs --gitlab-project group/project --label "ready for review"

  watch options (--source gitlab):
    --source gitlab              GitLab issue watch source
    --gitlab-project <g/p>       Required: GitLab project path (e.g. group/project)
    --label <name>               Trigger label; issues must carry this label
    --claimed-state / --review-state still apply (label-based, as for --source github).
    GitLab boards are label-based — use --source gitlab --label <column-label> to watch a board column.
    Example:
      vanguard watch --source gitlab --gitlab-project group/project --label vanguard

  gc options:
    --repo <path>          Git repo to prune worktrees / reap branches in (default: cwd)
    --max-age-hours <n>    Only reap resources older than n hours (default: 6). Does not apply
                           to empty egress networks: they are reaped after 10 minutes
    --remote <owner/repo>  Also delete merged remote chore/vanguard-* branches (needs gh)
    --dry-run              List what would be reaped without removing anything
    --abandoned            Also delete branches whose PR is closed-unmerged (not just merged)

  stats options:
    --repo <path>          Repo whose .vanguard/runs/metrics.jsonl to read (default: cwd)
    --branch <name>        Read metrics.jsonl from this remote branch instead (what 'metrics push' wrote;
                           default name: vanguard-metrics)
    --json                 Emit the aggregated report as JSON instead of tables

  metrics push options:
    --repo <path>          Repo whose .vanguard/runs/metrics.jsonl to persist (default: cwd)
    --branch <name>        Target branch (default: vanguard-metrics)

  approve options:
    --pr <n>               Required: PR number (bare positional also accepted)
    --github-repo <o/r>    Required repo slug — the approver never infers the repo it judges
    --mode <shadow>        Only "shadow" is implemented in v1
    --repo <path>          Local git repo checked out from the base branch (default: cwd)
    --branch <name>        Metrics branch override (default: vanguard-metrics)
    --json                 Print the decision record to stdout
    --dry-run              Compute and print the decision; publish and record nothing (backtest/local inspection)

  memory options:
    --repo <path>          Repo to read run artifacts from (default: cwd)
    --limit <n>            Max entries to keep in the report (default: 10)
    --json                 Emit the raw report object as JSON instead of markdown

  eval options:
    --json                   Emit the raw EvalReport as JSON instead of a table
    --judge-model <m>        Model used to judge agent outputs (default: pinned claude-haiku-4-5-20251001; override for
                             experiments; clef|clef-flash judges with a decision model — calibrated probabilities, no JSON to parse)
    --produce-model <m>      Model under test whose outputs are judged (default: claude-sonnet-5-5)
    --suggest                Draft eval-corpus candidates from retrospective memory (suggest-only; never writes the corpus)
    --repo <path>            Repo to read run artifacts from (with --suggest; default: cwd)
    --limit <n>              Max retrospective entries to consider (with --suggest; default: 10)
    --out <path>             Also write drafts to this scratch file (refuses paths under src/evals/corpus/)

    Temperature note: the claude CLI exposes no --temperature flag; run the suite 3× on a known-good
    state to measure pass-rate variance before relying on absolute regression thresholds (phase 2).

  doctor options:
    Uses the same source/routing flags as watch, but only runs AFK preflight checks and exits.
    Like watch, it rejects the run-only flags --fork, --fork-scorer and --spec-file.
    Add --spec-only to check a spec-only loop-v1 watch: it skips the checks that only guard publishing.
    Example (GitHub): vanguard doctor --source github --github-repo owner/repo
    Example (Linear): vanguard doctor --loop-v1 --label vanguard --skills ./skills

Env: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (auth); LINEAR_API_KEY (for --linear);
     GITLAB_TOKEN (auth for glab; GITLAB_HOST for self-hosted GitLab instances);
     CODEX_API_KEY / CURSOR_API_KEY (when --provider/--review-provider selects codex/cursor;
       under --llm-proxy the Codex/OpenAI key is held by the sidecar and the sandbox gets a nonce,
       while Cursor's key is still injected directly);
     ZAI_API_KEY (when --provider/--review-provider selects zai; runs the Claude Code CLI against
       z.ai's GLM Coding Plan endpoint, so no Anthropic token is required. Under --llm-proxy the
       z.ai key is held by the sidecar and the sandbox gets a nonce);
     VANGUARD_VERIFY_CMD (verification command for Proof of Work; overridden by --verify);
     VANGUARD_VISUAL_PROOF_CMD (visual proof command for UI artifacts; overridden by --visual-proof).
`;
