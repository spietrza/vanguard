import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

export interface VerificationResult {
  command: string;
  exitCode: number;
  passed: boolean;
  sha256: string;        // over the combined stdout + stderr
  outputTail: string;    // last ~40 lines, for the PR body
}

const WORKDIR = '/workspace';

/** Marker files that indicate a Python project driven by pytest. */
const PYTHON_MARKERS = ['pyproject.toml', 'pytest.ini', 'setup.cfg'];

/** Type-check script names, in precedence order. */
const TYPECHECK_SCRIPTS = ['typecheck', 'check-types', 'type-check'];

/**
 * Resolve the verification command. Precedence: explicit cmd (CLI flag) > VANGUARD_VERIFY_CMD env >
 * a `verify` script in the worktree package.json > auto-detect from package.json's test/typecheck
 * scripts > auto-detect Python (pytest) markers > undefined (skip Proof of Work entirely — the
 * caller must render that skip visibly, not drop it silently).
 * JS auto-detect: if package.json has a `verify` script, build "<pm> install --frozen-lockfile &&
 * <pm> run verify" so the gate matches whatever a repo declares (e.g. the CI build job) instead of
 * our guess. Otherwise, if it has a `test` script, build "<pm> install --frozen-lockfile && <pm>
 * run typecheck && <pm> test", including the first of typecheck/check-types/type-check that exists;
 * pm from the `packageManager` field (pnpm/yarn/npm), default npm. Python auto-detect:
 * pyproject.toml/pytest.ini/setup.cfg present -> "pytest".
 */
export async function resolveVerifyCommand(
  worktreePath: string,
  opts: { cmd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  if (opts.cmd !== undefined && opts.cmd !== '') return opts.cmd;
  const envCmd = (opts.env ?? process.env).VANGUARD_VERIFY_CMD;
  if (envCmd !== undefined && envCmd !== '') return envCmd;

  let pkgRaw: string | undefined;
  try {
    pkgRaw = await readFile(join(worktreePath, 'package.json'), 'utf8');
  } catch {
    pkgRaw = undefined;
  }
  if (pkgRaw !== undefined) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
      const scripts = pkg.scripts ?? {};
      const field = pkg.packageManager ?? '';
      const pm = field.startsWith('pnpm') ? 'pnpm' : field.startsWith('yarn') ? 'yarn' : 'npm';
      const install = `${pm} install --frozen-lockfile`;
      if (scripts.verify !== undefined) return `${install} && ${pm} run verify`;
      if (scripts.test === undefined) return undefined;
      const parts = [install];
      // Turborepo-style monorepos name it check-types; without this the gate never type-checks them.
      const typecheck = TYPECHECK_SCRIPTS.find((name) => scripts[name] !== undefined);
      if (typecheck !== undefined) parts.push(`${pm} run ${typecheck}`);
      parts.push(`${pm} test`);
      return parts.join(' && ');
    } catch {
      return undefined;
    }
  }

  for (const marker of PYTHON_MARKERS) {
    try {
      await readFile(join(worktreePath, marker), 'utf8');
      return 'pytest';
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Rendered in the PR body when no verify command could be resolved, so a skipped gate is visible, not silent. */
export function verifySkippedBlock(): string {
  return [
    '## Proof of work: SKIPPED',
    '',
    'No verify command resolved (no package.json test script, no pytest markers, and no `VANGUARD_VERIFY_CMD`).',
  ].join('\n');
}

/** Run the command inside the sandbox (host-driven) and attest the result. */
export async function runVerification(
  sandbox: IsolatedSandboxProvider,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const sh = sandbox.exec.bind(sandbox);
  const res = await sh(command, { cwd: WORKDIR, ...(signal !== undefined ? { signal } : {}) });
  const output = `${res.stdout}\n${res.stderr}`;
  const sha256 = createHash('sha256').update(output).digest('hex');
  const outputTail = output.split('\n').slice(-40).join('\n').trimEnd();
  return { command, exitCode: res.exitCode, passed: res.exitCode === 0, sha256, outputTail };
}

/**
 * Minimal failing-witness feedback for the verification repair loop (CEGIS-style, mirrors
 * renderConformanceFeedback): just the command, exit code, and output tail, so the resumed
 * implement session stays small and targeted.
 */
export function renderVerificationFeedback(result: VerificationResult): string {
  return [
    'The verification command failed. Make it pass:',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    '',
    'Output tail:',
    result.outputTail,
  ].join('\n');
}

/** Markdown Proof of Work block for the PR body. */
export function proofBlock(result: VerificationResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  // Fence-safe: output with a ``` line would close a 3-backtick block and inject PR-body markdown.
  // Use a fence one backtick longer than the longest run in the output (same as inlineAttachments).
  const longest = Math.max(0, ...[...result.outputTail.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [
    `## Proof of work: ${status}`,
    '',
    `- command: \`${result.command}\``,
    `- exit code: ${result.exitCode}`,
    `- sha256(output): \`${result.sha256}\``,
    '',
    '<details><summary>output tail</summary>',
    '',
    fence,
    result.outputTail,
    fence,
    '',
    '</details>',
  ].join('\n');
}
