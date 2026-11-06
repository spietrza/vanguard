/**
 * Shared credential-pattern set. `redactTokens` masks secrets in text before it is logged or
 * posted as a comment (e.g. codex stdout/stderr); `scanForSecrets` uses the same patterns to gate
 * the outgoing diff before a PR is published. One set, two consumers — never duplicate a pattern.
 */

export interface SecretPattern {
  /** Stable, non-sensitive identifier surfaced in reports/logs, e.g. 'jwt', 'bearer', 'openai-key'. */
  name: string;
  re: RegExp;
  /** Replacement used by redactTokens; removes the matched secret from the output. */
  replacement: string;
  /**
   * Gate-only refinement. When present, scanForSecrets keeps a match ONLY if this returns true,
   * given the matched credential value and the pattern's captured prefix (whose trailing quote,
   * when present, distinguishes a string literal from a bare identifier). redactTokens IGNORES
   * it — over-redacting logs is harmless; under-gating is not. Absent → always kept
   * (JWT/Bearer/sk-/json-token-field detection stays unconditional).
   */
  refine?: (value: string, prefix?: string) => boolean;
}

const ALLOWLIST_MARKER = /(?:vanguard-allow-secret|pragma:\s*allowlist\s*secret|gitleaks:allow)/i;
// An assignment RHS that is a code reference (a member access), not a string literal, is never a
// secret. Covers common request/context/web objects so e.g. `const cookieToken = request.cookies…`
// (a cookie read, not a hardcoded credential) isn't flagged.
const CODE_REFERENCE_PREFIX =
  /^(?:process\.env|import\.meta\.env|os\.environ|req\.|request\.|res\.|response\.|ctx\.|context\.|config\.|this\.|event\.|params\.|props\.|state\.|headers\.|cookies\.|session\.|window\.|document\.|globalThis\.|env\.)/;
// A dotted identifier chain (`opts.pushToken`, `deps.auth.token`) is a code reference, not a
// credential — real secrets never look like short identifier segments joined by dots. JWTs also
// contain dots but their base64url segments don't parse as identifiers (and the unconditional
// `jwt` pattern covers them regardless of this refinement).
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const UPPER_SNAKE_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;
// A bare camelCase identifier (`callbackToken`, `optionalNonEmptyEnvVar`) as an UNQUOTED RHS is a
// code reference, not a literal credential — the assignment regex makes the quote optional, so an
// object entry like `WORKFLOW_CALLBACK_TOKEN: callbackToken,` matches and often clears the entropy
// bar. Letters-only with internal case humps is the identifier signature; digit-bearing values fall
// through to the entropy check, and quoted values (real string literals) never take this branch.
const CAMEL_IDENTIFIER = /^[a-z_$][a-z_$]*(?:[A-Z][A-Za-z_$]*)+$/;
// Suffix restricted to digits-only, letters-only, or separator-led continuation — real secrets
// mix letters and digits together (e.g. 'testAbc123Secret...'), which this deliberately excludes
// so mixed-content values fall through to the entropy check instead of being dismissed outright.
const PLACEHOLDER_VALUE =
  /^(?:changeme|example|placeholder|redacted|your[_-]?|test|dummy|fake|sample|none|null|undefined|true|false)(?:[0-9]*|[a-z]*|[_-]\w*)$/i;
const ANGLE_PLACEHOLDER = /^<.*>$/;
const SAME_CHAR_RUN = /^(.)\1*$/;

/** Minimum bits/char below which an assignment value is treated as low-entropy (dictionary-like), not a real secret. */
const ASSIGNMENT_ENTROPY_THRESHOLD = 3.0;

/** Shannon entropy of a string in bits/char. Higher entropy correlates with random credential material. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Clear "not credential material" signals shared by both gates: placeholder text, a single repeated
 * character, dictionary-level entropy.
 */
function isPlaceholderOrLowEntropy(value: string): boolean {
  if (PLACEHOLDER_VALUE.test(value) || ANGLE_PLACEHOLDER.test(value) || SAME_CHAR_RUN.test(value)) return true;
  return shannonEntropy(value) < ASSIGNMENT_ENTROPY_THRESHOLD;
}

/**
 * Conservative (fail-closed) heuristic for the broad `assignment` pattern: reject only on clear
 * non-secret signals (code/env reference, placeholder text, low entropy). Keeps ambiguous matches
 * as findings. The allowlist marker is handled globally in scanForSecrets, not here.
 */
