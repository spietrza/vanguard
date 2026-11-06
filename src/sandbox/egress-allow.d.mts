// Type declarations for the plain-ESM `egress-allow.mjs` so the strict-TS app keeps types.

/** Domains the sandbox legitimately needs: the agent, task sources, and package registries. */
export declare const DEFAULT_EGRESS_ALLOWLIST: readonly string[];

/** True if host equals an allowlist entry or is a subdomain of one (so `github.com.evil.com` is denied). */
export declare function isAllowed(host: string, allowlist: readonly string[]): boolean;

/** The only CONNECT port tunnelled for ordinary (non-trusted) allowlist entries. */
export declare const EGRESS_PORTS: readonly number[];

/** True for a loopback/private/link-local/reserved IP literal (IPv4-mapped IPv6 checked as IPv4). */
export declare function isPrivateAddress(ip: string): boolean;

/** Split a CONNECT target (`host:port`, `[v6]:port`) into a bracket-free host and a port (default 443). */
export declare function parseConnectTarget(target: string): { host: string; port: number };

/** DNS resolver seam (defaults to `dns.promises.lookup`). */
export type EgressResolver = (host: string, opts: { all: true }) => Promise<ReadonlyArray<{ address: string }>>;

/**
 * Where to open a CONNECT tunnel, or undefined to refuse: allowlisted host; trusted hosts (exact) by
 * name on any port; the rest port 443 only, resolved and refused on any private/loopback address.
 */
export declare function resolveConnectTarget(
  target: string,
  allowlist: readonly string[],
  trusted?: readonly string[],
  resolve?: EgressResolver,
): Promise<{ host: string; port: number } | undefined>;
