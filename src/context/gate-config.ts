import { execa } from 'execa';
import { diffSections, extractDiffFiles } from '../pipeline/conformance-gate.js';
import { matchGlob } from '../approver/policy.js';

/**
 * A file the verify gate's own repo config touches. `patch` is the file's diff hunk text (one
 * `diff --git ...` block) — only consulted for package.json, to tell a scripts.verify/test/lint/
 * typecheck edit from an unrelated change (e.g. a dependency bump).
 */
export interface GateConfigDiffFile {
  path: string;
  patch?: string | undefined;
}

/**
 * Built-in gate-config path globs — the same mini-glob syntax as the approver's pathRules (see
 * approver/policy.ts#compileGlob). A repo can add to this list via `.vanguard/gate-config.json`
 * (see loadGateConfigExtraGlobs). package.json is handled separately (packageJsonScriptsChanged):
 * whether it counts as gate config depends on which script changed, not just the path.
 */
export const DEFAULT_GATE_CONFIG_GLOBS: readonly string[] = [
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/eslint.config.*',
  '**/.eslintrc*',
  '**/tsconfig*.json',
  '**/.prettierrc*',
  '**/pyproject.toml',
  '**/setup.cfg',
  '**/pytest.ini',
  '**/.coveragerc',
  'skills/**',
  '.github/vanguard-skills/**',
  'skills.lock.json',
  // The list that decides what counts as gate config is gate config itself: narrowing it (or
  // deleting it) weakens every check above, so it goes through the same human gate.
  '.vanguard/gate-config.json',
  // The auto-approver's policy (required checks, path rules, size caps): loosening it is the same
  // kind of change, read by approver/policy.ts.
  '.vanguard/approver.json',
];

const PACKAGE_JSON_PATH = /(^|[\\/])package\.json$/;
/** A changed `"key": "value"` line, with the key and the value captured. */
const CHANGED_STRING_ENTRY_RE = /^[+-]\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** Values a dependency entry can take: semver ranges, tags and protocol specifiers. */
const DEPENDENCY_VALUE_RE = /^(?:[\^~<>=*\d]|v\d|latest$|next$|workspace:|npm:|file:|link:|portal:|patch:|catalog:|git[+:]|github:|https?:)/;
/** Top-level package.json string fields that are not scripts. */
const NON_SCRIPT_KEYS = new Set(['name', 'version', 'description', 'main', 'module', 'browser', 'types', 'typings', 'type', 'license', 'author', 'homepage', 'packageManager', 'private', 'node', 'pnpm', 'npm', 'yarn']);

/**
 * Whether a package.json diff hunk may add, remove or edit a script. Any script counts, not only
 * verify/test/lint/typecheck: npm runs `pretest`/`posttest` around `test`, and a gate script often
 * delegates (`"verify": "pnpm test:unit"`), so an edit to any of them can change what a gate runs.
 * A hunk only carries a few context lines, so it cannot tell which object a line sits in; instead a
 * changed `"key": "value"` line counts unless the value is a dependency specifier or the key a known
 * non-script field. Heuristic, same spirit as the diff-content checks in approver/diff-facts.ts: a
 * dependency bump never matches, and an odd non-script string field may over-match.
 */
export function packageJsonScriptsChanged(patch: string): boolean {
  // A changed line that names the scripts object itself (compact JSON, adding or dropping the block).
  if (/^[+-].*"scripts"\s*:/m.test(patch)) return true;
  return patch.split('\n').some((line) => {
    const m = CHANGED_STRING_ENTRY_RE.exec(line);
    return m !== null && !NON_SCRIPT_KEYS.has(m[1] ?? '') && !DEPENDENCY_VALUE_RE.test(m[2] ?? '');
  });
}

/**
 * The gate-config paths among `files`, sorted. `extraGlobs` (from a repo's own
 * `.vanguard/gate-config.json`) are matched in addition to the built-in list. Empty ⇒ nothing to flag.
 */
