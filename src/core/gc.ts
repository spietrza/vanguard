import { execa } from 'execa';
import { VANGUARD_BRANCH_PREFIX } from '../worktree/manager.js';

export interface ContainerInfo {
  id: string;
  ageMs: number;
}

export type ContainerLister = () => Promise<ContainerInfo[]>;
export type ContainerRemover = (id: string) => Promise<void>;

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Remove vanguard-labeled sandbox containers older than maxAgeMs. Lister/remover are
 * injected so this is unit-testable without Docker. Returns the removed container ids.
 */
export async function reapContainers(
  lister: ContainerLister,
  remover: ContainerRemover,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<string[]> {
  const stale = (await lister()).filter((container) => container.ageMs > maxAgeMs);
  const ids = stale.map((container) => container.id);
  await Promise.all(ids.map(remover));
  return ids;
}

/** Docker-backed lister of vanguard-labeled containers with their age in ms. */
export function dockerContainerLister(now: () => number = Date.now): ContainerLister {
  return async (): Promise<ContainerInfo[]> => {
    const { stdout } = await execa('docker', [
      'ps',
      '-a',
      '--filter',
      'label=vanguard.runId',
      '--format',
      '{{.ID}}\t{{.CreatedAt}}',
    ]);
    if (stdout.trim() === '') return [];
    return stdout
      .split('\n')
      .map((line): ContainerInfo => {
        const [id, createdAt] = line.split('\t');
        const created = createdAt !== undefined ? Date.parse(createdAt) : Number.NaN;
        const ageMs = Number.isNaN(created) ? 0 : now() - created;
        return { id: id ?? '', ageMs };
      })
      .filter((container) => container.id !== '');
  };
}

/** Docker-backed remover (force-remove, ignore missing). */
export function dockerContainerRemover(): ContainerRemover {
  return async (id: string): Promise<void> => {
    await execa('docker', ['rm', '-f', id], { reject: false });
  };
}

export type NetworkLister = () => Promise<string[]>;
export type NetworkRemover = (name: string) => Promise<void>;

/**
 * Remove orphaned vg-egr-* Docker networks (no attached containers). Lister returns only
 * networks already confirmed to have no containers, so the remover is called on all of them.
 * Lister/remover are injected so this is unit-testable without Docker. Returns removed names.
 */
export async function reapEgressNetworks(lister: NetworkLister, remover: NetworkRemover): Promise<string[]> {
  const orphans = await lister();
  await Promise.all(orphans.map(remover));
  return orphans;
}

/**
 * Whether `docker network inspect --format '{{len .Containers}} {{.Created.Unix}}'` output describes a network
 * with no containers that is older than maxAgeMs. Unix seconds, because a network's `{{.Created}}` renders
 * Go's `2026-09-25 06:59:59.123456789 +0000 UTC`, which has spaces and no reliable Date.parse reading. The age check keeps a gc in one job from removing a
 * network another job created moments ago and has not attached its first container to yet. An unreadable
 * creation time counts as young, so the network is kept.
 */
export function isStaleEmptyNetwork(inspect: string, maxAgeMs: number, now: number): boolean {
  const [count, createdAt] = inspect.trim().split(' ');
  if (count !== '0' || createdAt === undefined || !/^\d+$/.test(createdAt)) return false;
  return now - Number(createdAt) * 1000 > maxAgeMs;
}

/**
 * How long an empty egress network is kept. The race it covers (a concurrent job between `network create`
 * and its first `network connect`) is seconds wide, so minutes, independent of --max-age-hours: a
 * `--max-age-hours 0` cleanup must not reopen that race.
 */
export const EGRESS_NETWORK_GRACE_MS = 10 * 60 * 1000;

/**
 * Docker-backed lister of vg-egr-* networks that have no attached containers and are older than maxAgeMs.
 * Networks whose inspect output cannot be read are kept, and one warning names them, so an engine that
 * rejects the template shows up instead of quietly reaping nothing.
 */
export function dockerEgressNetworkLister(
  maxAgeMs = EGRESS_NETWORK_GRACE_MS,
  now: () => number = Date.now,
  warn: (line: string) => void = console.warn,
): NetworkLister {
  return async (): Promise<string[]> => {
    const { stdout } = await execa('docker', ['network', 'ls', '--filter', 'name=vg-egr-', '--format', '{{.Name}}']);
    if (stdout.trim() === '') return [];
    const names = stdout.split('\n').filter((n) => n.startsWith('vg-egr-'));
    const unreadable: string[] = [];
    const results = await Promise.all(
      names.map(async (name) => {
        const inspect = await execa(
          'docker',
          ['network', 'inspect', name, '--format', '{{len .Containers}} {{.Created.Unix}}'],
          { reject: false },
        );
        const out = inspect.stdout ?? '';
        // Removed since `network ls` (another job's gc or after_script): nothing to keep or warn about.
        if (inspect.exitCode !== 0 && /no such network|network \S+ not found/i.test(inspect.stderr ?? '')) return null;
        if (!/^\d+ \d+$/.test(out.trim())) {
          unreadable.push(`${name} (${(inspect.stderr ?? '').trim() || 'no output'})`);
          return null;
        }
        return isStaleEmptyNetwork(out, maxAgeMs, now()) ? name : null;
      }),
    );
    if (unreadable.length > 0) {
      warn(`gc: kept ${unreadable.length} vg-egr-* network(s) whose inspect output could not be read: ${unreadable.join(', ')}`);
    }
    return results.filter((name): name is string => name !== null);
  };
}

/** Docker-backed remover for egress networks (ignore missing). */
export function dockerEgressNetworkRemover(): NetworkRemover {
  return async (name: string): Promise<void> => {
    await execa('docker', ['network', 'rm', name], { reject: false });
  };
}

/** Prune git worktree admin entries whose directories were removed. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await execa('git', ['worktree', 'prune'], { cwd: repoPath, reject: false });
}

export interface RemoteBranchInfo {
  name: string;
  ageMs: number;
  /** The branch's current tip commit; a PR proves the branch finished only when its head is this commit. */
  sha?: string;
}

