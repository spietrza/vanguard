import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { readRepoFile, resolveRepoFile } from './repo-files.js';

/** A real git repo (membership uses `git ls-files`), with the given tracked files written + added. */
async function repo(files: Record<string, string> = {}): Promise<string> {
  const r = mkdtempSync(join(tmpdir(), 'vg-repo-'));
  await execa('git', ['-C', r, 'init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(r, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  if (Object.keys(files).length > 0) await execa('git', ['-C', r, 'add', '-A']);
  return r;
}

test('reads a tracked repo-relative file', async () => {
  const r = await repo({ 'notes.md': 'hello' });
  const res = await readRepoFile(r, 'notes.md');
  expect(res.content).toBe('hello');
  expect(res.truncated).toBe(false);
});

test('rejects lexical traversal and absolute paths', () => {
  const r = mkdtempSync(join(tmpdir(), 'vg-repo-'));
  expect(() => resolveRepoFile(r, '../outside')).toThrow(/escapes|invalid/);
  expect(() => resolveRepoFile(r, '/etc/passwd')).toThrow(/invalid/);
  expect(() => resolveRepoFile(r, 'a/../../b')).toThrow(/escapes/);
});

test('an untracked (gitignored/secret) in-repo file is refused — not just containable (review r3)', async () => {
  // The autocomplete only offers tracked files, but the mention text is free-form: @.env must not
  // inline a gitignored secret into a prompt bound for a custom-provider baseUrl.
  const r = await repo({ 'tracked.md': 'ok' });
  writeFileSync(join(r, '.env'), 'SECRET=hunter2'); // present but never `git add`ed
  await expect(readRepoFile(r, '.env')).rejects.toThrow(/not a tracked file/);
});

test('a tracked symlink pointing out of the repo is refused, not followed (review r2 security)', async () => {
  const r = await repo();
  const outside = mkdtempSync(join(tmpdir(), 'vg-outside-'));
  writeFileSync(join(outside, 'secret'), 'do not exfiltrate');
  symlinkSync(join(outside, 'secret'), join(r, 'notes.md'));
  await execa('git', ['-C', r, 'add', '-A']); // track the symlink itself
  await expect(readRepoFile(r, 'notes.md')).rejects.toThrow(/escapes the repo/);
});

test('a tracked symlink WITHIN the repo is fine', async () => {
  const r = await repo({ 'docs/real.md': 'in-repo' });
  symlinkSync(join(r, 'docs', 'real.md'), join(r, 'alias.md'));
  await execa('git', ['-C', r, 'add', '-A']);
  const res = await readRepoFile(r, 'alias.md');
  expect(res.content).toBe('in-repo');
});

test.skipIf(process.platform === 'win32')('a pathspec-magic name is matched literally, not as a glob', async () => {
  const r = await repo({ 'tracked.md': 'ok' });
  writeFileSync(join(r, '*'), 'untracked'); // `*` as a glob would match tracked.md
  await expect(readRepoFile(r, '*')).rejects.toThrow(/not a tracked file/);
  await execa('git', ['-C', r, 'add', '--', '*']);
  expect((await readRepoFile(r, '*')).content).toBe('untracked');
});

test('a tracked symlink to an untracked file inside the repo is refused', async () => {
  const r = await repo({ '.gitignore': '.env\n' });
  writeFileSync(join(r, '.env'), 'SECRET=hunter2');
  symlinkSync(join(r, '.env'), join(r, 'notes.md'));
  await execa('git', ['-C', r, 'add', '-A']);
  await expect(readRepoFile(r, 'notes.md')).rejects.toThrow(/not a tracked file/);
});