export function gateConfigPaths(files: readonly GateConfigDiffFile[], extraGlobs: readonly string[] = []): string[] {
  const globs = [...DEFAULT_GATE_CONFIG_GLOBS, ...extraGlobs];
  return files
    .filter((f) => globs.some((g) => matchGlob(g, f.path)) || (PACKAGE_JSON_PATH.test(f.path) && packageJsonScriptsChanged(f.patch ?? '')))
    .map((f) => f.path)
    .sort();
}

/** Every file a unified diff touches, paired with its own hunk text — the input gateConfigPaths and gateConfigChangedBlock need. */
export function diffFilesWithPatches(diff: string): GateConfigDiffFile[] {
  const sections = diffSections(diff);
  return extractDiffFiles(diff).map((path) => ({ path, patch: sections.get(path) }));
}

const GATE_CONFIG_FILES_LISTED = 20;
const GATE_CONFIG_LINES_PER_FILE = 10;

/** `+`/`-` content lines of a diff hunk, excluding the `+++`/`---` file headers. */
function changedLinesOnly(patch: string): string[] {
  return patch.split('\n').filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
}

/** The longest run of backticks in `text` (0 when it holds none). */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

/**
 * Fence-safe: an agent-written file whose content has a ``` line would close a 3-backtick block and
 * inject PR-body markdown — forging the attestation blocks around this one. Use a fence one backtick
 * longer than the longest run in the content (same as proofBlock in pipeline/verify.ts).
 */
function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
}

/**
 * `text` as a Markdown code span whose delimiter is longer than any backtick run inside it, padded
 * with spaces when it starts or ends with a backtick (CommonMark strips one such pair). A path is
 * agent-written too, so it must not be able to close the span it sits in either.
 */
function codeSpan(text: string): string {
  const delim = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${delim}${pad}${text}${pad}${delim}`;
}

/**
 * PR-body block naming each gate-config file this diff touches, with a bounded excerpt of its
 * changed lines — so a human reviewer sees the weakening (or the justification) without a full
 * diff dump. `files` should already be filtered to the paths gateConfigPaths returned.
 */
export function gateConfigChangedBlock(files: readonly GateConfigDiffFile[]): string {
  if (files.length === 0) return '';
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const shown = sorted.slice(0, GATE_CONFIG_FILES_LISTED);
  const fileLines = shown.flatMap((f) => {
    const lines = changedLinesOnly(f.patch ?? '');
    const changed = lines.slice(0, GATE_CONFIG_LINES_PER_FILE);
    const more = lines.length - changed.length;
    if (changed.length === 0) return [`- ${codeSpan(f.path)}`];
    const fence = fenceFor(changed.join('\n'));
    return [`- ${codeSpan(f.path)}`, `  ${fence}diff`, ...changed.map((l) => `  ${l}`), `  ${fence}`, ...(more > 0 ? [`  …and ${more} more line(s).`] : [])];
  });
  const moreFiles = sorted.length > GATE_CONFIG_FILES_LISTED ? [`…and ${sorted.length - GATE_CONFIG_FILES_LISTED} more file(s).`] : [];
  return [
    '## Gate config changed',
    '',
    "This diff touches checker config the verify gate runs from the agent's own worktree (coverage thresholds, lint rules, type settings, or the verify/test/lint/typecheck scripts). Weakening a check here — lowering a threshold, disabling a rule, relaxing a type setting, loosening a script — is blocking for review unless the linked issue explicitly asked for it.",
    '',
    ...fileLines,
    ...moreFiles,
  ].join('\n');
}

/**
 * Extra gate-config globs from `.vanguard/gate-config.json` (`{ "extraGlobs": string[] }`) on the
 * base branch. Purely additive — a missing file, unreadable ref or malformed JSON all resolve to no
 * extra globs, which only ever narrows detection back to the built-in list, never below it.
 */
export async function loadGateConfigExtraGlobs(repoPath: string, base: string): Promise<string[]> {
  let raw: string;
  try {
    raw = (await execa('git', ['show', `origin/${base}:.vanguard/gate-config.json`], { cwd: repoPath })).stdout;
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { extraGlobs?: unknown };
    return Array.isArray(parsed.extraGlobs) ? parsed.extraGlobs.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}
