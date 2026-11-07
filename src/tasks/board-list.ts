import { readStageMarkers } from '../core/run-stage-marker.js';
import { latestRunChips } from './board-chips.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { VanguardError, visibleError } from '../core/errors.js';
import { detectRepoSlug } from '../runners/github.js';
import { parseGitlabProjectFromRemote } from '../runners/gitlab.js';
import { GitHubTaskFetcher } from './github.js';
import { GitLabTaskFetcher } from './gitlab.js';
import { LinearCliTaskFetcher, linearGraphql } from './linear-cli.js';
import { columnFor, mintBoardId, resolveTaskRef, taskRefKey, toBoardTask } from './board.js';
import type { BoardSource } from './board.js';
import type { TaskFetcher } from './fetcher.js';
import type { BoardTask } from '../wire.js';

export { columnFor, mintBoardId, resolveTaskRef, toBoardTask };

/** One page — the board renders 50 and banners the cap; more is never fetched (watchdog budget). */
export const BOARD_FETCH_CAP = 50;

/**
 * The board's slice of `.vanguard/app.json` (`source`/`team`/`label`), read leniently like
 * `loadCustomProviders` — the desktop owns the file; core reads exactly what it needs.
 */
export interface BoardConfig {
  source?: string;
  team?: string;
  label?: string;
}