function isLikelyAssignedSecret(value: string, prefix?: string): boolean {
  if (CODE_REFERENCE_PREFIX.test(value)) return false;
  if (IDENTIFIER_CHAIN.test(value)) return false;
  if (UPPER_SNAKE_IDENTIFIER.test(value)) return false;
  const quoted = prefix !== undefined && /['"]$/.test(prefix);
  if (!quoted && CAMEL_IDENTIFIER.test(value)) return false;
  return !isPlaceholderOrLowEntropy(value);
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Require the full 3-segment JWT structure (header.payload.signature, all base64url). The old
  // `eyJ[A-Za-z0-9._-]{10,}` matched any eyJ-prefixed base64 run and false-positived on package-lock
  // integrity hashes (e.g. pnpm-lock.yaml `integrity: sha512-...eyJ...`), which are content hashes,
  // not secrets. Real JWTs always carry two internal dots; integrity hashes never do.
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replacement: '[REDACTED-JWT]' },
  { name: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: '$1[REDACTED]' },
  {
    name: 'json-token-field',
    re: /("(?:access_token|refresh_token|id_token|OPENAI_API_KEY|api_key)"\s*:\s*")[^"]+"/gi,
    replacement: '$1[REDACTED]"',
  },
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED-KEY]' },
  // Credentials in URL userinfo (`https://oauth2:glpat-…@gitlab.com/g/p.git`, `x-access-token:ghp_…@`):
  // the shape git itself prints in push/fetch errors. Greedy to the last `@` before the path, like
  // redactRemote, so an unencoded `@` in the password cannot leave a fragment. Runs before the bare
  // token patterns so the whole userinfo goes, not just the token inside it.
  // The user part excludes `:` so there is exactly one way to split user:password — the old `[^\s/@]+:`
  // could split at any colon and backtracked quadratically on a long `://a:a:a…` run with no `@`, and
  // redactTokens now runs over whole transcripts. Lengths stay unbounded, so a long password is still masked.
  { name: 'url-userinfo', re: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]*@/gi, replacement: '$1[REDACTED]@' },
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, replacement: '[REDACTED-GH]' },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED-GL]' },
  // Cursor user API keys (`crsr_` + 64 hex): CURSOR_API_KEY rides into the sandbox unproxied.
  { name: 'cursor-key', re: /\bcrsr_[A-Za-z0-9]{32,}/g, replacement: '[REDACTED-CURSOR]' },
  { name: 'basic-auth', re: /(Basic\s+)[A-Za-z0-9+/=]{16,}/g, replacement: '$1[REDACTED]' },
  {
    name: 'assignment',
    re: /((?:token|api[_-]?key|secret|password|auth)\s*[=:]\s*['"]?)([A-Za-z0-9_.~+\-/=]{12,})/gi,
    replacement: '$1[REDACTED]',
    refine: isLikelyAssignedSecret,
  },
];

/** Mask credential material in a string for safe logging. */
export function redactTokens(s: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern.re, pattern.replacement), s);
}

export interface SecretFinding {
  /** Repo-relative path from the diff's `+++ b/<path>` header, or '(unknown)'. */
  file: string;
  /** Pattern name that matched (never the secret value). */
  patternName: string;
  /** A redactTokens-masked excerpt of the offending added line, truncated. */
  masked: string;
}

const MASKED_EXCERPT_MAX_CHARS = 200;
const ADDED_FILE_HEADER = /^\+\+\+ b\/(.+)$/;

