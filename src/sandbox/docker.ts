import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SandboxError } from '../core/errors.js';
import { ownerLabelArgs, sandboxSecurityOpts } from './limits.js';
import type { ExecOptions, ExecResult, ExecStream, IsolatedSandboxProvider, SandboxConfig } from './provider.js';

/**
 * Normalise an execa result into an `ExecResult`.
 *
 * With `reject: false`, execa hands back its error object for a subprocess that never ran or was
 * cancelled, and those carry `stdout`/`stderr` as `undefined` — nothing was ever buffered. The
 * declared `string` then lies to every consumer, and the first `.split('\n')` downstream throws a
 * bare `TypeError: Cannot read properties of undefined` from inside the consumer, burying the real
 * failure: `agents/codex.ts` crashed there on line 88 instead of reaching its own guard 35 lines
 * later, which would have reported the exit code and stderr. Coerce at the seam that declares the
 * contract, so callers can keep trusting the type.
 */
export function toExecResult(raw: {
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
}): ExecResult {
  return { stdout: raw.stdout ?? '', stderr: raw.stderr ?? '', exitCode: raw.exitCode ?? 1 };
}

const DEFAULT_IMAGE = 'vanguard-sandbox:latest';

/**
 * The sandbox image to run: `VANGUARD_SANDBOX_IMAGE` when set (CI passes the exact `sha256:...` ID it
 * just built, since the shared mutable `vanguard-sandbox:latest` tag on a shared Docker host can be
 * overwritten by another pipeline between build and run), else the mutable tag for local/dev use.
 */
export function sandboxImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['VANGUARD_SANDBOX_IMAGE'];
  if (override === undefined || override === '') return DEFAULT_IMAGE;
  // The image sits in docker's argv before the command, so a leading `-` would be read as a flag such as
  // --privileged. No valid image reference starts with `-` or contains whitespace.
  if (/^-|\s/.test(override)) throw new SandboxError(`VANGUARD_SANDBOX_IMAGE is not an image reference: ${JSON.stringify(override)}`);
  return override;
}

/**
 * Claude CLI the sandbox image is built with — keep in sync with docker/Dockerfile's
 * ARG CLAUDE_CLI_VERSION. The pin moves in the repo but a built image does not, and the drift only
 * surfaces deep inside a run as a gateway error (live case: 2.1.165 answered every Meridian request
 * with `400 This session advanced while the request was waiting`, burning ~50 min per attempt).
 */
export const SANDBOX_CLAUDE_VERSION = '2.1.260';