export type RemoteBranchLister = () => Promise<RemoteBranchInfo[]>;
export type MergedChecker = (branch: string, tipSha?: string) => Promise<boolean>;
export type AbandonedChecker = (branch: string, tipSha?: string) => Promise<boolean>;
export type RemoteBranchRemover = (branch: string) => Promise<void>;

export type ReapBranchOpts =
  | { abandoned?: false; isAbandoned?: never }
  | { abandoned: true; isAbandoned: AbandonedChecker };

const PR_CHECK_CONCURRENCY = 8;

/** Map with a bounded concurrency so a large branch backlog does not spawn one `gh` per branch at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/**
 * Delete stale remote `vanguard/*` branches left behind by merged runs (each run uses a unique
 * branch, so they accumulate). A branch is reaped only when it is older than maxAgeMs AND its PR was
 * MERGED — a branch that was never merged (closed/abandoned, or still under review with no PR yet) is
 * always kept. The merged check runs only for aged candidates, bounded to a small concurrency.
 * When opts.abandoned is true (opts.isAbandoned is required by the type), branches with a
 * closed-unmerged PR are also reaped. Lister/checker/remover are injected so this is unit-testable without git/gh.
 * Returns removed names.
 */
export async function reapRemoteBranches(
  lister: RemoteBranchLister,
  isMerged: MergedChecker,
  remover: RemoteBranchRemover,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  opts?: ReapBranchOpts,
): Promise<string[]> {
  const aged = (await lister()).filter((branch) => branch.ageMs > maxAgeMs);
  const names = (
    await mapLimit(aged, PR_CHECK_CONCURRENCY, async (branch) => {
      if (await isMerged(branch.name, branch.sha)) return branch.name;
      if (opts?.abandoned && (await opts.isAbandoned(branch.name, branch.sha))) return branch.name;
      return null;
    })
  ).filter((name): name is string => name !== null);
  await Promise.all(names.map(remover));
  return names;
}

