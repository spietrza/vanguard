// Pure allow-check semantics for the egress CONNECT proxy.
// Authored as plain ESM `.mjs` so BOTH the strict-TS host (`egress-proxy.ts`) and the zero-dep
// sidecar (`egress-proxy-server.mjs`) import the SAME file — no copy-paste, no drift. Types for the
// TS side live in the sibling `egress-allow.d.mts`. The sidecar gets this file `docker cp`'d next to
// it so the relative `import './egress-allow.mjs'` resolves.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
  // Codex/OpenAI direct mode (--egress without --llm-proxy): the sandbox reaches OpenAI directly via
  // this entry. Under --llm-proxy this host is dropped from the sandbox allowlist (see llmProxyEgressAllowlist).
  'api.openai.com',
  // z.ai (GLM Coding Plan, --provider zai) direct mode: the Claude Code CLI talks to z.ai's
  // Anthropic-compatible coding endpoint. Dropped under --llm-proxy (the sidecar owns it).
  'api.z.ai',
  // OpenRouter direct mode (--provider openrouter --egress). Dropped under --llm-proxy.
  'openrouter.ai',
  // Cursor CLI (--provider cursor): api2.cursor.sh plus the api5 agent subdomains. Cursor is never
  // proxied (the key rides into the sandbox), so this stays under --llm-proxy too.
  'cursor.sh',
  'api.linear.app',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
];

/** True if host equals an allowlist entry or is a subdomain of one (so `github.com.evil.com` is denied). */
export function isAllowed(host, allowlist) {
  const h = host.toLowerCase();
  return allowlist.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

/** The only CONNECT port tunnelled for ordinary allowlist entries: everything the sandbox needs is HTTPS. */
export const EGRESS_PORTS = [443];

// Loopback, private, CGNAT, link-local (incl. cloud metadata), unspecified, benchmark, multicast and
// reserved ranges. An allowlisted name resolving here is DNS pointing into the host/LAN, not the service.
const PRIVATE_RANGES = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE_RANGES.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE_RANGES.addSubnet(net, prefix, 'ipv6');
}

/** True for a loopback/private/link-local/reserved IP literal (IPv4-mapped IPv6 checked as IPv4). */
export function isPrivateAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE_RANGES.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Split a CONNECT target (`host:port`, `[v6]:port`) into a bracket-free host and a port (default 443). */
export function parseConnectTarget(target) {
  const sep = target.lastIndexOf(':');
  const rawHost = sep > 0 ? target.slice(0, sep) : target;
  const port = sep > 0 ? Number(target.slice(sep + 1)) : 443;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  return { host, port };
}

/**
 * Where to open a CONNECT tunnel, or undefined to refuse. A host must be on `allowlist`. A host on
 * `trusted` (exact match: a configured custom endpoint, which may sit on the LAN or a non-443 port)
 * is tunnelled by name on any port. Every other host gets port 443 only, is resolved here and refused
 * when any address is private/loopback/link-local, and the tunnel dials the checked address, so a
 * second lookup cannot swap in a different one.
 */
export async function resolveConnectTarget(target, allowlist, trusted = [], resolve = lookup) {
  const { host, port } = parseConnectTarget(target);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535 || !isAllowed(host, allowlist)) return undefined;
  if (trusted.includes(host.toLowerCase())) return { host, port };
  if (!EGRESS_PORTS.includes(port)) return undefined;
  let addresses;
  try {
    addresses = isIP(host) !== 0 ? [{ address: host }] : await resolve(host, { all: true });
  } catch {
    return undefined;
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) return undefined;
  return { host: addresses[0].address, port };
}
