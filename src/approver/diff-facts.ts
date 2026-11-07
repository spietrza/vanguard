import { diffFilesWithPatches, gateConfigPaths, loadGateConfigExtraGlobs } from '../context/gate-config.js';
import { execa } from 'execa';
import { resolveRemoteBaseRef } from '../core/base-branch.js';
import { matchGlob } from './policy.js';
import type { ApproverPolicy, DiffFacts } from './types.js';

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout;
}
async function gitOk(cwd: string, args: string[], input?: string): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa('git', args, { cwd, reject: false, ...(input !== undefined ? { input } : {}) });
  return { stdout: r.stdout, exitCode: r.exitCode ?? 1 };
}

/** The decision's facts when the git plumbing could not run far enough to compute them (fails closed). */
export function emptyDiffFacts(headSha: string, baseSha = '', mergeBase = ''): DiffFacts {
  return {
    files: 0,
    lines: 0,
    paths: [],
    testFilesDeleted: 0,
    testCasesDelta: 0,
    exportsRemoved: 0,
    newDependency: false,
    baseSha,
    headSha,
    mergeBase,
    headPatchId: undefined,
    reviewedPatchId: undefined,
    reviewedIsAncestor: undefined,
    mergeTreeHeadClean: undefined,
    mergeTreeReviewedClean: undefined,
    headMoved: false,
    gitFactsFailed: true,
  };
}

function parseNumstat(out: string): { files: number; lines: number; paths: string[] } {
  const entries = out.split('\0').filter((e) => e !== '');
  let lines = 0;
  const paths: string[] = [];
  for (const entry of entries) {
    const parts = entry.split('\t');
    const added = parts[0];
    const removed = parts[1];
    const path = parts[2] ?? '';
    paths.push(path);
    lines += (added === '-' ? 0 : Number(added ?? 0)) + (removed === '-' ? 0 : Number(removed ?? 0));
  }
  return { files: entries.length, lines, paths };
}

interface NameStatusEntry {
  status: string;
  path: string;
}
/** `--name-status -z` separates the status from the path with a NUL, not a tab: read the fields in pairs. */
function parseNameStatus(out: string): NameStatusEntry[] {
  const fields = out.split('\0').filter((e) => e !== '');
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ status: fields[i]!, path: fields[i + 1]! });
  return entries;
}

