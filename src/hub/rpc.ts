// POST /rpc/:cmd dispatch table. Every handler that takes a repoPath resolves it through
// ProjectAllowlist.assertAllowed first (src/hub/allowlist.ts) — see docs/hub.md and the tech spec's
// "New in slice 1: the repo allowlist" section for why this is pulled forward from wave 2.
import { execa } from 'execa';
import {
  BadRequestError,
  invokeCoreMethod,
  validateCoreMethod,
  classifyCoreError,
  type SidecarDeps,
  type CreateRunParams,
  type CreateTaskParams,
} from '../sidecar/sidecar.js';
import { ProjectAllowlist, assertGitWorkTreeDir, assertMutationsAllowed, type BindOptions } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import type { RunSession } from './run-session.js';
import { CompleteRegistry, type CompleteParams } from './complete.js';
import { assertWithinBrowseRoot, browseDirs } from './browse.js';
import { cloneProject } from './clone.js';
import type { ErrorKind } from '../hub-wire.js';
import { defaultRunsRoot, remoteRunsRoot, listRunSummaries, readRunDetail } from './runs.js';
import { listActive, readSession } from './active.js';
import { readAppConfig, readAppConfigStrict, writeAppConfig, type AppConfig } from './app-config.js';
import * as drafts from './drafts.js';
import * as projects from './projects.js';
import * as remote from './remote.js';

export class UnknownCommandError extends BadRequestError {}

/** The Fleet screen (`spawn_run` et al) is dropped in hub mode: `spawn_run` executes arbitrary
 * shell, which is remote code execution on a reachable server. */
export const FLEET_DISABLED_MESSAGE = 'the Fleet screen is not available in hub mode';

export interface RpcContext {
  allowlist: ProjectAllowlist;
  watchRegistry: WatchRegistry;
  runSession: RunSession;
  completeRegistry: CompleteRegistry;
  deps: SidecarDeps;
  configDir: string;
  browseRoot: string;
  bind: BindOptions;
  /** Hosts `clone_project` accepts beyond `DEFAULT_CLONE_HOSTS` (a self-hosted GitHub/GitLab). */
  cloneHosts?: readonly string[];
  /** Publish a server->client event (wired to the hub's EventBus). */
  publish: (name: string, payload: unknown) => void;
}

function obj(rawArgs: unknown): Record<string, unknown> {
  return (rawArgs ?? {}) as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestError(`${key} is required and must be a non-blank string`);
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

/** `read_run`'s `source` (wire's `RunSource`) → the root the records live under: the project's own
 * `.vanguard/runs`, or a CI run's imported `.vanguard/remote-runs/<id>`. The client never names a
 * root — the same discriminant resolves against the Tauri cache dir on the desktop side. */
function runSourceRoot(repoPath: string, raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.kind === 'local') return defaultRunsRoot(repoPath);
  if (source.kind === 'ci' && typeof source.runId === 'number') return remoteRunsRoot(repoPath, source.runId);
  throw new BadRequestError("source is required and must be { kind: 'local' } or { kind: 'ci', runId: number }");
}

