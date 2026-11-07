import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { VanguardError } from '../core/errors.js';
import { instructionPaths, overlayInstructionFiles } from './instruction-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function fixture() {
  const repoPath = await mkdtemp(join(tmpdir(), 'vg-instructions-'));
  roots.push(repoPath);
  const git = (args: string[], cwd = repoPath) => execa('git', args, { cwd });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'user.email', 'test@local']);
  const put = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(join(repoPath, path)), { recursive: true });
    await writeFile(join(repoPath, path), content);
  };
  const commit = async () => {
    await git(['add', '-A']);
    await git(['commit', '-qm', 'fixture']);
    return (await git(['rev-parse', 'HEAD'])).stdout;
  };
  const worktreePath = join(repoPath, 'worktree');
  const worktree = async () => { await git(['worktree', 'add', '-qb', 'review', worktreePath, 'HEAD']); };
  return { repoPath, worktreePath, git, put, commit, worktree };
}

describe('instruction files', () => {
  it('classifies every instruction location, case-insensitively', () => {
    const positive = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md', 'src/x/CLAUDE.md',
      'src/AGENTS.md', 'src/AGENT.md', 'src/CLAUDE.local.md', '.claude', '.claude/settings.json',
      'src/.claude/hooks/x', '.cursor', '.cursor/rules/x.mdc', 'src/.cursor/rules/x', '.mcp.json',
      '.github/vanguard-skills', '.github/vanguard-skills/review/SKILL.md'];
    const paths = [...positive, ...positive.map((p) => p.toUpperCase())];
    expect(instructionPaths([...paths, 'docs/CLAUDE.md.bak', 'claudemd', 'MY-AGENTS.md',
      'vendor/.mcp.json', '.github/workflows/ci.yml'])).toEqual(paths.sort());
  });

  it('replaces only instructions, preserves bytes and modes, and commits a clean overlay', async () => {
    const f = await fixture();
    await f.put('CLAUDE.md', 'default rules\r\n');
    await f.put('.github/vanguard-skills/code-review/SKILL.md', 'trusted');
    await f.put('.cursor/rules/x.mdc', Buffer.from([0, 1, 2, 13, 10]));
    await f.put('.claude/hooks/run.sh', '#!/bin/sh\nexit 0\n');
    await chmod(join(f.repoPath, '.claude/hooks/run.sh'), 0o755);
    await f.put('src/app.ts', 'default code');
    const sha = await f.commit();
    await f.git(['checkout', '-qb', 'release']);
    await f.put('CLAUDE.md', 'base rules');
    await f.put('.claude/hooks/run.sh', 'base hook');
    await chmod(join(f.repoPath, '.claude/hooks/run.sh'), 0o644);
    await f.put('AGENTS.md', 'base agents');
    await f.put('src/feature/CLAUDE.md', 'nested base');
    await f.put('.claude/settings.json', '{}');
    await f.put('.github/vanguard-skills/evil/SKILL.md', 'evil');
    await f.git(['rm', '-qr', '.github/vanguard-skills/code-review', '.cursor']);
    await f.put('src/app.ts', 'base code');
    const base = await f.commit();
    await f.worktree();
    const overlay = await overlayInstructionFiles({ ...f, ref: 'main' });
    expect(overlay.sha).toBe(sha);
    expect(await readFile(join(f.worktreePath, 'CLAUDE.md'))).toEqual(Buffer.from('default rules\r\n'));
    expect(await readFile(join(f.worktreePath, '.cursor/rules/x.mdc'))).toEqual(Buffer.from([0, 1, 2, 13, 10]));
    expect(await readFile(join(f.worktreePath, '.claude/hooks/run.sh'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect((await lstat(join(f.worktreePath, '.claude/hooks/run.sh'))).mode & 0o111).toBe(0o111);
    expect(await readFile(join(f.worktreePath, 'src/app.ts'), 'utf8')).toBe('base code');
    expect(await readFile(join(f.worktreePath, '.github/vanguard-skills/code-review/SKILL.md'), 'utf8')).toBe('trusted');
    for (const path of ['AGENTS.md', 'src/feature/CLAUDE.md', '.claude/settings.json', '.github/vanguard-skills/evil/SKILL.md']) {
      await expect(lstat(join(f.worktreePath, path))).rejects.toThrow();
    }
    expect((await f.git(['status', '--porcelain'], f.worktreePath)).stdout).toBe('');
    expect((await f.git(['rev-list', '--count', `${base}..HEAD`], f.worktreePath)).stdout).toBe('1');
    expect((await f.git(['log', '-1', '--format=%s'], f.worktreePath)).stdout).toBe(`vanguard: instruction files from main@${sha.slice(0, 7)}`);
    const changed = (await f.git(['diff', '--name-only', '-z', base, 'HEAD'], f.worktreePath)).stdout.split('\0').filter(Boolean).sort();
    expect(overlay.differing).toEqual(changed);
    expect(instructionPaths(changed)).toEqual(changed);
    await f.git(['worktree', 'remove', f.worktreePath]);
  });

  it('does not commit identical instructions', async () => {
    const f = await fixture();
    await f.put('CLAUDE.md', 'same');
    const sha = await f.commit();
    await f.worktree();
    expect((await overlayInstructionFiles({ ...f, ref: 'main' })).differing).toEqual([]);
    expect((await f.git(['rev-parse', 'HEAD'], f.worktreePath)).stdout).toBe(sha);
    expect((await f.git(['status', '--porcelain'], f.worktreePath)).stdout).toBe('');
  });

  it('replaces a symlinked instruction directory without writing through it', async () => {
    const f = await fixture();
    await f.put('.claude/settings.json', 'trusted');
    await f.commit();
    await f.git(['checkout', '-qb', 'release']);
    await f.git(['rm', '-qr', '.claude']);
    await f.put('outside/settings.json', 'untouched');
    await symlink('outside', join(f.repoPath, '.claude'));
    await f.commit();
    await f.worktree();
    await overlayInstructionFiles({ ...f, ref: 'main' });
    expect(await readFile(join(f.worktreePath, '.claude/settings.json'), 'utf8')).toBe('trusted');
    expect(await readFile(join(f.worktreePath, 'outside/settings.json'), 'utf8')).toBe('untouched');
  });

  it('treats wildcard and pathspec-magic filenames literally', async () => {
    const f = await fixture();
    await f.put('we*ird/CLAUDE.md', 'trusted');
    await f.put(':(glob)*/CLAUDE.md', 'literal magic');
    await f.commit();
    await f.git(['checkout', '-qb', 'release']);
    await f.put('we*ird/CLAUDE.md', 'base');
    await f.put('weXird/CLAUDE.md', 'base-only');
    await f.put(':(exclude)keep/CLAUDE.md', 'base-only magic');
    await f.put(':(glob)*/CLAUDE.md', 'base magic');
    await f.put('src/app.ts', 'code');
    await f.commit();
    await f.worktree();
    await overlayInstructionFiles({ ...f, ref: 'main' });
    expect(await readFile(join(f.worktreePath, 'we*ird/CLAUDE.md'), 'utf8')).toBe('trusted');
    expect(await readFile(join(f.worktreePath, ':(glob)*/CLAUDE.md'), 'utf8')).toBe('literal magic');
    expect(await readFile(join(f.worktreePath, 'src/app.ts'), 'utf8')).toBe('code');
    await expect(lstat(join(f.worktreePath, 'weXird/CLAUDE.md'))).rejects.toThrow();
  });

  it.each(['--upload-pack=x', 'a:b', 'a..b'])('rejects unsafe ref %s before accessing git', async (ref) => {
    await expect(overlayInstructionFiles({ repoPath: '/does-not-exist', worktreePath: '/does-not-exist', ref })).rejects.toThrow('Invalid base branch');
  });

  it('fails closed for an unresolvable ref without origin', async () => {
    const f = await fixture();
    await f.put('CLAUDE.md', 'rules');
    await f.commit();
    await f.worktree();
    await expect(overlayInstructionFiles({ ...f, ref: 'missing' })).rejects.toThrow(VanguardError);
  });
});
