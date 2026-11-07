import { commitStage } from '../pipeline/pipeline.js';
import { publishForReview, pushToExistingBranch } from '../pipeline/remote-branch.js';
import {
  INJECTED_REDACTION,
  injectedLineSuffix,
  injectedSecretValues,
  redactInjectedSecrets,
  scanForInjectedSecrets,
  scanForSecrets,
} from '../core/secret-scan.js';
import { scanCommitClosingKeywords } from '../pipeline/conformance-gate.js';
import type { SecretBlock } from '../core/secret-scan.js';
import type { CommitClosingLeak } from '../pipeline/conformance-gate.js';
import type { RunContext } from '../core/vanguard.js';
import type { CommandRunner, PublishOptions } from '../pipeline/remote-branch.js';

/**
 * Deliver a reviewed change: the one place that turns a finished worktree into something on the
 * remote. Order is fixed and is the point: secret scan on the outgoing diff (nothing with a secret
 * ever reaches a commit), commit, closing-keyword scan of the new commits, then either open a new
 * PR/MR (first delivery) or push onto the existing PR branch (revision). Both runners call this; the
 * invariants live here and nowhere else.
 */

export interface CommitAuthor {
  name: string;
  email: string;
}

export type DeliveryTarget =
  | {
      kind: 'new-pr';
      /** Prefixed with a Conventional-Commits type (see conventionalPrTitle) before the PR is opened. */
      title: string;
      /** `true` when the issue carries a `bug` label: picks `fix:` over the default `feat:`. */
      bugLabel?: boolean;
      /** Optional Conventional-Commits scope, e.g. the spec's primary module (`runners`, `hub`). */
      scope?: string;
      /** Built after the commit so it can carry the closing-keyword leaks found in the new commits. */
      body: (info: { commitLeaks: CommitClosingLeak[]; outgoingDiff: string }) => string;
      draft?: boolean;
      cli?: PublishOptions['cli'];
      prToken?: PublishOptions['prToken'];
      /** Injected git/gh runner (tests). */
      runner?: CommandRunner;
    }
  | {
      kind: 'existing-branch';
      prHeadRef: string;
      pushToken?: string;
      host?: string;
      runner?: CommandRunner;
    };

export interface DeliverChangeOptions {
  /** Task id for log lines and the closing-keyword scan. */
  taskId: string;
  commitMessage: string;
  /** White-label identity for the commit and the pre-push rebase; default Vanguard. */
  commitAuthor?: CommitAuthor;
  target: DeliveryTarget;
  /** Scan the new commits (`ctx.startRef..HEAD`) for `Closes #N` (a partial delivery must not auto-close). */
  closingKeywordScan?: boolean;
  /**
   * Extra env var names holding credentials this run injected, beyond the ones the gate knows
   * statically — a custom provider's `keyEnv` is repo-configured (registry.providerKeyEnvNames).
   */
  secretEnvVars?: readonly string[];
}

export type DeliverChangeResult =
  | { kind: 'secret-blocked'; block: SecretBlock }
  | { kind: 'no-changes' }
  /** new-pr: the branch was pushed and a PR/MR opened; headSha is the pushed head (rebase may have rewritten the commit). */
  | { kind: 'delivered-pr'; sha: string; headSha: string; prUrl: string; commitLeaks: CommitClosingLeak[] }
  /** existing-branch: the commit was pushed onto the PR head. */
  | { kind: 'delivered-push'; sha: string; headSha: string; commitLeaks: CommitClosingLeak[] };

