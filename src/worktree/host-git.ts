/**
 * Config pinned on every host-side git command that runs in (or creates) a run worktree. Copy-back
 * writes sandbox files into that worktree, and git resolves a relative `core.hooksPath` (husky's
 * `.husky/_`) and a relative `core.fsmonitor` command against the worktree root, so without these
 * the host would execute whatever file sits at that path. `--no-verify` covers only pre-commit,
 * commit-msg and pre-push; post-commit, reference-transaction, post-checkout, post-rewrite and
 * post-index-change still run.
 *
 * `/dev/null` is the simplest hooks directory that is always empty: `/dev/null/<hook>` never exists
 * (ENOTDIR), nothing can be created under it, and there is no temp dir to create or clean up.
 */
const HOST_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
];

/** `git` argv with the hardening `-c` pairs prepended, e.g. `execa('git', hostGitArgs(['commit', …]))`. */
export function hostGitArgs(args: readonly string[]): string[] {
  return [...HOST_GIT_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...args];
}

/**
 * The same config as `GIT_CONFIG_*` env entries, for tools that spawn git themselves in a worktree
 * (`gh pr create` runs `git status` there). Appended after any entries `base` already carries.
 */
export function hostGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const parsed = Number.parseInt(base['GIT_CONFIG_COUNT'] ?? '', 10);
  const start = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + HOST_GIT_CONFIG.length) };
  HOST_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return env;
}