async function repoOk(repoPath: string): Promise<boolean> {
  try {
    const res = await execa('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/** Commands disabled in hub mode — the Fleet screen's shell-spawn surface. */
export const DISABLED_COMMANDS = ['spawn_run', 'kill_run', 'list_spawns'] as const;

/**
 * Dispatch one RPC command. Returns the raw result (never `undefined` — void commands resolve
 * `null`) or throws: `BadRequestError`/`FlowError`/`VanguardError` classify `bad-request`,
 * `UnknownCommandError` (a BadRequestError subtype) is additionally mapped to 404 by the caller,
 * anything else classifies `internal`. See `classifyError` below.
 */
export async function dispatchRpc(ctx: RpcContext, cmd: string, rawArgs: unknown): Promise<unknown> {
  const args = obj(rawArgs);

  if ((DISABLED_COMMANDS as readonly string[]).includes(cmd)) {
    throw new BadRequestError(FLEET_DISABLED_MESSAGE);
  }

  switch (cmd) {
    case 'list_runs': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return listRunSummaries(defaultRunsRoot(real));
    }
    case 'read_run': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      const timestamp = requireString(args, 'timestamp');
      return readRunDetail(runSourceRoot(real, args.source), taskId, timestamp);
    }
    case 'list_projects': {
      return projects.list(ctx.configDir);
    }
    case 'add_project': {
      assertMutationsAllowed(ctx.bind);
      const path = requireString(args, 'path');
      await assertWithinBrowseRoot(ctx.browseRoot, path);
      await assertGitWorkTreeDir(path);
      return projects.add(ctx.configDir, path);
    }
    case 'clone_project': {
      assertMutationsAllowed(ctx.bind);
      const url = requireString(args, 'url');
      const parentDir = requireString(args, 'parentDir');
      const name = optionalString(args, 'name');
      const target = await cloneProject(
        ctx.browseRoot,
        { url, parentDir, name },
        { allowedHosts: ctx.cloneHosts, onProgress: (line) => ctx.publish('vanguard:clone-progress', { line }) },
      );
      await assertGitWorkTreeDir(target);
      await projects.add(ctx.configDir, target);
      return projects.aggregate(target);
    }
    case 'remove_project': {
      const path = requireString(args, 'path');
      return projects.remove(ctx.configDir, path);
    }
    case 'list_active': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return listActive(real);
    }
    case 'read_session': {
      const sessionFile = requireString(args, 'sessionFile');
      const real = await ctx.allowlist.assertSessionPath(sessionFile);
      return readSession(real);
    }
    case 'read_app_config': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return readAppConfig(real);
    }
    case 'read_app_config_strict': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return readAppConfigStrict(real);
    }
    case 'write_app_config': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const config = args.config;
      if (typeof config !== 'object' || config === null) throw new BadRequestError('config is required');
      await writeAppConfig(real, config as AppConfig);
      return null;
    }
    case 'list_drafts': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return drafts.list(real);
    }
    case 'read_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return drafts.read(real, requireString(args, 'id'));
    }
    case 'write_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.write(real, requireString(args, 'id'), requireString(args, 'content'));
      return null;
    }
    case 'delete_draft': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.del(real, requireString(args, 'id'));
      return null;
    }
    case 'write_draft_asset': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const id = requireString(args, 'id');
      const name = requireString(args, 'name');
      const bytesRaw = args.bytes;
      if (!Array.isArray(bytesRaw)) throw new BadRequestError('bytes is required and must be an array of numbers');
      return drafts.writeAsset(real, id, name, Uint8Array.from(bytesRaw as number[]));
    }
    case 'clear_draft_assets': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      await drafts.clearAssets(real, requireString(args, 'id'));
      return null;
    }
    case 'list_remote_runs': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return remote.listRemoteRuns(real);
    }
    case 'import_remote_run': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const runId = optionalNumber(args, 'runId');
      if (runId === undefined) throw new BadRequestError('runId is required and must be a number');
      return remote.fetchRemoteRun(real, runId);
    }
    case 'list_tasks': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listTasks', { repoPath: real });
    }
    case 'fetch_spec': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const taskId = requireString(args, 'taskId');
      return invokeCoreMethod(ctx.deps, 'fetchSpec', { repoPath: real, taskId });
    }
    case 'watch_project': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      ctx.watchRegistry.watchProject(real, (p) => ctx.publish('vanguard:changed', p));
      return null;
    }
    case 'unwatch_project': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      ctx.watchRegistry.unwatchProject(real);
      return null;
    }
    case 'api_capabilities': {
      return invokeCoreMethod(ctx.deps, 'capabilities', undefined);
    }
    case 'api_create_run': {
      const params = (args.params ?? {}) as Record<string, unknown>;
      const real = await ctx.allowlist.assertAllowed(requireString(params, 'repoPath'));
      // The run session (not deps.createRun) owns single-in-flight gating and event
      // buffering/publishing — validate via the table row, then call it directly.
      const validated = validateCoreMethod('createRun', { ...params, repoPath: real });
      return ctx.runSession.createRun(validated as CreateRunParams);
    }
    case 'api_active_run': {
      return ctx.runSession.activeRun();
    }
    case 'api_run_backlog': {
      return ctx.runSession.backlog(requireString(args, 'runId'));
    }
    case 'api_cancel': {
      ctx.runSession.cancel();
      return null;
    }
    case 'api_create_task': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      // The client never chooses the tracker: source/team/label are read server-side from app.json.
      // `createTask`'s own validator (not a re-typed check here) rejects a bad source/missing team.
      const cfg = await readAppConfig(real);
      const params: CreateTaskParams = {
        source: cfg.source ?? 'github',
        repoPath: real,
        title,
        body,
        ...(cfg.label !== undefined ? { labels: [cfg.label] } : {}),
        ...(cfg.team !== undefined ? { team: cfg.team } : {}),
      };
      return invokeCoreMethod(ctx.deps, 'createTask', params);
    }
    case 'api_list_flows': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listFlows', { repoPath: real });
    }
    case 'api_list_providers': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listProviders', { repoPath: real });
    }
    case 'api_read_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'readFlow', { repoPath: real, file });
    }
    case 'api_write_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'writeFlow', { repoPath: real, file, doc: args.doc });
    }
    case 'api_delete_flow': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const file = requireString(args, 'file');
      return invokeCoreMethod(ctx.deps, 'deleteFlow', { repoPath: real, file });
    }
    case 'api_list_repo_files': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      return invokeCoreMethod(ctx.deps, 'listRepoFiles', { repoPath: real });
    }
    case 'api_read_repo_file': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const path = requireString(args, 'path');
      return invokeCoreMethod(ctx.deps, 'readRepoFile', { repoPath: real, path });
    }
    case 'api_repo_ok': {
      const repoPath = requireString(args, 'repoPath');
      try {
        const real = await ctx.allowlist.assertAllowed(repoPath);
        return repoOk(real);
      } catch {
        return false;
      }
    }
    case 'api_complete': {
      const real = await ctx.allowlist.assertAllowed(requireString(args, 'repoPath'));
      const reqRaw = args.req;
      if (typeof reqRaw !== 'object' || reqRaw === null) throw new BadRequestError('req is required');
      const reqObj = reqRaw as Record<string, unknown>;
      if (typeof reqObj.model !== 'string') throw new BadRequestError('req.model is required');
      // ALLOWLIST, not Omit<>: only these fields cross into the child's request, exactly like
      // ipc.ts's CompleteParams (baseUrl/assetRoot are never read from the caller — see complete.ts).
      const params: CompleteParams = {
        messages: reqObj.messages,
        model: reqObj.model,
        ...(reqObj.system !== undefined ? { system: reqObj.system } : {}),
        ...(reqObj.attachments !== undefined ? { attachments: reqObj.attachments } : {}),
      };
      return ctx.completeRegistry.complete(real, params, optionalString(args, 'callId'));
    }
    case 'api_cancel_complete': {
      ctx.completeRegistry.cancel(requireString(args, 'callId'));
      return null;
    }
    case 'browse_dirs': {
      assertMutationsAllowed(ctx.bind);
      return browseDirs(ctx.browseRoot, optionalString(args, 'path'));
    }
    default:
      throw new UnknownCommandError(`unknown command: ${cmd}`);
  }
}

/** Classify a thrown value for the wire, on top of `classifyCoreError`'s message/kind (the one
 * place that pairing lives — see `src/sidecar/sidecar.ts`): adds the 404 hint the HTTP layer wants
 * for an unknown command. */
export function classifyError(err: unknown): { message: string; kind: ErrorKind; notFound: boolean } {
  const notFound = err instanceof UnknownCommandError;
  const { message, kind } = classifyCoreError(err);
  return { message, kind, notFound };
}
