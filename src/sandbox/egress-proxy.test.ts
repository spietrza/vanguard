import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  isAllowed,
  startEgressProxy,
  egressEnv,
  llmProxySandboxEnv,
  allowlistWithout,
  llmProxyEgressAllowlist,
  DEFAULT_EGRESS_ALLOWLIST,
} from './egress-proxy.js';
import { resolveConnectTarget, isPrivateAddress, connectOptions } from './egress-allow.mjs';
import type { LlmProxyDep } from './llm-proxy.js';

describe('isAllowed', () => {
  it('allows exact domains and subdomains, denies look-alikes', () => {
    expect(isAllowed('api.anthropic.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    // Direct Codex mode (--egress without --llm-proxy) reaches OpenAI through the proxy.
    expect(isAllowed('api.openai.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    expect(isAllowed('codeload.github.com', DEFAULT_EGRESS_ALLOWLIST)).toBe(true);
    expect(isAllowed('sub.github.com', ['github.com'])).toBe(true);
    expect(isAllowed('github.com.evil.com', ['github.com'])).toBe(false);
    expect(isAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(isAllowed('exfiltrate.me', DEFAULT_EGRESS_ALLOWLIST)).toBe(false);
  });
});

describe('resolveConnectTarget', () => {
  const dns = (...addresses: string[]) => async (): Promise<Array<{ address: string }>> => addresses.map((address) => ({ address }));
  const allow = ['api.example.com', 'lan.example.com'];

  it('tunnels an allowlisted public host on 443, dialling only every checked address', async () => {
    const dest = await resolveConnectTarget('api.example.com:443', allow, [], dns('203.0.113.7', '2606:4700::1111'));
    expect(dest).toEqual({
      host: 'api.example.com',
      port: 443,
      addresses: [{ address: '203.0.113.7', family: 4 }, { address: '2606:4700::1111', family: 6 }],
    });
    const opts = connectOptions(dest!) as { lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void };
    const all = await new Promise((r) => opts.lookup('ignored', { all: true }, (_e, a) => r(a)));
    expect(all).toEqual(dest!.addresses);
    const one = await new Promise((r) => opts.lookup('ignored', {}, (_e, a, f) => r([a, f])));
    expect(one).toEqual(['203.0.113.7', 4]);
  });

  it('matches bracketed IPv6 allowlist/trusted entries (URL hostname form) against CONNECT targets', async () => {
    expect(await resolveConnectTarget('[fd00::5]:8443', ['[fd00::5]'], ['[fd00::5]'], dns())).toEqual({ host: 'fd00::5', port: 8443 });
    expect(await resolveConnectTarget('fd00::5:8443', ['[fd00::5]'], ['[fd00::5]'], dns())).toEqual({ host: 'fd00::5', port: 8443 });
  });

  it('refuses any port but 443 for non-trusted hosts', async () => {
    for (const port of [22, 80, 8443, 6379]) {
      expect(await resolveConnectTarget(`api.example.com:${port}`, allow, [], dns('203.0.113.7'))).toBeUndefined();
    }
  });

  it('refuses allowlisted names that resolve to loopback, private, link-local or mapped addresses', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.214', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(await resolveConnectTarget('api.example.com:443', allow, [], dns('203.0.113.7', ip))).toBeUndefined();
    }
  });

  it('refuses non-allowlisted hosts, unresolvable names, and malformed ports', async () => {
    expect(await resolveConnectTarget('evil.example:443', allow, [], dns('203.0.113.7'))).toBeUndefined();
    expect(await resolveConnectTarget('api.example.com:443', allow, [], async () => { throw new Error('ENOTFOUND'); })).toBeUndefined();
    expect(await resolveConnectTarget('api.example.com:abc', allow, [], dns('203.0.113.7'))).toBeUndefined();
  });

  it('lets a trusted (configured custom) host use any port and a LAN address, by name', async () => {
    expect(await resolveConnectTarget('lan.example.com:3000', allow, ['lan.example.com'], dns('192.168.1.214'))).toEqual({ host: 'lan.example.com', port: 3000 });
    // Trust is exact: a subdomain of a trusted host is not trusted.
    expect(await resolveConnectTarget('x.lan.example.com:3000', ['lan.example.com'], ['lan.example.com'], dns('192.168.1.214'))).toBeUndefined();
  });

  it('classifies addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('127.0.0.53')).toBe(true);
    expect(isPrivateAddress('not-an-ip')).toBe(false);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
    for (const ip of ['::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', '::a00:1', '::']) expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe('egressEnv', () => {
  it('keeps NO_PROXY at localhost,127.0.0.1 and routes proxy vars (backward compatible)', () => {
    const url = 'http://host.docker.internal:1234';
    const env = egressEnv(url);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.HTTP_PROXY).toBe(url);
    expect(env.HTTPS_PROXY).toBe(url);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    // lowercase + npm/pnpm proxy so registry access works under the hard enclave
    expect(env.https_proxy).toBe(url);
    expect(env.npm_config_https_proxy).toBe(url);
    expect(env.npm_config_proxy).toBe(url);
  });

  it('appends extra noProxy hosts (both cases)', () => {
    const env = egressEnv('http://host.docker.internal:1234', { noProxy: ['vg-llm-abc'] });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,vg-llm-abc');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,vg-llm-abc');
  });
});

describe('llmProxySandboxEnv', () => {
  const proxyUrl = 'http://host.docker.internal:1234';
  const anthropic: LlmProxyDep = { url: 'http://vg-llm-ant:8088', nonce: 'ant-nonce', host: 'vg-llm-ant' };
  const openai: LlmProxyDep = { url: 'http://vg-llm-oai:8088', nonce: 'oai-nonce', host: 'vg-llm-oai' };

  it('returns undefined in direct mode (no egress proxy)', () => {
    expect(llmProxySandboxEnv(undefined, anthropic, openai)).toBeUndefined();
  });

  it('wires both sidecars: both hosts in NO_PROXY, Anthropic + OpenAI vars set', () => {
    const env = llmProxySandboxEnv(proxyUrl, anthropic, openai);
    expect(env).toBeDefined();
    expect(env?.NO_PROXY).toBe('localhost,127.0.0.1,vg-llm-ant,vg-llm-oai');
    expect(env?.ANTHROPIC_BASE_URL).toBe(anthropic.url);
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe(anthropic.nonce);
    expect(env?.OPENAI_API_KEY).toBe(openai.nonce);
    expect(env?.VANGUARD_OPENAI_BASE_URL).toBe(`${openai.url}/v1`);
  });

  it('wires the OpenAI sidecar alone: OpenAI vars + host in NO_PROXY, no Anthropic vars', () => {
    const env = llmProxySandboxEnv(proxyUrl, undefined, openai);
    expect(env?.NO_PROXY).toBe('localhost,127.0.0.1,vg-llm-oai');
    expect(env?.OPENAI_API_KEY).toBe(openai.nonce);
    expect(env?.VANGUARD_OPENAI_BASE_URL).toBe(`${openai.url}/v1`);
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('keeps the Anthropic-only behavior unchanged when no OpenAI sidecar is given', () => {
    const env = llmProxySandboxEnv(proxyUrl, anthropic);
    expect(env?.NO_PROXY).toBe('localhost,127.0.0.1,vg-llm-ant');
    expect(env?.ANTHROPIC_BASE_URL).toBe(anthropic.url);
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe(anthropic.nonce);
    expect(env?.OPENAI_API_KEY).toBeUndefined();
    expect(env?.VANGUARD_OPENAI_BASE_URL).toBeUndefined();
  });

  it('returns plain egress env when neither sidecar is given (existing behavior)', () => {
    const env = llmProxySandboxEnv(proxyUrl, undefined);
    expect(env?.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env?.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('DEFAULT_EGRESS_ALLOWLIST', () => {
  it('includes api.openai.com so direct Codex (--egress) can reach OpenAI', () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).toContain('api.openai.com');
  });

  it('includes api.z.ai so direct Zai (--provider zai --egress) can reach z.ai', () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).toContain('api.z.ai');
  });

  it('includes openrouter.ai so direct OpenRouter (--provider openrouter --egress) can reach OpenRouter', () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).toContain('openrouter.ai');
  });
});

describe('allowlistWithout', () => {
  it('drops exact host matches and keeps the other defaults', () => {
    const result = allowlistWithout(DEFAULT_EGRESS_ALLOWLIST, 'api.anthropic.com');
    expect(result).not.toContain('api.anthropic.com');
    expect(result).toContain('api.linear.app');
    expect(result).toContain('github.com');
    expect(result).toContain('registry.npmjs.org');
  });
});

describe('llmProxyEgressAllowlist', () => {
  it('excludes the sidecar-owned upstream hosts but keeps non-upstream hosts', () => {
    const result = llmProxyEgressAllowlist();
    expect(result).not.toContain('api.anthropic.com');
    expect(result).not.toContain('api.openai.com');
    expect(result).not.toContain('api.z.ai');
    expect(result).not.toContain('openrouter.ai');
    expect(result).toContain('github.com');
    expect(result).toContain('registry.npmjs.org');
    expect(result).toContain('api.linear.app');
  });

  it('denies the sidecar-owned upstreams via isAllowed but still allows the rest', () => {
    const result = llmProxyEgressAllowlist();
    // Regression: the existing Anthropic removal still holds.
    expect(isAllowed('api.anthropic.com', result)).toBe(false);
    expect(isAllowed('api.openai.com', result)).toBe(false);
    expect(isAllowed('api.z.ai', result)).toBe(false);
    expect(isAllowed('openrouter.ai', result)).toBe(false);
    expect(isAllowed('github.com', result)).toBe(true);
  });
});

describe('startEgressProxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  // Open a CONNECT tunnel through the proxy to a local upstream; resolve with the status code.
  function connectVia(proxyPort: number, target: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ port: proxyPort, method: 'CONNECT', path: target });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('tunnels CONNECT to an allowlisted host and 403s the rest', async () => {
    const upstream: Server = createServer((s) => s.end());
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = await startEgressProxy({ allowlist: ['127.0.0.1'], trusted: ['127.0.0.1'] });
    cleanups.push(proxy.close);

    expect(await connectVia(proxy.port, `127.0.0.1:${upstreamPort}`)).toBe(200);

    // Allowlisted but not trusted: a loopback address on a non-443 port is refused.
    const untrusted = await startEgressProxy({ allowlist: ['127.0.0.1'] });
    cleanups.push(untrusted.close);
    expect(await connectVia(untrusted.port, `127.0.0.1:${upstreamPort}`)).toBe(403);

    const denying = await startEgressProxy({ allowlist: ['example.com'] });
    cleanups.push(denying.close);
    expect(await connectVia(denying.port, `127.0.0.1:${upstreamPort}`)).toBe(403);
  });
});
