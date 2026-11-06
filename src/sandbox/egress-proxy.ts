import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { LlmProxyDep } from './llm-proxy.js';
// Single source of the allow semantics + default allowlist: the same plain-ESM `.mjs` the sidecar
// imports (see egress-allow.mjs). Re-exported below so existing import sites keep working.
import { isAllowed, DEFAULT_EGRESS_ALLOWLIST, resolveConnectTarget } from './egress-allow.mjs';
import { UPSTREAMS } from './llm-proxy-rewrite.mjs';

export { isAllowed, DEFAULT_EGRESS_ALLOWLIST };

export interface EgressProxy {
  port: number;
  /** Proxy URL as seen from inside the sandbox (the host is reachable as host.docker.internal). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Sandbox env that routes HTTP(S) through the egress proxy (localhost stays direct). NODE_USE_ENV_PROXY
 * makes Node 24's fetch/undici honor the proxy too, so the agent's own API traffic is covered in the
 * hard (internal-network) enclave, not just shell tools.
 */
export function egressEnv(proxyUrl: string, opts: { noProxy?: readonly string[] } = {}): Record<string, string> {
  const noProxy = ['localhost', '127.0.0.1', ...(opts.noProxy ?? [])].join(',');
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    // Lowercase variants: some CLIs (curl, git) only read these.
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
    // npm/pnpm route through their own config, not the HTTPS_PROXY env, so set it explicitly. Without
    // this, `pnpm install` (e.g. the Proof of Work verify command) cannot reach the registry under the
    // hard egress enclave even though registry.npmjs.org is allowlisted.
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
  };
}

/**
 * Build the sandbox env for a runner: undefined when there's no egress proxy (direct mode); otherwise
 * the egress proxy vars, plus — when an LLM-proxy sidecar owns Claude — its host in NO_PROXY and the
 * ANTHROPIC_BASE_URL/AUTH_TOKEN that point Claude at the sidecar with the per-run nonce (never the real
 * secret). When an OpenAI provider sidecar is present (Codex in --llm-proxy mode), its host is also
 * added to NO_PROXY and the sandbox gets OPENAI_API_KEY (the per-run nonce, not the real key) plus
 * VANGUARD_OPENAI_BASE_URL pointing CodexProvider at the sidecar. Both sidecars are independent; either,
 * both, or neither may be present alongside the egress proxy. Single source for the nested ternary the
 * runners used to duplicate.
 */
export function llmProxySandboxEnv(
  proxyUrl: string | undefined,
  llmProxy: LlmProxyDep | undefined,
  openaiProxy?: LlmProxyDep,
): Record<string, string> | undefined {
  if (proxyUrl === undefined) return undefined;
  const noProxy = [llmProxy?.host, openaiProxy?.host].filter((h): h is string => h !== undefined);
  const base = egressEnv(proxyUrl, noProxy.length > 0 ? { noProxy } : {});
  const withAnthropic =
    llmProxy !== undefined
      ? { ...base, ANTHROPIC_BASE_URL: llmProxy.url, ANTHROPIC_AUTH_TOKEN: llmProxy.nonce }
      : base;
  if (openaiProxy === undefined) return withAnthropic;
  // The OpenAI nonce is not secret — it only authenticates against the per-run sidecar, never upstream.
  return { ...withAnthropic, OPENAI_API_KEY: openaiProxy.nonce, VANGUARD_OPENAI_BASE_URL: `${openaiProxy.url}/v1` };
}

/** Returns the allowlist minus exact matches of `host` (e.g. drop api.anthropic.com when a trusted sidecar owns it). */
export function allowlistWithout(list: readonly string[], host: string): string[] {
  return list.filter((entry) => entry !== host);
}

/** Upstream API hosts owned by trusted sidecars in --llm-proxy mode — removed from the sandbox allowlist
 *  (the sidecars reach these directly; the sandbox reaches the sidecars by name via NO_PROXY). Derived
 *  from the single UPSTREAMS source so adding an upstream there drops its host from the allowlist too. */
export const LLM_PROXY_UPSTREAM_HOSTS = Object.values(UPSTREAMS).map((u) => u.host);

/** The sandbox egress allowlist under --llm-proxy: the base allowlist minus every sidecar-owned upstream host. */
export function llmProxyEgressAllowlist(base: readonly string[] = DEFAULT_EGRESS_ALLOWLIST): string[] {
  return LLM_PROXY_UPSTREAM_HOSTS.reduce<string[]>((list, host) => allowlistWithout(list, host), [...base]);
}

/**
 * A forward proxy that only tunnels HTTPS CONNECT to allowlisted domains (others get 403). Phase 1
 * (soft) egress control: point the sandbox's HTTPS_PROXY at this. It does not block a sandbox that
 * bypasses the proxy — kernel-level enforcement is phase 2.
 */
export async function startEgressProxy(
  opts: { allowlist?: readonly string[]; trusted?: readonly string[]; port?: number } = {},
): Promise<EgressProxy> {
  const allowlist = opts.allowlist ?? DEFAULT_EGRESS_ALLOWLIST;
  const trusted = (opts.trusted ?? []).map((h) => h.toLowerCase());
  const server = createServer((_req, res) => {
    res.writeHead(405).end('This proxy only supports HTTPS CONNECT.');
  });

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    // Same rule as the enclave sidecar: port 443, public addresses, unless the host is trusted.
    resolveConnectTarget(req.url ?? '', allowlist, trusted).then((dest) => {
      if (dest === undefined) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (clientSocket.destroyed) return;
      const upstream = connect(dest.port, dest.host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    }, () => clientSocket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://host.docker.internal:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