/** Git-backed lister of remote `vanguard/*` branches with their age (from the last commit date). */
export function gitRemoteBranchLister(
  repoPath: string,
  opts: { remote?: string; prefix?: string; now?: () => number } = {},
): RemoteBranchLister {
  const remote = opts.remote ?? 'origin';
  const prefix = opts.prefix ?? VANGUARD_BRANCH_PREFIX;
  const now = opts.now ?? Date.now;
  return async (): Promise<RemoteBranchInfo[]> => {
    // Trailing `*` makes this an fnmatch glob: the `vanguard-` marker sits mid-component (chore/vanguard-…),
    // so a plain prefix would not match on a slash boundary the way the old `vanguard/` prefix did.
    const { stdout } = await execa(
      'git',
      ['for-each-ref', '--format', '%(refname:short)\t%(committerdate:unix)\t%(objectname)', `refs/remotes/${remote}/${prefix}*`],
      { cwd: repoPath },
    );
    return stdout
      .split('\n')
      .map((line): RemoteBranchInfo => {
        const [short = '', unix, sha] = line.split('\t');
        // refname:short is `<remote>/vanguard/<x>`; strip the remote so the name works with gh/push.
        const name = short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : short;
        const created = Number(unix) * 1000;
        const ageMs = Number.isFinite(created) ? now() - created : 0; // unparseable date -> treat as new (keep)
        return { name, ageMs, ...(sha !== undefined && sha !== '' ? { sha } : {}) };
      })
      .filter((branch) => branch.name !== '');
  };
}

export interface HeadPr {
  state?: string;
  headRefOid?: string;
}

/**
 * Whether the PRs sharing a branch's head name prove it finished: a PR in `state` whose head commit
 * IS the branch's current tip, and no OPEN PR on that head name. A head name alone is not enough —
 * a fork or a later run can reuse it, and the live branch must survive. No tip known → keep.
 */
export function prsProveFinished(prs: readonly HeadPr[], state: 'MERGED' | 'CLOSED', tipSha: string | undefined): boolean {
  if (tipSha === undefined || tipSha === '') return false;
  if (prs.some((pr) => pr.state === 'OPEN')) return false;
  return prs.some((pr) => pr.state === state && pr.headRefOid === tipSha);
}

/** Shared gh pr-list check. Conservative: on any gh error returns false so the branch is kept. */
function ghPrChecker(state: 'MERGED' | 'CLOSED', repoPath: string, repoSlug?: string) {
  return async (branch: string, tipSha?: string): Promise<boolean> => {
    const args = ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json', 'state,headRefOid'];
    if (repoSlug !== undefined) args.push('--repo', repoSlug);
    const result = await execa('gh', args, { cwd: repoPath, reject: false });
    if (result.exitCode !== 0) return false;
    try {
      const prs = JSON.parse(result.stdout) as unknown;
      return Array.isArray(prs) && prsProveFinished(prs as HeadPr[], state, tipSha);
    } catch {
      return false;
    }
  };
}

/** gh-backed merged-PR checker. Conservative: on any gh error it reports NOT merged, so the branch is kept. */
export function ghMergedPrChecker(repoPath: string, repoSlug?: string): MergedChecker {
  return ghPrChecker('MERGED', repoPath, repoSlug);
}

/** gh-backed closed-unmerged-PR checker. Conservative: on any gh error it reports NOT abandoned, so the branch is kept. */
export function ghAbandonedPrChecker(repoPath: string, repoSlug?: string): AbandonedChecker {
  return ghPrChecker('CLOSED', repoPath, repoSlug);
}

/** Git-backed remover that deletes the branch on the remote (ignores missing). */
export function gitRemoteBranchRemover(repoPath: string, remote: string = 'origin'): RemoteBranchRemover {
  return async (branch: string): Promise<void> => {
    await execa('git', ['push', remote, '--delete', branch], { cwd: repoPath, reject: false });
  };
}
