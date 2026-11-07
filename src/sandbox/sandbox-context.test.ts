import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EGRESS_ALLOWLIST } from './egress-allow.mjs';
import { llmProxyEgressAllowlist } from './egress-proxy.js';

const enclaveDestroy = vi.fn(async (): Promise<void> => {});
const startEgressEnclave = vi.fn(async (_opts?: { allowlist?: readonly string[] }) => ({
  proxyUrl: 'http://vg-proxy:3128',
  network: 'vg-egr-test',
  destroy: enclaveDestroy,
}));
vi.mock('./egress-network.js', () => ({
  startEgressEnclave: (opts?: { allowlist?: readonly string[] }): Promise<unknown> => startEgressEnclave(opts),
}));
const startLlmProxy = vi.fn(async (_opts?: { upstream?: string }) => ({ url: 'http://vg-llm:8088', nonce: 'n', host: 'vg-llm', destroy: async (): Promise<void> => {} }));
vi.mock('./llm-proxy.js', () => ({
  startLlmProxy: (opts?: { upstream?: string }): Promise<unknown> => startLlmProxy(opts),
}));

const { startSandboxContext } = await import('./sandbox-context.js');

describe('startSandboxContext extraEgressHosts (S6)', () => {
  beforeEach(() => startEgressEnclave.mockClear());

  it('plain --egress with no extras keeps the default allowlist (no opts — enclave defaults apply)', async () => {
    await startSandboxContext({ egress: true, llmProxy: false });
    expect(startEgressEnclave).toHaveBeenCalledWith({});
  });

  it('plain --egress + extras materializes DEFAULT_EGRESS_ALLOWLIST + the custom hosts, trusted for LAN/non-443', async () => {
    await startSandboxContext({ egress: true, llmProxy: false, extraEgressHosts: ['llm.example.com'] });
    expect(startEgressEnclave).toHaveBeenCalledWith({
      allowlist: [...DEFAULT_EGRESS_ALLOWLIST, 'llm.example.com'],
      trusted: ['llm.example.com'],
    });
  });

  it('llm-proxy mode appends extras to the sidecar-stripped allowlist', async () => {
    await startSandboxContext({
      egress: true,
      llmProxy: true,
      auth: { mode: 'subscription', token: 't' },
      extraEgressHosts: ['llm.example.com'],
    });
    expect(startEgressEnclave).toHaveBeenCalledWith({
      allowlist: [...llmProxyEgressAllowlist(), 'llm.example.com'],
      trusted: ['llm.example.com'],
    });
  });

  it('neither flag: no enclave at all', async () => {
    await startSandboxContext({ egress: false, llmProxy: false, extraEgressHosts: ['llm.example.com'] });
    expect(startEgressEnclave).not.toHaveBeenCalled();
  });
});

describe('startSandboxContext tears the enclave down when the LLM proxy fails to start', () => {
  it('destroys the enclave (network + egress proxy) and rethrows', async () => {
    enclaveDestroy.mockClear();
    startLlmProxy.mockRejectedValueOnce(new Error('docker cp failed'));
    await expect(startSandboxContext({ egress: true, llmProxy: true, auth: { mode: 'subscription', token: 't' } })).rejects.toThrow(/docker cp failed/);
    expect(enclaveDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('startSandboxContext llm-proxy upstream follows the provider table', () => {
  beforeEach(() => startLlmProxy.mockClear());
  const auth = { mode: 'subscription' as const, token: 't' };

  it('zai and openrouter hand the sidecar their own upstream', async () => {
    for (const provider of ['zai', 'openrouter']) {
      await startSandboxContext({ egress: true, llmProxy: true, auth, provider });
      expect(startLlmProxy).toHaveBeenLastCalledWith(expect.objectContaining({ upstream: provider }));
    }
  });

  it('claude, meridian and an unknown custom name leave the sidecar on api.anthropic.com', async () => {
    for (const provider of ['claude', 'meridian', 'custom:acme-gateway', undefined]) {
      await startSandboxContext({ egress: true, llmProxy: true, auth, ...(provider !== undefined ? { provider } : {}) });
      expect(startLlmProxy).toHaveBeenLastCalledWith(expect.not.objectContaining({ upstream: expect.anything() }));
    }
  });
});