// Test/fixture files legitimately carry fake secret material (they exercise this very scanner), and
// are the #1 false-positive source in every regex secret scanner. Exclude them from the publish
// gate — the agent never holds real secrets anyway (nonce/tmpfs/proxy), so a real leak here is
// implausible, and GitHub secret scanning / push protection is the real backstop for prod files.
// One rule per naming convention (mirrors SECRET_PATTERNS above) so each is independently testable
// and adding a new language's convention never grows the others. The `tests/`/`__tests__/` directory
// rule is intentionally broad — it also covers non-test helper modules that sit alongside tests
// (e.g. tests/helpers.py) and carry the same fixture secrets, and is the one that matched the live
// incident path (apps/.../tests/...).
const TEST_PATH_RULES: readonly RegExp[] = [
  /[.-](?:test|spec|fixture)\.[cm]?[jt]sx?$/i, // JS/TS: *.test.ts, *.spec.ts, *.fixture.tsx, *.e2e-spec.ts (+ cjs/mjs)
  /(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$/i, // Python: test_*.py, *_test.py, conftest.py
  /(?:^|\/)(?:tests|__tests__)\//i, // any path under a tests/ or __tests__/ directory
];
export function isTestPath(file: string): boolean {
  return TEST_PATH_RULES.some((re) => re.test(file));
}

/**
 * Scan a unified git diff. Inspects only ADDED lines (lines starting with '+', excluding the
 * '+++' file header). Tracks the current file from '+++ b/<path>' headers so findings carry a path.
 * Added lines in test/fixture files are skipped (they legitimately contain fake secrets), as are
 * lines carrying an ALLOWLIST_MARKER comment.
 */
export function scanForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let currentFile = '(unknown)';
  let currentFileIsTest = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const m = ADDED_FILE_HEADER.exec(line);
      if (m !== null && m[1] !== undefined) currentFile = m[1];
      currentFileIsTest = isTestPath(currentFile);
      continue;
    }
    if (!line.startsWith('+')) continue;
    if (currentFileIsTest) continue;
    const added = line.slice(1);
    if (ALLOWLIST_MARKER.test(added)) continue;
    const matched = SECRET_PATTERNS.filter((pattern) => {
      const refine = pattern.refine ?? (() => true);
      // Check every match on the line, not just the first — a leading placeholder-shaped
      // assignment must not shadow a genuine secret assigned later on the same line.
      for (const m of added.matchAll(pattern.re)) {
        const value = m[m.length - 1] ?? m[0];
        if (refine(value, typeof m[1] === 'string' ? m[1] : undefined)) return true;
      }
      return false;
    });
    if (matched.length === 0) continue;
    const masked = redactTokens(added).slice(0, MASKED_EXCERPT_MAX_CHARS);
    for (const pattern of matched) {
      findings.push({ file: currentFile, patternName: pattern.name, masked });
    }
  }
  return findings;
}

/**
 * Smallest length worth treating as a real secret for the exact-value check below — guards against a
 * short or near-empty env var producing spurious substring hits across an entire diff. Same floor as
 * the `assignment` pattern's value length; every credential Vanguard injects is far longer.
 */
const MIN_INJECTED_SECRET_LENGTH = 12;

/**
 * Is this env value plausibly a real credential? An exact-value hit is unconditional — no allowlist
 * marker or test path suppresses it — so a placeholder or dictionary value in one of the watched vars
 * (a dev/self-hosted `ANTHROPIC_API_KEY=placeholder-value`) would otherwise block every publish whose
 * diff contains that substring, with no escape hatch. Same placeholder/entropy signals the assignment
 * gate uses; real credential material clears them comfortably.
 */
function isPlausibleInjectedSecret(value: string): boolean {
  return value.length >= MIN_INJECTED_SECRET_LENGTH && !isPlaceholderOrLowEntropy(value);
}

/**
 * Env var names Vanguard reads to build the credentials it injects into the sandbox, or uses to push on
 * an agent's behalf: agents/auth.ts (SUBSCRIPTION_ENV/API_ENV), the built-in providers' hostEnv in
 * agents/registry.ts, the tokens glab accepts (cli/preflight.ts GLAB_TOKEN_VARS), tasks/linear-cli.ts /
 * LINEAR_API_KEY, and VANGUARD_PUSH_TOKEN in runners/revise-pr.ts and source-adapter.ts. Named here
 * directly rather than reading the sandbox secrets map, which is assembled per-run deep in the runner
 * call graph and unavailable where the outgoing diff is scanned. A custom provider's `keyEnv` is
 * repo-configured, so no static list can hold it: callers pass those names to injectedSecretValues.
 */
const INJECTED_SECRET_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'MERIDIAN_API_KEY',
  'CODEX_AUTH_JSON',
  'LINEAR_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'OAUTH_TOKEN',
  'CI_JOB_TOKEN',
  'VANGUARD_PUSH_TOKEN',
] as const;

/**
 * Env var names of credentials resolved at run start that the static list cannot know (a custom
 * provider's `keyEnv`). Process-wide and append-only: every default injectedSecretValues() call — the
 * comment transports, failure comments, step summaries — covers them without threading run config.
 * Only names live here; values are still read from the env at each call.
 */
const registeredSecretEnvVars = new Set<string>();

