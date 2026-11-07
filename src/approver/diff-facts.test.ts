import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { collectDiffFacts, emptyDiffFacts } from './diff-facts.js';
import type { ApproverPolicy, DiffFacts } from './types.js';

const policy: ApproverPolicy = {
  schemaVersion: 1,
  enabled: true,
  factoryBranchPrefix: 'chore/vanguard-',
  requiredChecks: [],
  reviewAuthors: ['github-actions'],
  testGlobs: ['**/*.test.ts'],
  pathRules: {},
  shape: { maxLines: 150, maxFiles: 5 },
  ledger: { windowDays: 7, maxLines: 300 },
  auditSample: { p: 0 },
};

let root: string;
let origin: string;
let repo: string;
let work: string;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd })).stdout.trim();
}

async function write(cwd: string, path: string, content: string): Promise<void> {
  const file = join(cwd, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '--quiet', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

const TEST_FILE = "import { it } from 'vitest';\nit('a', () => {});\nit('b', () => {});\n";

/** A head commit on `work`, pushed to the origin's `refs/pull/1/head`, starting from the base tip. */
async function pushHead(mutate: (cwd: string) => Promise<void>): Promise<string> {
  await git(work, ['checkout', '--quiet', '-B', 'chore/vanguard-1', 'main']);
  await mutate(work);
  const sha = await commitAll(work, 'head');
  await git(work, ['push', '--quiet', '--force', origin, 'chore/vanguard-1:refs/pull/1/head']);
  return sha;
}

async function collect(apiHeadSha: string, reviewedSha: string | null = null): Promise<DiffFacts> {
  return collectDiffFacts({ repoPath: repo, prNumber: 1, baseRefName: 'main', apiHeadSha, reviewedSha, policy });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vg-diff-facts-'));
  origin = join(root, 'origin.git');
  await execa('git', ['init', '--quiet', '--bare', origin]);
  work = join(root, 'work');
  await execa('git', ['init', '--quiet', '-b', 'main', work]);
  await git(work, ['config', 'user.email', 't@t']);
  await git(work, ['config', 'user.name', 't']);
  await write(work, 'package.json', JSON.stringify({ name: 'x', dependencies: { execa: '^10.0.0' } }, null, 2));
  await write(work, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
  await write(work, 'src/a.test.ts', TEST_FILE);
  await commitAll(work, 'seed');
  await git(work, ['push', '--quiet', origin, 'main']);

  repo = join(root, 'repo');
  await execa('git', ['clone', '--quiet', origin, repo]);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collectDiffFacts', () => {
  it('diffs against the remote base even outside CI, where a local base that is ahead would otherwise win', async () => {
    vi.stubEnv('CI', '');
    try {
      const head = await pushHead(async (cwd) => { await write(cwd, 'src/b.ts', 'export const c = 3;\n'); });
      // A local `main` fast-forwarded onto the PR head is ahead of origin/main; used as the base, the
      // merge base would be the head itself and the diff would shrink to nothing.
      await git(repo, ['fetch', '--quiet', 'origin', 'refs/pull/1/head']);
      await git(repo, ['checkout', '--quiet', 'main']);
      await git(repo, ['merge', '--quiet', '--ff-only', 'FETCH_HEAD']);
      const facts = await collect(head, head);
      expect(facts).toMatchObject({ files: 1, paths: ['src/b.ts'] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['skills/review/SKILL.md', '.github/vanguard-skills/review/SKILL.md', 'skills.lock.json'])('collects protected config %s from git', async (path) => {
    const head = await pushHead(async (cwd) => { await write(cwd, path, 'changed\n'); });
    expect((await collect(head, head)).gateConfigPaths).toEqual([path]);
  });

  it('counts files, lines and paths against the merge base, and resolves a same-SHA review', async () => {
    const head = await pushHead(async (cwd) => { await write(cwd, 'src/b.ts', 'export const c = 3;\n'); });
    const facts = await collect(head, head);
    expect(facts).toMatchObject({
      files: 1,
      lines: 1,
      paths: ['src/b.ts'],
      headSha: head,
      headMoved: false,
      gitFactsFailed: false,
      mergeTreeHeadClean: true,
      reviewedIsAncestor: true,
      reviewedPatchId: undefined,
      mergeTreeReviewedClean: undefined,
    });
    expect(facts.headPatchId).toBeTypeOf('string');
    expect(facts.mergeBase).toBe(facts.baseSha);
  });

  it('flags headMoved when the fetched head is not the SHA the API reported', async () => {
    const head = await pushHead(async (cwd) => { await write(cwd, 'src/b.ts', 'export const c = 3;\n'); });
    const facts = await collect('0000000000000000000000000000000000000000');
    expect(facts).toMatchObject({ headSha: head, headMoved: true, gitFactsFailed: false });
  });

  it('counts a deleted test file and the test cases it took with it', async () => {
    const head = await pushHead(async (cwd) => { await rm(join(cwd, 'src/a.test.ts')); });
    expect(await collect(head)).toMatchObject({ testFilesDeleted: 1, testCasesDelta: -2 });
  });

  it('counts added test cases as a positive delta and deletes none', async () => {
    const head = await pushHead(async (cwd) => { await write(cwd, 'src/a.test.ts', `${TEST_FILE}it.each([1])('c', () => {});\n`); });
    expect(await collect(head)).toMatchObject({ testFilesDeleted: 0, testCasesDelta: 1 });
  });

  it('counts removed exports in source files only, never in test files', async () => {
    const head = await pushHead(async (cwd) => {
      await write(cwd, 'src/a.ts', 'export const a = 1;\n');
      await write(cwd, 'src/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\nit('b', () => {});\nexport const helper = 1;\n");
    });
    expect(await collect(head)).toMatchObject({ exportsRemoved: 1 });

    const withTestExportRemoved = await pushHead(async (cwd) => {
      await write(cwd, 'src/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\n");
    });
    expect(await collect(withTestExportRemoved)).toMatchObject({ exportsRemoved: 0 });
  });

  it('detects a new manifest dependency, and ignores a version bump of an existing one', async () => {
    const added = await pushHead(async (cwd) => {
      await write(cwd, 'package.json', JSON.stringify({ name: 'x', dependencies: { execa: '^10.0.0', zod: '^4.0.0' } }, null, 2));
    });
    expect(await collect(added)).toMatchObject({ newDependency: true });

    const bumped = await pushHead(async (cwd) => {
      await write(cwd, 'package.json', JSON.stringify({ name: 'x', dependencies: { execa: '^10.1.1' } }, null, 2));
    });
    expect(await collect(bumped)).toMatchObject({ newDependency: false });
  });

  it('fails closed to newDependency on an unparseable manifest', async () => {
    const head = await pushHead(async (cwd) => { await write(cwd, 'package.json', '{ not json'); });
    expect(await collect(head)).toMatchObject({ newDependency: true });
  });

  it('computes the reviewed patch id and ancestry when the review is for an earlier commit', async () => {
    await git(work, ['checkout', '--quiet', '-B', 'chore/vanguard-1', 'main']);
    await write(work, 'src/b.ts', 'export const c = 3;\n');
    const reviewed = await commitAll(work, 'first');
    await write(work, 'src/c.ts', 'export const d = 4;\n');
    const head = await commitAll(work, 'second');
    await git(work, ['push', '--quiet', '--force', origin, 'chore/vanguard-1:refs/pull/1/head']);

    const facts = await collect(head, reviewed);
    expect(facts.reviewedIsAncestor).toBe(true);
    expect(facts.mergeTreeReviewedClean).toBe(true);
    expect(facts.reviewedPatchId).toBeTypeOf('string');
    expect(facts.reviewedPatchId).not.toBe(facts.headPatchId);
  });

  it('reports a merge conflict against the moved base', async () => {
    const head = await pushHead(async (cwd) => { await write(cwd, 'src/a.ts', 'export const a = 100;\nexport const b = 2;\n'); });
    await git(work, ['checkout', '--quiet', 'main']);
    await write(work, 'src/a.ts', 'export const a = 999;\nexport const b = 2;\n');
    await commitAll(work, 'base moves');
    await git(work, ['push', '--quiet', origin, 'main']);

    expect(await collect(head)).toMatchObject({ mergeTreeHeadClean: false, gitFactsFailed: false });
  });

  it('fails closed when the PR head ref cannot be fetched', async () => {
    const facts = await collectDiffFacts({ repoPath: repo, prNumber: 999, baseRefName: 'main', apiHeadSha: 'abc', reviewedSha: null, policy });
    expect(facts).toMatchObject({ gitFactsFailed: true, headSha: 'abc', files: 0, lines: 0, paths: [] });
    expect(facts.baseSha).not.toBe('');
  });

  it('fails closed when the base ref cannot be resolved', async () => {
    const facts = await collectDiffFacts({ repoPath: repo, prNumber: 1, baseRefName: '../evil', apiHeadSha: 'abc', reviewedSha: null, policy });
    expect(facts).toEqual(emptyDiffFacts('abc'));
  });
});

describe('emptyDiffFacts', () => {
  it('zeroes every signal and marks the facts failed', () => {
    expect(emptyDiffFacts('head', 'base', 'mb')).toMatchObject({
      files: 0, lines: 0, paths: [], testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0,
      newDependency: false, baseSha: 'base', headSha: 'head', mergeBase: 'mb', headMoved: false, gitFactsFailed: true,
    });
  });
});