export async function readBoardConfig(repoPath: string): Promise<BoardConfig> {
  let raw: string;
  try {
    raw = await readFile(join(repoPath, '.vanguard', 'app.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const rec = parsed as Record<string, unknown>;
    const out: BoardConfig = {};
    if (typeof rec.source === 'string' && rec.source !== '') out.source = rec.source;
    if (typeof rec.team === 'string' && rec.team !== '') out.team = rec.team;
    if (typeof rec.label === 'string' && rec.label !== '') out.label = rec.label;
    return out;
  } catch {
    return {}; // passive read — an unreadable file degrades like the desktop's appconfig::read
  }
}

function requireBoardSource(cfg: BoardConfig): BoardSource {
  const source = cfg.source;
  if (source === 'github' || source === 'gitlab' || source === 'linear') return source;
  // Explicit prompt, NOT createTask's github default: a board silently reading the wrong tracker
  // is worse than asking (S9 spec §2.7).
  throw new VanguardError('Set a Task Source in Settings to load the board.');
}

async function originRemote(repoPath: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
  return stdout.trim();
}

/**
 * A remote URL safe to put in an error message: HTTPS remotes routinely embed credentials
 * (`https://oauth2:glpat-xxx@gitlab.com/...`), and the detection-failure paths are exactly the
 * hand-configured remotes most likely to carry one — echoing it verbatim would ship the token to
 * the board UI and any log (review #346 r2). Redacts userinfo; falls back to a regex strip for
 * non-URL remotes (ssh shorthand has no userinfo password, but strip defensively anyway).
 */
function redactRemote(remote: string): string {
  try {
    const url = new URL(remote);
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';
      return `${url.href} (credentials redacted)`;
    }
    return remote;
  } catch {
    return remote.replace(/\/\/[^@/]+@/, '//<redacted>@');
  }
}

async function githubSlug(repoPath: string): Promise<string> {
  try {
    return await detectRepoSlug(repoPath);
  } catch {
    const remote = await originRemote(repoPath).catch(() => '<no origin remote>');
    // Declared limitation (S9 spec §2.8): detection is github.com-only; Enterprise is trigger-gated.
    throw new VanguardError(`could not detect a github.com repo from origin (${redactRemote(remote)}) — the board supports github.com remotes.`);
  }
}

async function gitlabProject(repoPath: string): Promise<string> {
  const remote = await originRemote(repoPath).catch(() => {
    throw new VanguardError('no origin remote — the board needs one to find the GitLab project.');
  });
  const project = parseGitlabProjectFromRemote(remote);
  if (project === undefined) throw new VanguardError(`cannot detect a GitLab project from origin (${redactRemote(remote)}).`);
  return project;
}

/**
 * Confirm the configured Linear team key resolves — scoped to the BOARD only, never the shared
 * list() path (an unconditional probe would flip `vanguard watch` from idles-on-empty to
 * throws-every-poll on a typo'd key — S9 spec §2.7c). Linear returns an empty issue set for a
 * wrong key exactly as for an empty team, so without this a typo looks like "0 issues".
 */
async function assertLinearTeam(team: string, send: Awaited<ReturnType<typeof linearGraphql>>): Promise<void> {
  const response = (await send({
    query: 'query($tf: TeamFilter) { teams(filter: $tf) { nodes { id } } }',
    variables: { tf: { key: { eq: team } } },
  })) as { data?: { teams?: { nodes?: unknown[] } } };
  if ((response.data?.teams?.nodes ?? []).length === 0) {
    throw new VanguardError(`No Linear team with key \`${team}\` — check the team key in Settings.`);
  }
}

/**
 * The board's TaskFilter per source — PURE and test-pinned, because getting it wrong is silent:
 * `state: 'all'` for github/gitlab (Done fills from closed issues — the declared glab parity
 * change, spec §2.3), NEVER for Linear (its state filter is a workflow-state TYPE compared with
 * `eq`; 'all' matches nothing ⇒ silently empty board — spec §2.2, blocking).
 */
export function boardFilterFor(source: BoardSource, label?: string): { state?: string; labels?: string[]; limit: number } {
  const labels = label !== undefined ? { labels: [label] } : {};
  if (source === 'linear') return { limit: BOARD_FETCH_CAP, ...labels };
  return { state: 'all', limit: BOARD_FETCH_CAP, ...labels };
}

/** Injectable fetcher construction (tests swap it; production resolves slugs/teams for real). */
export type BoardFetcherFactory = (source: BoardSource, cfg: BoardConfig, repoPath: string) => Promise<TaskFetcher>;

const defaultFetcherFactory: BoardFetcherFactory = async (source, cfg, repoPath) => {
  if (source === 'github') return new GitHubTaskFetcher(await githubSlug(repoPath));
  if (source === 'gitlab') return new GitLabTaskFetcher(await gitlabProject(repoPath));
  const team = cfg.team;
  if (team === undefined) throw new VanguardError('Set a Linear team key (e.g. DEV) in Settings to load the board.');
  // ONE credential resolution for probe + list — linearGraphql shells `linear auth token` when
  // LINEAR_API_KEY is unset, and doing that twice per board load is a subprocess per load wasted
  // (review #346 obs 3).
  const send = await linearGraphql();
  await assertLinearTeam(team, send);
  return new LinearCliTaskFetcher({ team, graphql: send });
};

/**
 * List the board's tasks from the configured tracker (S9 — the read path that used to live in
 * apps/desktop/src-tauri/src/tasks.rs). One page of BOARD_FETCH_CAP; `capped` drives the banner.
 */
export async function listBoardTasks(
  repoPath: string,
  fetcherFor: BoardFetcherFactory = defaultFetcherFactory,
): Promise<{ tasks: BoardTask[]; capped: boolean }> {
  const cfg = await readBoardConfig(repoPath);
  const source = requireBoardSource(cfg);
  const fetcher = await fetcherFor(source, cfg, repoPath);
  let tasks;
  try {
    tasks = await fetcher.list(boardFilterFor(source, cfg.label));
  } catch (error) {
    throw visibleError(error); // gh/glab auth failures must reach the board like Linear's do
  }
  // `capped` false-positives on EXACTLY cap items (a one-page budget cannot see page two) — the
  // banner reads "first 50 shown", which stays true; Rust-board parity (review #346 obs 4).
  const [markers, chips] = await Promise.all([
    readStageMarkers(repoPath).catch(() => new Map()),
    latestRunChips(repoPath).catch(() => new Map()),
  ]);
  const stages = new Map([...markers.values()].map((m) => [taskRefKey(m.taskId), m.stage]));
  return {
    tasks: tasks.map((task) => {
      const t = toBoardTask(source, task);
      const key = taskRefKey(t.id);
      const stage = stages.get(key);
      const verdicts = chips.get(key);
      return {
        ...t,
        ...(t.column === 'running' && stage !== undefined ? { stage } : {}),
        ...(verdicts !== undefined && verdicts.length > 0 ? { chips: verdicts } : {}),
      };
    }),
    capped: tasks.length >= BOARD_FETCH_CAP,
  };
}

/**
 * Fetch a task's spec (`# title\n\nbody`) from a board id OR a run-record taskId — the resolver's
 * trailing-number semantics accept both (`gh-904` and `gh-owner-repo-904`). Byte-compatible with
 * the retired spec.rs output; core fetch() is richer (comments, sub-issues) — v1 formats
 * title+body only, matching today's SpecPane.
 *
 * KNOWN LIMITATION (Rust-board parity, review #346 obs 2): the sanitized slug inside a run-record
 * id is DISCARDED — `gh-other-repo-904` fetches issue 904 of THIS repo, because `other-repo-904`
 * cannot be split back into owner/repo deterministically (hyphens are ambiguous) and the retired
 * spec.rs shelled `gh` in the repo cwd with exactly the same semantics. Cross-repo run records
 * only arise when .vanguard state is copied between repos.
 */
export async function fetchTaskSpec(repoPath: string, taskId: string): Promise<{ spec: string }> {
  const resolved = resolveTaskRef(taskId);
  if (resolved === undefined) {
    throw new VanguardError(
      `Couldn't resolve a Task Source from task id \`${taskId}\`. Recognized prefixes: \`gh-\` (GitHub), \`gl-\` (GitLab), \`linear-\` (Linear).`,
    );
  }
  const { source, reference } = resolved;
  let fetcher: TaskFetcher;
  if (source === 'github') fetcher = new GitHubTaskFetcher(await githubSlug(repoPath));
  else if (source === 'gitlab') fetcher = new GitLabTaskFetcher(await gitlabProject(repoPath));
  else {
    // Guard the Linear identifier before it reaches argv (spec.rs's flag-smuggling check, ported).
    if (reference.startsWith('-') || !reference.includes('-') || !/^[A-Za-z0-9-]+$/.test(reference)) {
      throw new VanguardError(`Invalid Linear id in task \`${taskId}\`.`);
    }
    fetcher = new LinearCliTaskFetcher({});
  }
  let task;
  try {
    task = await fetcher.fetch(reference);
  } catch (error) {
    throw visibleError(error);
  }
  return { spec: `# ${task.title}\n\n${task.description}`.trim() };
}