/** True when `actual` sorts below `expected`; unparseable parts count as older. */
export function isOlderVersion(actual: string, expected: string): boolean {
  const a = actual.split('.');
  const e = expected.split('.');
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    const x = Number(a[i] ?? 0);
    const y = Number(e[i] ?? 0);
    if (Number.isNaN(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}

/** Minimal command runner, injectable so the refresh can be exercised without Docker. */
export type DockerRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

const defaultDockerRunner: DockerRunner = async (cmd, args, opts) => {
  const { stdout } = await execa(cmd, args, { cwd: opts.cwd });
  return { stdout };
};

/**
 * Install the pinned claude CLI into an existing sandbox image, in place. Cheaper and far more
 * reliable than a rebuild behind a corporate MITM proxy, which breaks on the linear-cli release
 * tarball. The npm install needs root, but `docker commit` snapshots the CONTAINER's config — so the
 * original USER/WorkingDir are read first and restored, or the image would silently start running as
 * root and the CLI would then refuse to launch at all.
 */
export async function refreshSandboxClaudeCli(opts: { cwd: string; image?: string; run?: DockerRunner }): Promise<string> {
  const run = opts.run ?? defaultDockerRunner;
  const image = opts.image ?? sandboxImage();
  // `docker commit` onto an image ID or a digest reference cannot change what it names.
  const immutable = new SandboxError(
    `Cannot refresh ${image}: an image ID or digest is immutable. Rebuild the image, or unset VANGUARD_SANDBOX_IMAGE to refresh ${DEFAULT_IMAGE}.`,
  );
  if (/^(sha256:)?[a-f0-9]{12,64}$|@sha256:[a-f0-9]{64}$/.test(image)) throw immutable;
  const helper = 'vg-cli-refresh';
  const { cwd } = opts;

  const inspect = async (field: string): Promise<string> => {
    const { stdout } = await run('docker', ['image', 'inspect', image, '--format', `{{${field}}}`], { cwd });
    return stdout.trim();
  };
  // Docker also resolves a shorter unique prefix of an ID; only the engine can tell it from a hex repository name.
  const hex = /^(?:sha256:)?([a-f0-9]+)$/.exec(image)?.[1];
  if (hex !== undefined && (await inspect('.Id')).replace(/^sha256:/, '').startsWith(hex)) throw immutable;
  const user = await inspect('.Config.User');
  const workdir = await inspect('.Config.WorkingDir');

  await run('docker', ['rm', '-f', helper], { cwd }).catch(() => undefined);
  try {
    await run('docker', ['run', '--name', helper, '-u', '0', image, 'npm', 'install', '-g', `@anthropic-ai/claude-code@${SANDBOX_CLAUDE_VERSION}`], { cwd });
    const changes = [
      ...(user !== '' ? ['--change', `USER ${user}`] : []),
      ...(workdir !== '' ? ['--change', `WORKDIR ${workdir}`] : []),
    ];
    await run('docker', ['commit', ...changes, helper, image], { cwd });
  } finally {
    await run('docker', ['rm', '-f', helper], { cwd }).catch(() => undefined);
  }
  return SANDBOX_CLAUDE_VERSION;
}

/**
 * Once per process: refuse to run against an image whose bundled claude CLI predates the repo pin.
 * Checked here rather than in preflight because preflight only covers `watch`/`doctor` — `spec` and
 * `run` reach a sandbox without it. An image with no runnable `claude` is a deliberate custom image,
 * so it is skipped rather than failed. Escape hatch: VANGUARD_SKIP_IMAGE_CHECK=1.
 */
let claudeVersionChecked = false;
const DEFAULT_WORKDIR = '/workspace';
const DEFAULT_HOME = '/home/agent';
const SECRETS_DIR = '/run/vanguard';
const SECRETS_FILE = `${SECRETS_DIR}/secrets.env`;

type SecretsMode = 'tmpfs' | 'env-file';

const HOST_GATEWAY_NAME = 'host.docker.internal';

/** Runs an isolated command environment as a detached Docker container. */
export class DockerSandboxProvider implements IsolatedSandboxProvider {
  readonly id: string;
  private readonly image: string;
  private readonly workdir: string;
  private readonly config: SandboxConfig;
  private readonly secretsMode: SecretsMode;
  private readonly secrets: Record<string, string>;
  private envDir: string | undefined;
  private owner: string | undefined;
  private started = false;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
    this.id = randomUUID();
    this.image = config.image ?? sandboxImage();
    this.workdir = config.workdir ?? DEFAULT_WORKDIR;
    this.secretsMode = config.secretsMode ?? 'tmpfs';
    this.secrets = { ...config.secrets };
    for (const key of config.forwardEnv ?? []) {
      const value = process.env[key];
      if (value !== undefined) this.secrets[key] = value;
    }
    for (const [key, value] of Object.entries(this.secrets)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new SandboxError(`Invalid secret name: ${key}`);
      }
      if (/[\n\r]/.test(value)) {
        throw new SandboxError(`Secret ${key} contains a newline, which is not allowed`);
      }
    }
  }

  private get name(): string {
    return `vg-${this.id}`;
  }

  /** An explicit `hostGateway` wins; otherwise the alias is added only when some value handed to the
   * sandbox (env, secrets, forwarded env) names host.docker.internal. */
  private needsHostGateway(): boolean {
    if (this.config.hostGateway !== undefined) return this.config.hostGateway;
    const values = [...Object.values(this.config.env ?? {}), ...Object.values(this.secrets)];
    return values.some((value) => value.toLowerCase().includes(HOST_GATEWAY_NAME));
  }

  private get hasSecrets(): boolean {
    return Object.keys(this.secrets).length > 0;
  }

  /** Raw KEY=value lines for docker --env-file (parsed literally by docker, never by a shell). */
  private secretsBody(): string {
    return Object.entries(this.secrets)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  /** POSIX single-quoted KEY='value' lines, safe to `source` in a shell (no expansion or injection). */
  private secretsShellBody(): string {
    return Object.entries(this.secrets)
      .map(([key, value]) => `${key}='${value.replace(/'/g, "'\\''")}'`)
      .join('\n');
  }

  /** In tmpfs mode, source the in-RAM secrets file so values reach the command env without docker-inspect exposure. */
  private wrap(command: string): string {
    if (this.secretsMode !== 'tmpfs' || !this.hasSecrets) return command;
    return `set -a; [ -f ${SECRETS_FILE} ] && . ${SECRETS_FILE}; set +a; ${command}`;
  }

  /** Pure `docker run` argv assembly (no docker invocation), so hardening flags are unit-testable
   * without Docker installed. */
  buildRunArgs(): string[] {
    const args = ['run', '-d', '--name', this.name, '-w', this.workdir, '--label', `vanguard.runId=${this.id}`, ...ownerLabelArgs()];
    // Map host.docker.internal to the host only for a sandbox that is pointed there (see
    // `hostGateway`): a host egress proxy (`startEgressProxy`), or a provider endpoint on the docker
    // host. Required on Linux (Docker Desktop resolves the name itself); host-gateway needs Docker
    // >= 20.10. The egress enclave and the llm-proxy sidecar are reached by container name instead.
    if (this.needsHostGateway()) args.push('--add-host', `${HOST_GATEWAY_NAME}:host-gateway`);
    if (this.config.network !== undefined) args.push('--network', this.config.network);
    if (this.config.memoryMb !== undefined) args.push('--memory', `${this.config.memoryMb}m`);
    if (this.config.cpus !== undefined) args.push('--cpus', String(this.config.cpus));
    if (this.config.pidsLimit !== undefined) args.push('--pids-limit', String(this.config.pidsLimit));

    const security = { ...sandboxSecurityOpts(), ...this.config.security };
    for (const cap of security.capDrop) args.push('--cap-drop', cap);
    // Added back on top of capDrop ALL: copyIn's `docker exec -u 0 chown -R` needs CAP_CHOWN (and,
    // to retarget files the exec'd root doesn't own, CAP_FOWNER/CAP_DAC_OVERRIDE) — cap-drop fixes
    // the exec bounding set too, so `-u 0` alone does not restore it.
    for (const cap of security.capAdd) args.push('--cap-add', cap);
    if (security.noNewPrivileges) args.push('--security-opt', 'no-new-privileges');
    if (security.readOnlyRootfs) {
      args.push('--read-only');
      // Paths a real run writes: /workspace (copyIn + pnpm install + git), $HOME (skills, tool
      // caches), /tmp (build scratch). exec is required (tool shims, build scripts) unlike the
      // deliberately noexec secrets tmpfs above.
      args.push('--tmpfs', `${this.workdir}:rw,exec,nosuid,size=4g`);
      args.push('--tmpfs', `${DEFAULT_HOME}:rw,exec,nosuid,size=2g`);
      args.push('--tmpfs', '/tmp:rw,exec,nosuid,size=1g');
    }

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // In-RAM tmpfs: secrets never land in the image, on disk, or in docker inspect Config.Env.
      args.push('--tmpfs', `${SECRETS_DIR}:rw,noexec,nosuid,mode=1777,size=1m`);
    }
    if (this.envDir !== undefined) args.push('--env-file', join(this.envDir, 'env'));
    for (const [k, v] of Object.entries(this.config.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(this.image, 'sleep', 'infinity');
    return args;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.hasSecrets && this.secretsMode === 'env-file') {
      this.envDir = await mkdtemp(join(tmpdir(), 'vg-env-'));
      await writeFile(join(this.envDir, 'env'), this.secretsBody(), { mode: 0o600 });
    }
    const args = this.buildRunArgs();

    try {
      await execa('docker', args);
      this.started = true;
    } catch (cause) {
      throw new SandboxError(`Failed to start container ${this.name}`, { cause });
    }

    await this.assertClaudeCliCurrent();

    if (this.hasSecrets && this.secretsMode === 'tmpfs') {
      // Write the secrets file via stdin (umask 077) so the value never appears in argv.
      const write = await execa('docker', ['exec', '-i', this.name, 'sh', '-c', `umask 077; cat > ${SECRETS_FILE}`], {
        reject: false,
        input: this.secretsShellBody(),
      });
      if (write.exitCode !== 0) {
        await this.destroy();
        throw new SandboxError(`Failed to write secrets to tmpfs: ${write.stderr}`);
      }
    }
  }

  private async assertClaudeCliCurrent(): Promise<void> {
    if (claudeVersionChecked || process.env['VANGUARD_SKIP_IMAGE_CHECK'] === '1') return;
    claudeVersionChecked = true;
    const probe = await execa('docker', ['exec', this.name, 'claude', '--version'], { reject: false });
    const found = probe.exitCode === 0 ? /(\d+\.\d+\.\d+)/.exec(probe.stdout)?.[1] : undefined;
    if (found === undefined) return; // custom image without the claude CLI — not our business
    if (!isOlderVersion(found, SANDBOX_CLAUDE_VERSION)) return;
    await this.destroy();
    throw new SandboxError(
      `Sandbox image ${this.image} has claude ${found}, but this repo pins ${SANDBOX_CLAUDE_VERSION}. ` +
        `A stale CLI fails mid-run against a gateway. Fix it with:\n` +
        `  vanguard doctor --fix\n` +
        `or rebuild: CLAUDE_CLI_VERSION=${SANDBOX_CLAUDE_VERSION} ./docker/build.sh. ` +
        `Set VANGUARD_SKIP_IMAGE_CHECK=1 to bypass.`,
    );
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    if (options.input !== undefined) args.push('-i');
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const result = await execa('docker', args, {
      reject: false,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    return toExecResult(result);
  }

  execStream(command: string, options: ExecOptions = {}): ExecStream {
    const args = ['exec'];
    if (options.cwd !== undefined) args.push('-w', options.cwd);
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(this.name, 'sh', '-lc', this.wrap(command));
    const child = execa('docker', args, {
      reject: false,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { cancelSignal: options.signal } : {}),
    });
    const stdout = (async function* (): AsyncIterable<string> {
      if (child.stdout === undefined || child.stdout === null) return;
      for await (const line of createInterface({ input: child.stdout })) yield line;
    })();
    const result: Promise<ExecResult> = child.then((r) => toExecResult(r));
    return { stdout, result };
  }

  /** uid:gid of the container's run user, so copied files can be chowned to it (memoised). */
  private async containerOwner(): Promise<string> {
    if (this.owner === undefined) {
      const res = await execa('docker', ['exec', this.name, 'sh', '-c', 'printf "%s:%s" "$(id -u)" "$(id -g)"']);
      this.owner = res.stdout.trim();
    }
    return this.owner;
  }

  async copyIn(hostPath: string, sandboxPath: string): Promise<void> {
    try {
      const isDir = (await stat(hostPath)).isDirectory();
      await execa('docker', ['exec', this.name, 'mkdir', '-p', isDir ? sandboxPath : dirname(sandboxPath)]);
      const src = isDir ? `${hostPath}/.` : hostPath;
      await execa('docker', ['cp', src, `${this.name}:${sandboxPath}`]);
      // docker cp preserves host uid/gid, so chown to the container user; otherwise the non-root
      // agent cannot edit copied files (only create new ones).
      await execa('docker', ['exec', '-u', '0', this.name, 'chown', '-R', await this.containerOwner(), sandboxPath]);
    } catch (cause) {
      throw new SandboxError(`copyIn failed: ${hostPath} -> ${sandboxPath}`, { cause });
    }
  }

  async copyFileOut(sandboxPath: string, hostPath: string): Promise<void> {
    try {
      const isDir = (await execa('docker', ['exec', this.name, 'test', '-d', sandboxPath], { reject: false })).exitCode === 0;
      if (isDir) await mkdir(hostPath, { recursive: true });
      else await mkdir(dirname(hostPath), { recursive: true });
      const src = isDir ? `${this.name}:${sandboxPath}/.` : `${this.name}:${sandboxPath}`;
      await execa('docker', ['cp', src, hostPath]);
    } catch (cause) {
      throw new SandboxError(`copyFileOut failed: ${sandboxPath} -> ${hostPath}`, { cause });
    }
  }

  async exists(sandboxPath: string): Promise<boolean> {
    const result = await execa('docker', ['exec', this.name, 'test', '-e', sandboxPath], { reject: false });
    return result.exitCode === 0;
  }

  shellCommand(): string {
    return `docker exec -it ${this.name} bash`;
  }

  async destroy(): Promise<void> {
    await execa('docker', ['rm', '-f', this.name], { reject: false });
    this.started = false;
    if (this.envDir !== undefined) {
      await rm(this.envDir, { recursive: true, force: true });
      this.envDir = undefined;
    }
  }
}
