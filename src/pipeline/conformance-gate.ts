import { z } from 'zod';
import { extractJson } from '../structured/extract.js';
import { StructuredOutputError } from '../core/errors.js';

/** Tag the tech-spec stage wraps its machine-checkable manifest in (see pipeline.ts's prompt). */
export const SPEC_MANIFEST_TAG = 'spec_manifest';

/** Machine-checkable obligations a tech spec declares, emitted as a `<spec_manifest>` JSON block. */
export const specManifestSchema = z.object({
  files: z.array(z.object({ path: z.string(), required: z.boolean().optional() })).optional(),
  tests: z.array(z.object({ id: z.string(), file: z.string(), required: z.boolean().optional() })).optional(),
  acceptance: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        /** Set when the AC defines an artifact (e.g. a pre-change golden file) that must exist post-diff. */
        artifact: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Producer/consumer pairs: if `consumer` is in the diff, `producer` must be too (dangling-consumer check). */
  dependencies: z.array(z.object({ consumer: z.string(), producer: z.string() })).optional(),
});

export type SpecManifest = z.infer<typeof specManifestSchema>;

/** Parse the `<spec_manifest>` block from a tech spec. Returns undefined for legacy specs (no manifest) — never throws, so absence is always advisory-only, never a hard fail. */
export function parseSpecManifest(specText: string): SpecManifest | undefined {
  try {
    return extractJson(specText, SPEC_MANIFEST_TAG, specManifestSchema);
  } catch (err) {
    if (err instanceof StructuredOutputError) return undefined;
    throw err;
  }
}

/**
 * Best-effort Conventional-Commits scope for a PR title: the most common module among the manifest's
 * declared files (the segment after `src/` or `apps/`, else the file's first path segment). Undefined
 * when the manifest declares no files — the scope is optional, never a hard requirement.
 */
export function primaryModuleScope(manifest: SpecManifest | undefined): string | undefined {
  const counts = new Map<string, number>();
  for (const file of manifest?.files ?? []) {
    const parts = file.path.split('/');
    const module = (parts[0] === 'src' || parts[0] === 'apps') && parts[1] !== undefined ? parts[1] : parts[0];
    if (module === undefined || module === '') continue;
    counts.set(module, (counts.get(module) ?? 0) + 1);
  }
  // Map iteration follows insertion (first-seen) order; strict `>` keeps the first-seen module on ties.
  let best: string | undefined;
  let bestCount = 0;
  for (const [module, count] of counts) {
    if (count > bestCount) {
      best = module;
      bestCount = count;
    }
  }
  return best;
}

/** Extract every file path touched by a unified diff (both sides of renames), deduped. */
export function extractDiffFiles(diff: string): string[] {
  const files = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  for (const match of diff.matchAll(re)) {
    if (match[1] !== undefined) files.add(match[1]);
    if (match[2] !== undefined) files.add(match[2]);
  }
  return [...files];
}

/** Split a unified diff into per-file sections, keyed by the (post-image) path. */
export function diffSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = diff.split(/^diff --git /m).slice(1);
  for (const part of parts) {
    const header = part.slice(0, part.indexOf('\n'));
    const match = /^a\/(.+?) b\/(.+)$/.exec(header);
    const path = match?.[2] ?? match?.[1];
    if (path !== undefined) sections.set(path, part);
  }
  return sections;
}

