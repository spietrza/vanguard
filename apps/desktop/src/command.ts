import type { AppConfig } from './vanguard-output';
import { FLOW_NAME_RE } from './wire';
import { SOURCES } from './sources';

/**
 * The single source of truth for the `vanguard` commands the desktop app launches.
 * Three call sites used to hardcode `--provider zai --llm-proxy` and drift apart; they all
 * route through here now.
 *
 * `--llm-proxy` is deliberately NOT emitted: it is provider-specific (the sidecar owns the
 * Claude CLI transport), wrong for the subscription/OAuth providers most runs use, and rejected
 * outright by direct-only providers like meridian. The New Run command is editable, so a zai /
 * openrouter user adds `--llm-proxy` by hand.
 * ponytail: no per-provider proxy gating until a validated provider→proxy classification exists.
 *
 * `provider` and `source` come from the project's `.vanguard/app.json`, which is repo content: both
 * are checked against a strict grammar here, before any command is built.
 */

/** Provider used when a project hasn't set one — a working local default (subscription/OAuth). */
export const DEFAULT_PROVIDER = 'claude';

/** `--max-turns` lifts the 12-turn implementer cap so non-trivial tasks can actually complete. */
const MAX_TURNS = 30;

/**
 * The configured provider, validated: a built-in or custom provider name (FLOW_NAME_RE — the one
 * repo-configured-name grammar). Throws on anything else, so shell syntax or a `--flag` can never
 * ride along as the provider value.
 */
const provider = (cfg: AppConfig): string => {
  const p = cfg.provider ?? DEFAULT_PROVIDER;
  if (!FLOW_NAME_RE.test(p)) throw new Error(`Invalid provider "${p}" — pick one in Settings.`);
  return p;
};

const checkSource = (source: string): string => {
  if (!SOURCES.includes(source)) {
    throw new Error(`Invalid Task Source "${source}" — set github / gitlab / linear in Settings.`);
  }
  return source;
};

/** Default `vanguard run` command for a New Run — `<issue>` is left for the user to fill. */
export function runCommand(cfg: AppConfig, source: string = cfg.source ?? 'github'): string {
  return `vanguard run --${checkSource(source)} <issue> --provider ${provider(cfg)} --max-turns ${MAX_TURNS}`;
}

/**
 * Fleet watch-loop argv (program first). Spawned without a shell (`spawn_run`), so each element is
 * one argument; the config-derived ones are validated as well. Throws on an invalid source/provider.
 */
export function watchArgv(
  cfg: AppConfig,
  opts: { source: string; concurrency: number; loopV1: boolean },
): string[] {
  const n = Math.max(1, Math.floor(opts.concurrency) || 1);
  return [
    'vanguard',
    'watch',
    `--${checkSource(opts.source)}`,
    '--concurrency',
    String(n),
    ...(opts.loopV1 ? ['--loop-v1'] : []),
    '--provider',
    provider(cfg),
    '--max-turns',
    String(MAX_TURNS),
  ];
}

/** Fleet watch-loop command, for display (the argv joined with spaces). */
export function watchCommand(
  cfg: AppConfig,
  opts: { source: string; concurrency: number; loopV1: boolean },
): string {
  return watchArgv(cfg, opts).join(' ');
}

/** Quick-fill presets for the New Run form, one per task source. */
export function runPresets(cfg: AppConfig): { label: string; cmd: string }[] {
  return [
    { label: 'Run issue', cmd: runCommand(cfg, 'github') },
    { label: 'Run (GitLab MR)', cmd: runCommand(cfg, 'gitlab') },
    { label: 'Run (Linear)', cmd: runCommand(cfg, 'linear') },
  ];
}
