// Port of apps/desktop/src-tauri/src/appconfig.rs — see that file for the original Rust implementation.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir, stateDir } from '../core/state-path.js';

/** The app's per-project config (`.vanguard/app.json`, spec §6). All optional; the CLI does not read
 * this — the app translates it into flags / a launch command. */
export interface AppConfig {
  source?: string;
  label?: string;
  /** Linear team key (e.g. `DEV`) — selects which team's issues the board lists. Linear-only;
   * GitHub/GitLab scope by repo + `label`. */
  team?: string;
  /** Per-project identity color (`#rrggbb`). When unset the app derives one from the repo path. */
  color?: string;
  provider?: string;
  reviewProvider?: string;
  verifyCmd?: string;
  concurrency?: number;
  budgetUsd?: number;
  runCommand?: string;
  /** Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; the API key is never
   * stored here (env only). Optional Anthropic-compatible base URL for a self-hosted proxy. */
  chatModel?: string;
  chatBaseUrl?: string;
  /** Opaque pass-through — deliberately `unknown`, NOT a typed array/shape. A typed field would
   * silently strip unknown entry keys on every settings save. Round-trip byte-for-byte. */
  customProviders?: unknown;
}

function configPath(repoPath: string): string {
  return join(repoPath, '.vanguard', 'app.json');
}

/** Passive read: ANY failure (missing file, unparseable, directory, permission) collapses to `{}`
 * (all-defaults). Used by board/chat/projects consumers that must never block on a bad file. */
export async function readAppConfig(repoPath: string): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(repoPath), 'utf8');
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {};
  }
}

/** Strict read (Settings' write-guard): a file that EXISTS but cannot be read/parsed is an error —
 * collapsing it to defaults would let a later Save silently replace the user's hand-edited file.
 * Genuine absence (ENOENT) still returns `{}`. Any other failure (parse error, EISDIR, EACCES,
 * any non-ENOENT error) throws an Error whose message starts with `.vanguard/app.json is unreadable: `. */
export async function readAppConfigStrict(repoPath: string): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(repoPath), 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') {
      return {};
    }
    throw new Error(`.vanguard/app.json is unreadable: ${String(e)}`);
  }
  try {
    return JSON.parse(raw) as AppConfig;
  } catch (e) {
    throw new Error(`.vanguard/app.json is unreadable: ${String(e)}`);
  }
}

/** Create `.vanguard/` if needed and write the config as pretty JSON (2-space indent) to
 * `.vanguard/app.json`. Overwrite fully (not a merge) — write exactly the object passed in. */
export async function writeAppConfig(repoPath: string, cfg: AppConfig): Promise<void> {
  // A repo-committed `.vanguard` (or `app.json`) symlink must not redirect the write out of the checkout.
  await ensureStateDir(repoPath, stateDir(repoPath));
  await assertStatePath(repoPath, configPath(repoPath));
  await writeFile(configPath(repoPath), JSON.stringify(cfg, null, 2));
}
