import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SandboxError } from '../core/errors.js';
import { startSidecar } from './sidecar.js';
import type { DockerRunner } from './sidecar.js';
import type { ProviderProxySecrets } from '../agents/registry.js';
import type { Upstream } from './llm-proxy-rewrite.mjs';

export type { DockerRunner } from './sidecar.js';

const PROXY_PORT = 8088;
// Its own directory: startSidecar mounts the secret's directory as a dedicated in-RAM tmpfs.
const SECRET_FILE = '/run/vanguard-llm/secret';
// Resolves to dist/sandbox/llm-proxy-server.mjs (built) or src/... (tsx) — next to this module.
const PROXY_SCRIPT = fileURLToPath(new URL('./llm-proxy-server.mjs', import.meta.url));
// Shared pure logic the server imports via a relative `./llm-proxy-rewrite.mjs`; cp'd into the SAME
// /tmp dir so that relative import resolves inside the container.
const PROXY_LOGIC = fileURLToPath(new URL('./llm-proxy-rewrite.mjs', import.meta.url));

export interface LlmProxy {
  /** Proxy URL reachable from inside the internal network (by container name). */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN; the proxy validates it. */
  nonce: string;
  /** Sidecar container name (the `vg-llm-<id>` host inside the url) — also the NO_PROXY entry. */
  host: string;
  destroy: () => Promise<void>;
}

/** The per-source LLM-proxy wiring threaded into a runner when `--llm-proxy` is active. */
export interface LlmProxyDep {
  /** Proxy URL the sandbox uses as ANTHROPIC_BASE_URL. */
  url: string;
  /** Per-run nonce the sandbox presents as ANTHROPIC_AUTH_TOKEN. */
  nonce: string;
  /** Sidecar container name (added to NO_PROXY so the sandbox reaches it directly). */
  host: string;
}

/**
 * Starts the trusted LLM reverse-proxy sidecar holding the real provider credential. Serves either
 * the Anthropic or OpenAI upstream depending on `opts.upstream` (default `'anthropic'`); for OpenAI
 * the real OpenAI key is the `auth.secret`. The sidecar runs on the default bridge (has internet) and
 * is also joined to the given internal enclave network so the sandbox can reach it by name. The real
 * secret reaches the sidecar ONLY via stdin into an in-RAM tmpfs file (umask 077) — never via `-e` or
 * argv, so `docker inspect` cannot reveal it. The sandbox authenticates with the returned per-run
 * nonce; the proxy swaps in the real auth upstream.
 */
export async function startLlmProxy(opts: {
  network: string;
  auth: { mode: 'subscription' | 'api'; secret: string };
  upstream?: Upstream;
  image?: string;
  docker?: DockerRunner;
}): Promise<LlmProxy> {
  const upstream: Upstream = opts.upstream ?? 'anthropic';
  const id = randomUUID().slice(0, 8);
  const name = `vg-llm-${id}`;
  const nonce = randomUUID().replace(/-/g, '');
  try {
    // The existing reapContainers (label vanguard.runId) already reaps this sidecar on gc — no gc change.
    const sidecar = await startSidecar({
      name,
      runId: id,
      ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      // Sidecar on the default bridge (has internet), then also joined to the internal enclave network.
      network: opts.network,
      files: [
        { src: PROXY_SCRIPT, dest: '/tmp/llm-proxy.mjs' },
        // The shared logic must sit next to the server so its relative import resolves.
        { src: PROXY_LOGIC, dest: '/tmp/llm-proxy-rewrite.mjs' },
      ],
      // The real secret reaches the sidecar ONLY via stdin into an in-RAM file (umask 077).
      secret: { path: SECRET_FILE, body: `MODE=${opts.auth.mode}\nSECRET=${opts.auth.secret}\nNONCE=${nonce}\nUPSTREAM=${upstream}\n` },
      env: { LLM_PROXY_SECRET_FILE: SECRET_FILE, PORT: String(PROXY_PORT) },
      cmd: ['node', '/tmp/llm-proxy.mjs'],
    });
    return { url: `http://${name}:${PROXY_PORT}`, nonce, host: name, destroy: sidecar.destroy };
  } catch (cause) {
    // The sidecar runs the sandbox image (startSidecar's default), so a missing/stale build is the
    // common cause — name it instead of leaving a bare container id for the user to puzzle over.
    throw new SandboxError(
      `Failed to start llm proxy ${id}: rebuild the sandbox image (docker/build.sh builds vanguard-sandbox:latest), or check VANGUARD_SANDBOX_IMAGE if set.`,
      { cause },
    );
  }
}

/** The per-run provider-sidecar handles plus a single teardown for whatever was started. */
export interface ProviderProxies {
  /** OpenAI/Codex sidecar dep, present only when a Codex key was proxied. */
  openai?: LlmProxyDep;
  /** Tear down every sidecar started here. Safe to call when none were started. */
  destroy: () => Promise<void>;
}

/**
 * Start the per-run provider proxy sidecars implied by `proxySecrets` (from SelectedAgents). Currently:
 * an OpenAI upstream sidecar when a Codex key was proxied (Codex in --llm-proxy mode). This is the one
 * place that maps a proxied provider key to its sidecar, so adding a future proxyable provider is local
 * to here. The real key reaches the sidecar only via startLlmProxy's stdin tmpfs delivery — never the
 * sandbox. Requires the enclave `network`; throws a clear SandboxError if a key is given without one.
 */
export async function startProviderProxies(opts: {
  /** Proxied provider keys held by sidecars (from SelectedAgents.proxySecrets). */
  proxySecrets: ProviderProxySecrets;
  network?: string;
  image?: string;
  docker?: DockerRunner;
}): Promise<ProviderProxies> {
  const openaiKey = opts.proxySecrets.codex;
  if (openaiKey === undefined) {
    return { destroy: async (): Promise<void> => {} };
  }
  if (opts.network === undefined) {
    throw new SandboxError('OpenAI provider proxy needs the egress enclave network');
  }
  const proxy = await startLlmProxy({
    network: opts.network,
    auth: { mode: 'api', secret: openaiKey },
    upstream: 'openai',
    ...(opts.image !== undefined ? { image: opts.image } : {}),
    ...(opts.docker !== undefined ? { docker: opts.docker } : {}),
  });
  return {
    openai: { url: proxy.url, nonce: proxy.nonce, host: proxy.host },
    destroy: (): Promise<void> => proxy.destroy(),
  };
}