/** Language-agnostic signals that an added diff line introduces test content (not just a modified assertion). */
const TEST_LINE_PATTERNS = [
  /\b(?:it|describe|test)\s*\(/, // JS/TS
  /\bdef\s+test_\w+/, // Python
  /\bfunc\s+Test\w+/, // Go
  /#\[test\]/, // Rust
];

function sectionAddsTestContent(section: string | undefined): boolean {
  if (section === undefined) return false;
  return section
    .split('\n')
    .some((line) => line.startsWith('+') && !line.startsWith('+++') && TEST_LINE_PATTERNS.some((re) => re.test(line)));
}

/** Whether the diff adds new test content to `file` — a new file or new test blocks in an existing one. */
export function diffAddsTestContent(diff: string, file: string): boolean {
  return sectionAddsTestContent(diffSections(diff).get(file));
}

export interface ConformanceGap {
  missingFiles: string[];
  missingTests: { id: string; file: string }[];
  missingArtifacts: { id: string; artifact: string }[];
  danglingConsumers: { consumer: string; producer: string }[];
}

export interface ConformanceResult extends ConformanceGap {
  /** False when there is no manifest to check against (legacy spec / no spec) — always advisory-only then. */
  checked: boolean;
  pass: boolean;
  /** Optional (required:false) manifest entries absent from the diff — for checklist annotation only; never cause a FAIL. */
  optionalMissingFiles: string[];
  optionalMissingTests: { id: string; file: string }[];
  optionalMissingArtifacts: { id: string; artifact: string }[];
}

/** Result for a spec with no manifest to check against — advisory-only, always passing. */
export const PASSING_RESULT: ConformanceResult = {
  checked: false,
  pass: true,
  missingFiles: [],
  missingTests: [],
  missingArtifacts: [],
  danglingConsumers: [],
  optionalMissingFiles: [],
  optionalMissingTests: [],
  optionalMissingArtifacts: [],
};

/**
 * Deterministic spec-manifest vs diff conformance check. Host-side, no LLM call: a required file
 * never touched by the diff, a required test whose file has no new test content, a required
 * acceptance artifact absent from the diff, or a consumer wired to a producer that isn't in the
 * diff are all unambiguous, hard-fail signals. Everything fuzzier is out of scope here — the
 * declared-phasing PR body (`Part of #N` + deferred checklist) is the escape hatch for the rest.
 */
/** Splits `items` on their `required` flag (default true) among those failing `isSatisfied`. */
function partitionByRequired<T extends { required?: boolean | undefined }>(
  items: T[],
  isSatisfied: (item: T) => boolean,
): { missing: T[]; optionalMissing: T[] } {
  const missing: T[] = [];
  const optionalMissing: T[] = [];
  for (const item of items) {
    if (isSatisfied(item)) continue;
    (item.required === false ? optionalMissing : missing).push(item);
  }
  return { missing, optionalMissing };
}

export function checkConformance(manifest: SpecManifest | undefined, diff: string): ConformanceResult {
  if (manifest === undefined) return PASSING_RESULT;

  const touched = new Set(extractDiffFiles(diff));
  const sections = diffSections(diff);

  const files = partitionByRequired(manifest.files ?? [], (f) => touched.has(f.path));
  const missingFiles = files.missing.map((f) => f.path);
  const optionalMissingFiles = files.optionalMissing.map((f) => f.path);

  const tests = partitionByRequired(manifest.tests ?? [], (t) => touched.has(t.file) && sectionAddsTestContent(sections.get(t.file)));
  const missingTests = tests.missing.map((t) => ({ id: t.id, file: t.file }));
  const optionalMissingTests = tests.optionalMissing.map((t) => ({ id: t.id, file: t.file }));

  const acceptanceWithArtifact = (manifest.acceptance ?? []).filter(
    (a): a is typeof a & { artifact: string } => a.artifact !== undefined,
  );
  const artifacts = partitionByRequired(acceptanceWithArtifact, (a) => touched.has(a.artifact));
  const missingArtifacts = artifacts.missing.map((a) => ({ id: a.id, artifact: a.artifact }));
  const optionalMissingArtifacts = artifacts.optionalMissing.map((a) => ({ id: a.id, artifact: a.artifact }));

  const danglingConsumers = (manifest.dependencies ?? []).filter((d) => touched.has(d.consumer) && !touched.has(d.producer));

  const pass = missingFiles.length === 0 && missingTests.length === 0 && missingArtifacts.length === 0 && danglingConsumers.length === 0;
  return {
    checked: true,
    pass,
    missingFiles,
    missingTests,
    missingArtifacts,
    danglingConsumers,
    optionalMissingFiles,
    optionalMissingTests,
    optionalMissingArtifacts,
  };
}

/**
 * Minimal failing-witness feedback for the implement-loop repair loop (CEGIS-style): only the unmet
 * obligations, not the full conformance prose or diff, so the repair context stays small and targeted.
 */
export function renderConformanceFeedback(gap: ConformanceGap): string {
  const lines: string[] = ['Conformance check failed against the spec manifest. Address these gaps specifically:'];
  if (gap.missingFiles.length > 0) lines.push(`- Untouched required files: ${gap.missingFiles.join(', ')}`);
  if (gap.missingTests.length > 0) {
    lines.push(`- Missing or incomplete required tests: ${gap.missingTests.map((t) => `${t.id} (${t.file})`).join(', ')}`);
  }
  if (gap.missingArtifacts.length > 0) {
    lines.push(`- Missing acceptance artifacts: ${gap.missingArtifacts.map((a) => `${a.id} (${a.artifact})`).join(', ')}`);
  }
  if (gap.danglingConsumers.length > 0) {
    lines.push(
      `- Dangling consumers (wired to a producer never implemented): ${gap.danglingConsumers
        .map((d) => `${d.consumer} depends on ${d.producer}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Annotation appended to an optional obligation absent from the diff (unchecked, non-FAIL). */
const OPTIONAL_NOT_DELIVERED = ' (optional — not delivered)';

/** Renders one checklist line's checkbox + annotation state given required/optional-missing membership. */
function renderItem(label: string, requiredMissing: boolean, optionalMissing: boolean): string {
  if (optionalMissing) return `- [ ] ${label}${OPTIONAL_NOT_DELIVERED}`;
  if (requiredMissing) return `- [ ] ${label}`;
  return `- [x] ${label}`;
}

/** GFM task-list checklist of every spec-manifest obligation, checked when satisfied per `result`. */
export function renderScopeChecklist(manifest: SpecManifest, result: ConformanceResult): string {
  const missingFilePaths = new Set(result.missingFiles);
  const optionalMissingFilePaths = new Set(result.optionalMissingFiles);
  const missingTestIds = new Set(result.missingTests.map((t) => t.id));
  const optionalMissingTestIds = new Set(result.optionalMissingTests.map((t) => t.id));
  const missingArtifactIds = new Set(result.missingArtifacts.map((a) => a.id));
  const optionalMissingArtifactIds = new Set(result.optionalMissingArtifacts.map((a) => a.id));
  const lines: string[] = [];

  const files = manifest.files ?? [];
  if (files.length > 0) {
    lines.push('**Spec files:**');
    for (const f of files) lines.push(renderItem(`\`${f.path}\``, missingFilePaths.has(f.path), optionalMissingFilePaths.has(f.path)));
  }
  const tests = manifest.tests ?? [];
  if (tests.length > 0) {
    lines.push('', '**Tests:**');
    for (const t of tests) {
      lines.push(renderItem(`${t.id} (\`${t.file}\`)`, missingTestIds.has(t.id), optionalMissingTestIds.has(t.id)));
    }
  }
  const acceptance = manifest.acceptance ?? [];
  if (acceptance.length > 0) {
    lines.push('', '**Acceptance criteria:**');
    for (const a of acceptance) {
      const label = `${a.id}${a.description !== undefined && a.description !== '' ? `: ${a.description}` : ''}`;
      const requiredMissing = a.artifact !== undefined && missingArtifactIds.has(a.id);
      const optionalMissing = a.artifact !== undefined && optionalMissingArtifactIds.has(a.id);
      lines.push(renderItem(label, requiredMissing, optionalMissing));
    }
  }
  return lines.join('\n');
}

/** Keywords GitHub/GitLab treat as auto-closing on merge — deliberately excludes `part of`. */
const CLOSING_KEYWORDS = 'closes|close|closed|fix|fixes|fixed|resolve|resolves|resolved';

const TASK_REF_RE = new RegExp(`\\b(?:${CLOSING_KEYWORDS}|part of)\\s+([^\\s,;]+#\\d+)`, 'i');

/** Extract the taskId (e.g. `owner/repo#900`) a PR body references via a closing keyword or `Part of`. */
export function extractTaskIdFromPrBody(body: string): string | undefined {
  return TASK_REF_RE.exec(body)?.[1];
}

/** Close-only subset of TASK_REF_RE — deliberately excludes `part of`, which never auto-closes on merge. */
const CLOSE_KEYWORD_RE = new RegExp(`\\b(${CLOSING_KEYWORDS})\\s+([^\\s,;#]*#\\d+)`, 'gi');

/** Trailing `#N` issue number off a bare or `owner/repo#N` ref. */
function issueNumberOf(ref: string): string | undefined {
  return /#(\d+)$/.exec(ref)?.[1];
}

export interface CommitClosingLeak {
  keyword: string;
  ref: string;
}

/**
 * Scan branch commit messages for closing keywords that would auto-close an issue on a rebase
 * merge, regardless of the PR body. Matches Closes/Close/Closed/Fix/Fixes/Fixed/Resolve/Resolves/
 * Resolved #N (bare or owner/repo#N) whose issue number equals `taskId`'s. `Part of` is not a
 * closing keyword and is never matched. Pure and git-free: the caller supplies the messages.
 */
export function scanCommitClosingKeywords(messages: string[], taskId: string): CommitClosingLeak[] {
  const issueNumber = issueNumberOf(taskId);
  if (issueNumber === undefined) return [];

  const leaks: CommitClosingLeak[] = [];
  for (const message of messages) {
    for (const match of message.matchAll(CLOSE_KEYWORD_RE)) {
      const keyword = match[1];
      const ref = match[2];
      if (keyword === undefined || ref === undefined) continue;
      if (issueNumberOf(ref) === issueNumber) leaks.push({ keyword, ref });
    }
  }
  return leaks;
}

/** Blocking-warning markdown block surfaced in the PR body when a commit-level close leak is found. */
export function commitLeakWarningBlock(leaks: CommitClosingLeak[]): string {
  if (leaks.length === 0) return '';
  return [
    '## ⚠️ Commit message closes the issue on rebase merge',
    '',
    'A rebase merge closes the linked issue per-commit regardless of this PR body. The following branch commit message(s) contain a closing keyword, but this PR is only a partial delivery:',
    '',
    ...leaks.map((l) => `- \`${l.keyword} ${l.ref}\``),
    '',
    'Reword the offending commit(s), or squash-merge instead of rebase-merging.',
  ].join('\n');
}
