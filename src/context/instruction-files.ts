import { execa } from 'execa';
import { assertSafeBaseBranch, resolveRemoteBaseRef } from '../core/base-branch.js';
import { VanguardError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { hostGitArgs } from '../worktree/host-git.js';
import type { VanguardLogger } from '../core/logger.js';

/**
 * Repository files that instruct the agent rather than being reviewed by it. The review reads these
 * from the default branch, never from the branch under review: a branch the change's author can push
 * to must not set the rules its own review is judged by. Same shape and spirit as WORKFLOW_PATH in
 * core/vanguard.ts — one regex, case-insensitive, matched against repo-relative POSIX paths.
 */
const INSTRUCTION_PATH =
  /(^|[\\/])(CLAUDE|CLAUDE\.local|AGENTS|AGENT)\.md$|(^|[\\/])\.claude([\\/]|$)|(^|[\\/])\.cursor([\\/]|$)|^\.mcp\.json$|^\.github[\\/]vanguard-skills([\\/]|$)/i;

/** The instruction paths among `paths`, sorted. Empty ⇒ nothing to overlay. Mirrors workflowPaths(). */
export function instructionPaths(paths: string[]): string[] {
  return paths.filter((path) => INSTRUCTION_PATH.test(path)).sort();
}

export interface InstructionOverlay {
  /** Branch the files were taken from, and the commit it resolved to. */
  ref: string;
  sha: string;
  /** Instruction paths written from `sha`. */
  written: string[];
  /** Instruction paths the base carried and `sha` does not: deleted from the worktree. */
  removed: string[];
  /** Paths whose worktree content actually changed (git-reported). Drives the prompt note; empty ⇒ the two refs agree. */
  differing: string[];
}

export interface OverlayInstructionFilesOptions {
  /** The host checkout (holds the objects + origin). */
  repoPath: string;
  /** The fresh review worktree, already cut from the PR base. */
  worktreePath: string;
  /** The default branch name, from the forge API. */
  ref: string;
  logger?: VanguardLogger;
}

/** `git ls-tree -r -z --name-only <tree>` in `cwd`, split on NUL, filtered through instructionPaths(). */
async function instructionPathsInTree(cwd: string, tree: string): Promise<string[]> {
  const { stdout } = await execa('git', hostGitArgs(['ls-tree', '-r', '-z', '--name-only', '--end-of-options', tree]), { cwd });
  const paths = stdout.split('\0').filter((p) => p !== '');
  return instructionPaths(paths);
}

/** NUL-separated paths on stdin; callers also use --literal-pathspecs to disable pathspec magic. */
function pathspecStdin(paths: string[]): string {
  return paths.map((p) => `${p}\0`).join('');
}

/**
 * Replace the review worktree's instruction files (CLAUDE.md, AGENTS.md, .claude/, .cursor/,
 * .mcp.json, .github/vanguard-skills/) with the default branch's copies, and remove any the base
 * carries that the default branch does not. Commits the result on the worktree's own (throwaway)
 * branch when anything changed, so disposeContext still finds a clean worktree to remove.
 */
export async function overlayInstructionFiles(opts: OverlayInstructionFilesOptions): Promise<InstructionOverlay> {
  const { repoPath, worktreePath } = opts;
  const log = opts.logger ?? createLogger();
  assertSafeBaseBranch(opts.ref);

  const resolved = await resolveRemoteBaseRef(repoPath, opts.ref, { label: 'instructions', keepLocalIfAhead: false, logger: log });
  const sha = (await execa('git', ['rev-parse', '--verify', '--quiet', `${resolved}^{commit}`], { cwd: repoPath, reject: false })).stdout.trim();
  if (sha === '') throw new VanguardError(`cannot resolve instruction ref ${opts.ref} in ${repoPath}`);

  const [defaultPaths, basePaths] = await Promise.all([
    instructionPathsInTree(repoPath, sha),
    instructionPathsInTree(worktreePath, 'HEAD'),
  ]);
  const defaultSet = new Set(defaultPaths);
  const removed = basePaths.filter((p) => !defaultSet.has(p)).sort();

  if (basePaths.length > 0) {
    await execa('git', hostGitArgs(['--literal-pathspecs', 'rm', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul', '--']), {
      cwd: worktreePath,
      input: pathspecStdin(basePaths),
    });
  }
  if (defaultPaths.length > 0) {
    await execa('git', hostGitArgs(['--literal-pathspecs', 'checkout', sha, '--pathspec-from-file=-', '--pathspec-file-nul', '--']), {
      cwd: worktreePath,
      input: pathspecStdin(defaultPaths),
    });
  }

  const diffOut = await execa('git', hostGitArgs(['diff', '--name-only', '-z', 'HEAD']), { cwd: worktreePath });
  const differing = diffOut.stdout.split('\0').filter((p) => p !== '').sort();

  if (differing.length > 0) {
    await execa('git', hostGitArgs(['add', '-A']), { cwd: worktreePath });
    await execa(
      'git',
      hostGitArgs(['-c', 'user.name=Vanguard', '-c', 'user.email=vanguard@local', 'commit', '--no-verify', '-m', `vanguard: instruction files from ${opts.ref}@${sha.slice(0, 7)}`]),
      { cwd: worktreePath },
    );
  }

  log.info(
    { ref: opts.ref, sha, written: defaultPaths.length, removed: removed.length, differing },
    `instructions: taken from ${opts.ref}@${sha.slice(0, 7)}, not the base`,
  );

  return { ref: opts.ref, sha, written: defaultPaths, removed, differing };
}
