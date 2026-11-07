import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-proxy.js';
import { ownerLabelArgs } from './limits.js';
import { startSidecar, defaultDocker } from './sidecar.js';
import type { DockerRunner } from './sidecar.js';

const PROXY_PORT = 8080;
// Resolves to dist/sandbox/egress-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./egress-proxy-server.mjs', import.meta.url));
// Shared allow logic the server imports via a relative `./egress-allow.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./egress-allow.mjs', import.meta.url));

export interface EgressEnclave {
  /** Internal docker network the sandbox must join (no route to the internet, only to the proxy). */
  network: string;
  /** Proxy URL reachable from inside the internal network (by container name). */
  proxyUrl: string;
  destroy: () => Promise<void>;
}

/**
 * Hard egress enforcement: an `--internal` docker network (no internet) plus a proxy sidecar attached
 * to both that network and the default bridge. The sandbox joins only the internal network, so its
 * sole route out is the proxy — even a process that ignores HTTPS_PROXY has nowhere else to go. The
 * proxy only tunnels CONNECT to the allowlist. Caller joins the sandbox to `network` and points its
 * HTTPS_PROXY at `proxyUrl`, then calls destroy().
 *
 * The proxy node process is PID 1 with `--restart on-failure` — NOT a `sleep infinity` container
 * with an `exec -d`'d node (dogfood #352): there, a mid-run death of the exec'd process (OOM kill in
 * the 256 MB cgroup, a crash) left the container "Up" with the port closed, every later stage burned
 * minutes retrying into ConnectionRefused, and `docker logs` had nothing — exec'd stdout goes
 * nowhere. PID-1 + restart means docker both records the output and revives the proxy.
 */
export async function startEgressEnclave(
  /** `trusted`: exact allowlisted hosts (configured custom endpoints) exempt from the 443-only and
   *  no-private-address rules, so a LAN or non-443 https endpoint keeps working. */
  opts: { allowlist?: readonly string[]; trusted?: readonly string[]; image?: string; docker?: DockerRunner } = {},
): Promise<EgressEnclave> {
  const docker = opts.docker ?? defaultDocker;
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const id = randomUUID().slice(0, 8);
  const network = `vg-egr-${id}`;
  const proxy = `vg-proxy-${id}`;
  const networkCreate = await docker(['network', 'create', '--internal', ...ownerLabelArgs(), network]);
  if (networkCreate.exitCode !== 0) throw new SandboxError(`Failed to start egress enclave ${id}`, { cause: new Error(`docker network create failed: ${networkCreate.stderr}`) });
  try {
    const sidecar = await startSidecar({
      name: proxy,
      runId: id,
      docker,
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      network,
      files: [
        { src: PROXY_SCRIPT, dest: '/tmp/egress-proxy.mjs' },
        // The shared logic must sit next to the server so its relative import resolves.
        { src: PROXY_LOGIC, dest: '/tmp/egress-allow.mjs' },
      ],
      env: {
        ALLOW: allowlist.join(','),
        ...(opts.trusted !== undefined && opts.trusted.length > 0 ? { TRUSTED: opts.trusted.join(',') } : {}),
        PORT: String(PROXY_PORT),
      },
      createArgs: ['--restart', 'on-failure:10'],
      cmd: ['node', '/tmp/egress-proxy.mjs'],
      alsoDestroy: async () => { await docker(['network', 'rm', network]); },
    });
    return { network, proxyUrl: `http://${proxy}:${PROXY_PORT}`, destroy: sidecar.destroy };
  } catch (cause) {
    // startSidecar's teardown already removed the proxy container and (via alsoDestroy) the network.
    throw new SandboxError(`Failed to start egress enclave ${id}`, { cause });
  }
}