const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const CONVENTIONAL_PREFIX_RE = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(\\([^)]+\\))?!?:\\s`);

/**
 * Prefix a PR title with a Conventional-Commits type so the squash-merge commit on `main` carries
 * one too: release-please reads the squash commit's title (not the PR body) to pick a changelog
 * section and bump, and a factory PR titled straight from the issue (`Run detail never shows … (#487)`)
 * has none. Idempotent: a title that already starts with a valid `type(scope)?: ` prefix is returned
 * unchanged, so re-deriving a title (e.g. on a later retitle) never double-prefixes or drops one a
 * human already set.
 */
export function conventionalPrTitle(title: string, opts: { bugLabel?: boolean; scope?: string } = {}): string {
  if (CONVENTIONAL_PREFIX_RE.test(title)) return title;
  const type = opts.bugLabel === true ? 'fix' : 'feat';
  const scope = opts.scope !== undefined && opts.scope !== '' ? `(${opts.scope})` : '';
  return `${type}${scope}: ${title}`;
}

/**
 * The secret gate: scan an outgoing diff, log the masked findings, and return the block to report.
 * Nothing with a secret ever reaches a commit; a scan error blocks too, as a precaution. Exported so a
 * caller that must gate earlier than the commit (revise's --out preview) runs the same scan.
 *
 * Two layers run here: the pattern scan (scanForSecrets — exempts TEST_PATH_RULES and allowlist
 * markers) and an exact-value check against every secret Vanguard itself injected into the sandbox for
 * this run (scanForInjectedSecrets — ignores both exemptions, since a value match IS the credential).
 * `secretEnvVars` names credentials the static list cannot know (a custom provider's `keyEnv`).
 */
export function scanOutgoingForSecrets(
  outgoing: string,
  taskId: string,
  phase: 'publish' | 'revise push' = 'publish',
  secretEnvVars: readonly string[] = [],
): SecretBlock | undefined {
  try {
    const values = injectedSecretValues(process.env, secretEnvVars);
    const findings = scanForSecrets(redactInjectedSecrets(outgoing, values));
    const injected = scanForInjectedSecrets(outgoing, values);
    if (findings.length === 0 && injected.length === 0) return undefined;
    if (findings.length > 0) {
      console.error(
        `vanguard: secret scan blocked ${phase} for ${taskId}:`,
        findings.map((f) => `${f.file} [${f.patternName}] ${f.masked}`).join('; '),
      );
    }
    if (injected.length > 0) {
      console.error(
        `vanguard: secret scan blocked ${phase} for ${taskId} (exact match on an injected credential):`,
        injected.map((f) => `${f.file}${injectedLineSuffix(f)}`).join('; '),
      );
    }
    return { reason: 'findings', findings, ...(injected.length > 0 ? { injected } : {}) };
  } catch (err) {
    console.error(`vanguard: secret scan failed for ${taskId}, blocking ${phase} as a precaution:`, err);
    return { reason: 'scan-error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function deliverChange(ctx: RunContext, opts: DeliverChangeOptions): Promise<DeliverChangeResult> {
  // Gate before the commit: a push happens before any label can be attached, so the raw secret must
  // never reach a commit in the first place. Always the worktree's own diff — never a caller's snapshot —
  // rendered as text throughout, so an agent-written .gitattributes cannot hide a file from the scan.
  const secretEnvVars = opts.secretEnvVars ?? [];
  const outgoingDiff = await ctx.wm.outgoingDiff(ctx.worktreePath);
  const block = scanOutgoingForSecrets(
    outgoingDiff,
    opts.taskId,
    opts.target.kind === 'new-pr' ? 'publish' : 'revise push',
    secretEnvVars,
  );
  if (block !== undefined) return { kind: 'secret-blocked', block };

  // The commit message, the PR title (including its scope) and the PR body are composed from
  // agent/issue text too, so the same injected credentials can ride out through them. They are not a
  // diff to gate: redact in place, and log that it happened as a count only — never the value.
  const secretValues = injectedSecretValues(process.env, secretEnvVars);
  const redact = (text: string, field: 'commit message' | 'PR title' | 'PR body'): string => {
    const redacted = redactInjectedSecrets(text, secretValues);
    const count = redacted.split(INJECTED_REDACTION).length - text.split(INJECTED_REDACTION).length;
    if (count > 0) {
      console.error(`vanguard: redacted ${count} injected credential occurrence(s) from the ${field} for ${opts.taskId} (values withheld)`);
    }
    return redacted;
  };
  const identity = opts.commitAuthor !== undefined ? { authorName: opts.commitAuthor.name, authorEmail: opts.commitAuthor.email } : {};
  const commit = await commitStage(ctx, { message: redact(opts.commitMessage, 'commit message'), ...identity });
  if (!commit.committed) return { kind: 'no-changes' };
  const sha = commit.sha ?? 'unknown';

  // A rebase merge closes the issue per commit message regardless of the PR body, so a partial
  // result surfaces any commit-level `Closes #N` as a blocking warning in the body.
  const commitLeaks = opts.closingKeywordScan === true
    ? scanCommitClosingKeywords(await ctx.wm.commitMessages(ctx.worktreePath, ctx.startRef), opts.taskId)
    : [];

  const { target } = opts;
  if (target.kind === 'new-pr') {
    const pr = await publishForReview(ctx, {
      title: redact(conventionalPrTitle(target.title, target), 'PR title'),
      body: redact(target.body({ commitLeaks, outgoingDiff }), 'PR body'),
      ...(target.draft !== undefined ? { draft: target.draft } : {}),
      ...(target.cli !== undefined ? { cli: target.cli } : {}),
      ...(target.prToken !== undefined ? { prToken: target.prToken } : {}),
      ...(target.runner !== undefined ? { runner: target.runner } : {}),
      // Same identity as the commit: the pre-push rebase replays the commits.
      ...identity,
    });
    // The pre-push rebase may have rewritten the commit; the review marker must name the pushed head.
    return { kind: 'delivered-pr', sha, headSha: pr.headSha ?? sha, prUrl: pr.prUrl, commitLeaks };
  }
  await pushToExistingBranch(ctx, {
    prHeadRef: target.prHeadRef,
    ...(target.pushToken !== undefined ? { pushToken: target.pushToken, host: target.host ?? 'github.com' } : {}),
    ...(target.runner !== undefined ? { runner: target.runner } : {}),
  });
  return { kind: 'delivered-push', sha, headSha: sha, commitLeaks };
}