/** Register a run's extra credential env var names (see registeredSecretEnvVars). Called from selectAgents. */
export function registerInjectedSecretEnvVars(names: readonly string[]): void {
  for (const name of names) registeredSecretEnvVars.add(name);
}

/**
 * Collect the secret values Vanguard itself injected into this run's sandbox (or used to push on its
 * behalf), from the env vars it reads to build them plus any `extraEnvVars` the caller resolved for
 * this run (a custom provider's configured `keyEnv`). Exported so a caller snapshots process.env once;
 * tests pass explicit values straight to scanForInjectedSecrets instead of mutating the environment.
 */
export function injectedSecretValues(env: NodeJS.ProcessEnv = process.env, extraEnvVars: readonly string[] = []): string[] {
  const values = [...INJECTED_SECRET_ENV_VARS, ...registeredSecretEnvVars, ...extraEnvVars]
    .map((name) => env[name])
    .filter((v): v is string => v !== undefined && isPlausibleInjectedSecret(v));
  // Codex writes auth.json; agents can copy individual credentials out of it.
  if (env.CODEX_AUTH_JSON !== undefined) {
    try {
      const auth = JSON.parse(env.CODEX_AUTH_JSON) as {
        OPENAI_API_KEY?: unknown;
        tokens?: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
      } | null;
      for (const value of [auth?.OPENAI_API_KEY, auth?.tokens?.access_token, auth?.tokens?.refresh_token, auth?.tokens?.id_token]) {
        if (typeof value === 'string' && isPlausibleInjectedSecret(value)) values.push(value);
      }
    } catch { /* Invalid auth JSON is still checked as a raw value. */ }
  }
  return [...new Set(values)];
}

/**
 * A secret value plus the encodings it is likely to survive in on its way into a diff: base64,
 * URL-encoded, JSON-escaped. Matching any of these is still matching the same credential. Each
 * encoding is the same length as `value` or longer, so none needs a fresh length check.
 */
function secretVariants(value: string): string[] {
  return [...new Set([value, Buffer.from(value, 'utf8').toString('base64'), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])];
}

/** Every encoded variant of every plausible secret value, flattened — order doesn't matter to a caller that just tests inclusion. */
function injectedSecretVariants(secretValues: readonly string[]): string[] {
  return secretValues.filter(isPlausibleInjectedSecret).flatMap(secretVariants);
}

/** What redactInjectedSecrets substitutes for a known credential. Exported so a caller can count substitutions. */
export const INJECTED_REDACTION = '[REDACTED-INJECTED]';

/** Remove known credentials even where the pattern redactor cannot recognize them. */
export function redactInjectedSecrets(text: string, secretValues: readonly string[]): string {
  // Longest first: a shorter variant must not pre-empt a longer one that contains it.
  const variants = injectedSecretVariants(secretValues).sort((a, b) => b.length - a.length);
  for (const variant of variants) {
    text = text.split(variant).join(INJECTED_REDACTION);
  }
  return text;
}

/**
 * Mask agent text before it leaves the host (an issue/PR/MR comment, a run record that may become a CI
 * artifact): exact values of the credentials Vanguard injected first — the patterns cannot recognize an
 * opaque token such as the Codex refresh_token — then the pattern mask. `secretValues` defaults to a
 * fresh snapshot of process.env; a caller that knows a run's custom provider `keyEnv` passes its own.
 */
export function redactForPublish(text: string, secretValues: readonly string[] = injectedSecretValues()): string {
  return redactTokens(redactInjectedSecrets(text, secretValues));
}

export interface InjectedSecretFinding {
  /** Repo-relative path from the diff's `diff --git` / `+++ b/<path>` header, or '(unknown)'. */
  file: string;
  /** 1-based line number in the new file version; absent when the match is in the path itself. */
  line?: number;
}