// Language-local heuristic over this repo's own Vitest style (see risk R8 in the tech spec): over-counts
// `it(` inside a string/comment, under-counts tagged-template forms — the unsafe direction is covered by
// the size/path rules independently.
const TEST_CASE_RE = /^[ \t]*(?:it|test)(?:\.(?:each|only|skip|todo|concurrent|sequential|fails|for)\b[^\n(]*)*[ \t]*\(/gm;
function countTestCases(text: string): number {
  return [...text.matchAll(TEST_CASE_RE)].length;
}

async function showFile(cwd: string, sha: string, path: string): Promise<string> {
  const r = await gitOk(cwd, ['show', `${sha}:${path}`]);
  return r.exitCode === 0 ? r.stdout : '';
}

function countExportsRemoved(diff: string, testGlobs: string[]): number {
  const blocks = diff.split(/(?<=\n)(?=diff --git )/);
  let count = 0;
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const header = nl === -1 ? block : block.slice(0, nl);
    const match = /^diff --git a\/.+? b\/(.+)$/.exec(header);
    const path = match?.[1];
    if (path === undefined || testGlobs.some((g) => matchGlob(g, path))) continue;
    for (const line of block.split('\n')) if (/^-[ \t]*export\b/.test(line)) count += 1;
  }
  return count;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function manifestDepKeys(pkg: unknown): Set<string> {
  const keys = new Set<string>();
  if (typeof pkg !== 'object' || pkg === null) return keys;
  for (const field of DEP_FIELDS) {
    const deps = (pkg as Record<string, unknown>)[field];
    if (typeof deps === 'object' && deps !== null) for (const k of Object.keys(deps)) keys.add(k);
  }
  return keys;
}

async function detectNewDependency(cwd: string, statuses: NameStatusEntry[], mergeBase: string, headSha: string): Promise<boolean> {
  const manifests = statuses.filter((s) => matchGlob('**/package.json', s.path));
  for (const m of manifests) {
    const headText = m.status === 'D' ? '' : await showFile(cwd, headSha, m.path);
    if (headText === '') continue;
    const baseText = m.status === 'A' ? '' : await showFile(cwd, mergeBase, m.path);
    try {
      const headKeys = manifestDepKeys(JSON.parse(headText));
      const baseKeys = baseText === '' ? new Set<string>() : manifestDepKeys(JSON.parse(baseText));
      for (const k of headKeys) if (!baseKeys.has(k)) return true;
    } catch {
      return true; // unparseable manifest: fail closed
    }
  }
  return false;
}

async function patchId(cwd: string, from: string, to: string): Promise<string | undefined> {
  try {
    const diff = await execa('git', ['diff', '--no-renames', '--full-index', from, to], { cwd });
    if (diff.stdout.trim() === '') return undefined;
    const pid = await execa('git', ['patch-id', '--stable'], { cwd, input: diff.stdout });
    const first = pid.stdout.trim().split(/\s+/)[0];
    return first === undefined || first === '' ? undefined : first;
  } catch {
    return undefined;
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | undefined> {
  const r = await gitOk(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  return undefined;
}

export async function mergeTreeClean(cwd: string, a: string, b: string): Promise<boolean | undefined> {
  const r = await gitOk(cwd, ['merge-tree', '--write-tree', '--name-only', a, b]);
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  return undefined;
}

export interface CollectDiffFactsInput {
  repoPath: string;
  prNumber: number;
  baseRefName: string;
  apiHeadSha: string;
  reviewedSha: string | null;
  policy: ApproverPolicy;
}

/**
 * Git-sourced facts. The PR head is only ever read, never checked out: `git fetch` into FETCH_HEAD,
 * then `git show`/`git diff`/`git patch-id`/`git merge-tree` against SHAs. Any failure fails closed
 * into `gitFactsFailed: true`, which the rules engine escalates.
 */
export async function collectDiffFacts(input: CollectDiffFactsInput): Promise<DiffFacts> {
  const { repoPath, prNumber, baseRefName, apiHeadSha, reviewedSha, policy } = input;

  let baseTip: string;
  try {
    // Same as loadPolicy: the remote base always wins, so a local branch that is ahead (a dev box,
    // the backtest) cannot shrink or grow the diff the decision is about.
    const ref = await resolveRemoteBaseRef(repoPath, baseRefName, { label: 'approver', keepLocalIfAhead: false });
    baseTip = (await git(repoPath, ['rev-parse', ref])).trim();
  } catch {
    return emptyDiffFacts(apiHeadSha);
  }

  try {
    await execa('git', ['fetch', '--no-tags', '--quiet', 'origin', `refs/pull/${prNumber}/head`], { cwd: repoPath });
  } catch {
    return emptyDiffFacts(apiHeadSha, baseTip);
  }
  const headSha = (await git(repoPath, ['rev-parse', 'FETCH_HEAD'])).trim();
  const headMoved = headSha !== apiHeadSha;

  const mergeBaseResult = await gitOk(repoPath, ['merge-base', baseTip, headSha]);
  if (mergeBaseResult.exitCode !== 0) return { ...emptyDiffFacts(headSha, baseTip), headMoved };
  const mergeBase = mergeBaseResult.stdout.trim();

  const numstat = await gitOk(repoPath, ['diff', '--numstat', '--no-renames', '-z', mergeBase, headSha]);
  const nameStatus = await gitOk(repoPath, ['diff', '--name-status', '--no-renames', '-z', mergeBase, headSha]);
  if (numstat.exitCode !== 0 || nameStatus.exitCode !== 0) return { ...emptyDiffFacts(headSha, baseTip, mergeBase), headMoved };

  const { files, lines, paths } = parseNumstat(numstat.stdout);
  const statuses = parseNameStatus(nameStatus.stdout);

  const testFilesDeleted = statuses.filter((s) => s.status === 'D' && policy.testGlobs.some((g) => matchGlob(g, s.path))).length;

  let testCasesDelta = 0;
  for (const s of statuses) {
    if (!policy.testGlobs.some((g) => matchGlob(g, s.path))) continue;
    const before = s.status === 'A' ? 0 : countTestCases(await showFile(repoPath, mergeBase, s.path));
    const after = s.status === 'D' ? 0 : countTestCases(await showFile(repoPath, headSha, s.path));
    testCasesDelta += after - before;
  }

  const tsDiff = await gitOk(repoPath, ['diff', '--no-renames', '-U0', mergeBase, headSha, '--', '*.ts']);
  const exportsRemoved = countExportsRemoved(tsDiff.stdout, policy.testGlobs);
  const newDependency = await detectNewDependency(repoPath, statuses, mergeBase, headSha);

  const configDiff = await gitOk(repoPath, ['diff', '--no-renames', mergeBase, headSha]);
  if (configDiff.exitCode !== 0) return { ...emptyDiffFacts(headSha, baseTip, mergeBase), headMoved };
  const configPaths = gateConfigPaths(diffFilesWithPatches(configDiff.stdout), await loadGateConfigExtraGlobs(repoPath, baseRefName));
  const headPatchId = await patchId(repoPath, mergeBase, headSha);
  let reviewedPatchId: string | undefined;
  let reviewedIsAncestor: boolean | undefined;
  let mergeTreeReviewedClean: boolean | undefined;
  if (reviewedSha !== null && reviewedSha === headSha) {
    reviewedIsAncestor = true;
  } else if (reviewedSha !== null) {
    reviewedPatchId = await patchId(repoPath, mergeBase, reviewedSha);
    reviewedIsAncestor = await isAncestor(repoPath, reviewedSha, headSha);
    mergeTreeReviewedClean = await mergeTreeClean(repoPath, baseTip, reviewedSha);
  }
  const mergeTreeHeadClean = await mergeTreeClean(repoPath, baseTip, headSha);

  return {
    gateConfigPaths: configPaths,
    files, lines, paths, testFilesDeleted, testCasesDelta, exportsRemoved, newDependency,
    baseSha: baseTip, headSha, mergeBase,
    headPatchId, reviewedPatchId, reviewedIsAncestor, mergeTreeHeadClean, mergeTreeReviewedClean,
    headMoved, gitFactsFailed: false,
  };
}
