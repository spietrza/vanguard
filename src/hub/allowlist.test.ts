import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assertGitWorkTreeDir, assertMutationsAllowed, ProjectAllowlist } from './allowlist.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vanguard-hub-allowlist-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ProjectAllowlist', () => {
  test('T-63 exact match after realpath; a prefix and a traversal path are refused', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const evil = join(root, 'repo-evil');
    await mkdir(evil, { recursive: true });
    const allowlist = new ProjectAllowlist(async () => [repo]);

    const real = await allowlist.assertAllowed(repo);
    expect(real.endsWith('repo')).toBe(true);

    await expect(allowlist.assertAllowed(evil)).rejects.toThrow(/not an allowed project/);
    await expect(allowlist.assertAllowed(join(repo, '..', 'repo-evil'))).rejects.toThrow(/not an allowed project/);
  });

  test('a seeded --repo path is allowed even before it reaches the persisted store', async () => {
    const repo = join(root, 'seed-repo');
    await mkdir(repo, { recursive: true });
    const allowlist = new ProjectAllowlist(async () => [], repo);
    await expect(allowlist.assertAllowed(repo)).resolves.toBeTruthy();
  });

  test('a repoPath that does not exist is refused', async () => {
    const allowlist = new ProjectAllowlist(async () => []);
    await expect(allowlist.assertAllowed(join(root, 'nope'))).rejects.toThrow();
  });

  test('T-64 read_session path must be inside an allowed project', async () => {
    const repo = join(root, 'repo');
    const sessionsDir = join(repo, '.vanguard', 'sessions', 'task-1');
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'a.jsonl');
    await writeFile(sessionFile, '{}\n');

    const otherRepo = join(root, 'other');
    const otherSessions = join(otherRepo, '.vanguard', 'sessions', 'task-1');
    await mkdir(otherSessions, { recursive: true });
    const otherSessionFile = join(otherSessions, 'b.jsonl');
    await writeFile(otherSessionFile, '{}\n');

    const allowlist = new ProjectAllowlist(async () => [repo]);
    const real = await allowlist.assertSessionPath(sessionFile);
    expect(real.endsWith('a.jsonl')).toBe(true);

    // Same grammar, but the owning repo (`other`) is not in the allowlist.
    await expect(allowlist.assertSessionPath(otherSessionFile)).rejects.toThrow(/not an allowed project/);

    // A symlinked session file is refused even when its target is another allowed session file.
    const linked = join(sessionsDir, 'link.jsonl');
    await symlink(sessionFile, linked);
    await expect(allowlist.assertSessionPath(linked)).rejects.toThrow(/not a vanguard session file/);

    // Not even a session-shaped path at all.
    await expect(allowlist.assertSessionPath(join(repo, '.vanguard', 'runs', 'x.json'))).rejects.toThrow(
      /not a vanguard session file/,
    );
  });

  test('T-65 add_project requires a directory containing a .git entry', async () => {
    const plainDir = join(root, 'plain');
    await mkdir(plainDir, { recursive: true });
    await expect(assertGitWorkTreeDir(plainDir)).rejects.toThrow(/\.git/);

    const gitRepo = join(root, 'gitrepo');
    await mkdir(join(gitRepo, '.git'), { recursive: true });
    await expect(assertGitWorkTreeDir(gitRepo)).resolves.toBeUndefined();

    await expect(assertGitWorkTreeDir(join(root, 'does-not-exist'))).rejects.toThrow();
  });

  test('T-66 non-loopback bind refuses add_project/browse_dirs unless VANGUARD_HUB_ALLOW_ADD=1', () => {
    expect(() => assertMutationsAllowed({ isLoopback: true, allowAdd: false })).not.toThrow();
    expect(() => assertMutationsAllowed({ isLoopback: false, allowAdd: true })).not.toThrow();
    expect(() => assertMutationsAllowed({ isLoopback: false, allowAdd: false })).toThrow(/VANGUARD_HUB_ALLOW_ADD/);
  });

  test('a symlinked .vanguard parent cannot be used to smuggle a session path to an unrelated repo', async () => {
    const repo = join(root, 'repo2');
    await mkdir(repo, { recursive: true });
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'sessions', 'task-1'), { recursive: true });
    await writeFile(join(outside, 'sessions', 'task-1', 'a.jsonl'), '{}\n');
    await symlink(outside, join(repo, '.vanguard'));

    const allowlist = new ProjectAllowlist(async () => [repo]);
    // realpath collapses the symlinked `.vanguard` segment away, so the grammar/derivation no longer
    // sees a literal `.vanguard/sessions` pair in the resolved path — must be refused, not silently
    // resolved to some other repo.
    await expect(
      allowlist.assertSessionPath(join(repo, '.vanguard', 'sessions', 'task-1', 'a.jsonl')),
    ).rejects.toThrow();
  });
});
