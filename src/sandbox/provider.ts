export interface SandboxSecurityOpts {
  capDrop: string[];
  capAdd: string[];
  noNewPrivileges: boolean;
  readOnlyRootfs: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecStream {
  stdout: AsyncIterable<string>;
  result: Promise<ExecResult>;
}

/**
 * A fully isolated execution environment (Docker container or Firecracker microVM).
 * The host owns explicit file sync: nothing crosses the boundary except via copyIn/copyFileOut.
 */
export interface IsolatedSandboxProvider {
  readonly id: string;
  /** Provision the sandbox (pull image / boot VM, start it). */
  start: () => Promise<void>;
  /** Run a command INSIDE the sandbox and capture output (never throws on non-zero exit). */
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
  /** Stream a long-running command's stdout while it runs (for live logging / abort). */
  execStream: (command: string, options?: ExecOptions) => ExecStream;
  /**
   * Copy a host file/dir INTO the sandbox. Symlinks inside a copied dir must arrive as links, never
   * dereferenced (docker cp does this): repo skills are copied in from the host, and a link must not
   * pull host files into the sandbox.
   */
  copyIn: (hostPath: string, sandboxPath: string) => Promise<void>;
  /** Copy a sandbox file/dir OUT to the host. */
  copyFileOut: (sandboxPath: string, hostPath: string) => Promise<void>;
  /** True if a path exists inside the sandbox. */
  exists: (sandboxPath: string) => Promise<boolean>;
  /** Tear down (rm container / kill VM). Safe to call multiple times. */
  destroy: () => Promise<void>;
  /** Host command that opens an interactive shell into the live sandbox (for HITL). */
  shellCommand: () => string;
}

export interface SandboxConfig {
  image?: string;
  workdir?: string;
  env?: Record<string, string>;
  forwardEnv?: string[];
  /** Secrets injected off the command line (tmpfs / env-file), never via -e KEY=VAL. */
  secrets?: Record<string, string>;
  /**
   * How secrets reach the sandbox. 'tmpfs' (default) writes them to an in-RAM file the
   * commands source at runtime, so they never appear in `docker inspect` Config.Env or on
   * disk. 'env-file' loads them into the container env (visible to docker inspect).
   */
  secretsMode?: 'tmpfs' | 'env-file';
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  /** Join this docker network instead of the default bridge (e.g. an internal egress enclave). */
  network?: string;
  /**
   * Map `host.docker.internal` to the docker host (`--add-host …:host-gateway`). Unset: added only
   * when an `env`/`secrets`/`forwardEnv` value names host.docker.internal (a host egress proxy from
   * `startEgressProxy`, a provider endpoint on the docker host). Set it to force either way, e.g.
   * for repo tooling that reaches host services by that name on Linux.
   */
  hostGateway?: boolean;
  /** Overrides sandboxSecurityOpts()'s env-derived defaults (cap-drop/add, no-new-privileges, readonly). */
  security?: Partial<SandboxSecurityOpts>;
}