/** `:<line>`, or '' for a path match that has no line. One place encodes the optional line, for log and comment alike. */
export function injectedLineSuffix(finding: InjectedSecretFinding): string {
  return finding.line !== undefined ? `:${finding.line}` : '';
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_PREFIX = 'diff --git ';
// Greedy old path: the split is the LAST ' b/' in the header, as git itself writes it.
const DIFF_GIT_HEADER = /^diff --git a\/.+ b\/(.+)$/;

/**
 * Exact-value gate on the outgoing diff: does an added line contain a secret Vanguard itself injected
 * into the sandbox (or used to push), byte-for-byte or in an obvious encoding? Unlike scanForSecrets,
 * this is unconditional — it ignores TEST_PATH_RULES and ALLOWLIST_MARKER, because a value match here
 * IS the credential, not a pattern that might merely resemble one. The file PATH is checked too: a
 * credential can be exfiltrated as a filename, where no added line carries it. `+++ b/<path>` alone
 * is not enough for that: `git diff` omits it for a pure rename (`similarity index 100%`) and for a
 * binary file, so the new path is taken from `diff --git a/… b/…`, which precedes every file's
 * remaining headers. Findings never carry the matched value, only file + line, so a hit can be
 * reported without ever printing the secret.
 *
 * Feed it WorktreeManager.outgoingDiff: a plain `git diff` renders a binary file (or one an
 * agent-written `.gitattributes` marks `-diff` / `binary`) as `Binary files … differ` with no content,
 * leaving only its path in reach of this scan; the `--text` rendering exposes every byte.
 */
export function scanForInjectedSecrets(diff: string, secretValues: readonly string[]): InjectedSecretFinding[] {
  const variants = injectedSecretVariants(secretValues);
  if (variants.length === 0) return [];
  const carriesSecret = (text: string): boolean => variants.some((variant) => text.includes(variant));
  const findings: InjectedSecretFinding[] = [];
  // Redacted once per header: every finding reports the path, and none of them may print the secret.
  let currentFile = '(unknown)';
  let newLine = 0;
  let inHunk = false;
  // The same path is announced by several headers (`diff --git` then `+++ b/`): report it once.
  const reported = new Set<string>();
  const notePath = (path: string): void => {
    currentFile = redactInjectedSecrets(path, secretValues);
    if (!carriesSecret(path) || reported.has(currentFile)) return;
    reported.add(currentFile);
    findings.push({ file: currentFile });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      inHunk = false;
      // An unparseable header (a path containing ' b/' splits ambiguously): take it whole (fail closed).
      notePath(DIFF_GIT_HEADER.exec(line)?.[1] ?? line.slice(DIFF_GIT_PREFIX.length));
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const path = ADDED_FILE_HEADER.exec(line)?.[1];
      if (path !== undefined) notePath(path);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null && hunk[1] !== undefined) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (carriesSecret(line.slice(1))) findings.push({ file: currentFile, line: newLine });
      newLine++;
      continue;
    }
    // An empty line is a context line whose leading space some producers strip; counting it keeps the
    // reported line numbers aligned with the new file version.
    if (line.startsWith(' ') || line === '') newLine++;
  }
  return findings;
}

/** Why publish was blocked by the secret scan: real findings, or the scan itself failing (precautionary block). */
export type SecretBlock =
  | { reason: 'findings'; findings: SecretFinding[]; injected?: InjectedSecretFinding[] }
  | { reason: 'scan-error'; message: string };

/** What the block stopped: the first delivery opens a PR; a revision pushes onto an existing one. */
export type SecretBlockStage = 'first-delivery' | 'revision';

const OUTCOME: Record<SecretBlockStage, string> = {
  'first-delivery': 'No PR was opened.',
  revision: 'Nothing was pushed to this branch; the requested changes remain unaddressed.',
};

/**
 * Render the GitHub/GitLab/Linear comment body for a secret-scan block. Uses only
 * `SecretFinding.file/patternName/masked` (already redactTokens-masked) and `InjectedSecretFinding.file/line`
 * (no excerpt at all — an exact-value hit IS the credential) — the raw secret is structurally
 * unreachable — and never interpolates the raw diff or exception payload.
 */
export function renderSecretBlockComment(block: SecretBlock, stage: SecretBlockStage = 'first-delivery'): string {
  const outcome = OUTCOME[stage];
  if (block.reason === 'scan-error') {
    const header =
      '🔒 Vanguard blocked publish as a precaution — the secret scan itself failed to run, so the outgoing ' +
      `diff could not be verified clean. ${outcome}`;
    return [header, '', `Error: ${block.message}`].join('\n');
  }
  const header =
    '🔒 Vanguard blocked publish — the secret scan found credential-shaped content in the outgoing diff. ' +
    `${outcome} Findings are **masked**; review the listed lines.`;
  const lines = [
    ...block.findings.map((f) => `- \`${f.file}\` [${f.patternName}] ${f.masked}`),
    ...(block.injected ?? []).map((f) => `- \`${f.file}\`${injectedLineSuffix(f)} [injected-secret] (exact match — value withheld)`),
  ];
  return [header, '', ...lines].join('\n');
}
