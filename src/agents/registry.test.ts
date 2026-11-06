import { describe, it, expect } from 'vitest';
import {
  isProviderName,
  llmProxySupported,
  makeProvider,
  providerSecrets,
  providerUpstream,
  selectAgents,
  subscriptionCredentialProvider,
  validateProviderChoice,
  PROVIDER_NAMES,
} from './registry.js';
import type { CustomProviderEntry } from './registry.js';

describe('isProviderName', () => {
  it('accepts known providers and rejects others', () => {
    for (const name of PROVIDER_NAMES) expect(isProviderName(name)).toBe(true);
    expect(isProviderName('gpt')).toBe(false);
    expect(isProviderName('')).toBe(false);
  });
});

describe('makeProvider', () => {
  it('constructs the matching provider for each name', () => {
    expect(makeProvider('claude').name).toBe('claude-code');
    expect(makeProvider('codex').name).toBe('codex');
    expect(makeProvider('cursor').name).toBe('cursor');
    expect(makeProvider('zai').name).toBe('zai');
    expect(makeProvider('openrouter').name).toBe('openrouter');
  });
});

describe('providerSecrets', () => {
  it('returns empty buckets for claude (auth handled separately)', () => {
    expect(providerSecrets(['claude'], {})).toEqual({ sandboxSecrets: {}, proxySecrets: {} });
  });

  it('forwards each non-claude key under the env var its CLI reads (codex -> OPENAI_API_KEY)', () => {
    const env = { CODEX_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex', 'cursor'], env)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key' },
      proxySecrets: {},
    });
  });

  it('reads the codex key from OPENAI_API_KEY when CODEX_API_KEY is absent', () => {
    expect(providerSecrets(['codex'], { OPENAI_API_KEY: 'o-key' } as NodeJS.ProcessEnv)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'o-key' },
      proxySecrets: {},
    });
  });

  it('throws when a selected provider key is missing (normal mode)', () => {
    expect(() => providerSecrets(['codex'], {})).toThrow(/CODEX_API_KEY/);
  });

  it('forwards CODEX_AUTH_JSON and waives the API key (subscription mode)', () => {
    expect(providerSecrets(['codex'], { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' } as NodeJS.ProcessEnv)).toEqual({
      sandboxSecrets: { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' },
      proxySecrets: {},
    });
  });

  it('minifies pretty-printed CODEX_AUTH_JSON so the forwarded value carries no newline', () => {
    const pretty = '{\n  "auth_mode": "chatgpt",\n  "tokens": { "access_token": "x" }\n}\n';
    const { sandboxSecrets } = providerSecrets(['codex'], { CODEX_AUTH_JSON: pretty } as NodeJS.ProcessEnv);
    expect(sandboxSecrets.CODEX_AUTH_JSON).not.toMatch(/[\n\r]/);
    expect(JSON.parse(sandboxSecrets.CODEX_AUTH_JSON ?? '')).toEqual({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } });
  });

  it('rejects a CODEX_AUTH_JSON that parses but is not an object (bare scalar/array)', () => {
    expect(() => providerSecrets(['codex'], { CODEX_AUTH_JSON: '123' } as NodeJS.ProcessEnv)).toThrow(/must be a JSON object/);
    expect(() => providerSecrets(['codex'], { CODEX_AUTH_JSON: '["a"]' } as NodeJS.ProcessEnv)).toThrow(/must be a JSON object/);
  });

  it('keeps CODEX_AUTH_JSON in the sandbox even under --llm-proxy (subscription is a sandbox credential)', () => {
    const env = { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex'], env, { proxyMode: true })).toEqual({
      sandboxSecrets: { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' },
      proxySecrets: {},
    });
  });

  it('subscription mode ignores OPENAI_BASE_URL (mutually exclusive with passthrough)', () => {
    const env = { CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' } as NodeJS.ProcessEnv;
    const { sandboxSecrets } = providerSecrets(['codex'], env);
    expect(sandboxSecrets).not.toHaveProperty('VANGUARD_OPENAI_BASE_URL');
    expect(sandboxSecrets).toEqual({ CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' });
  });

  it('throws when a selected provider key is missing (proxy mode — key required either way)', () => {
    expect(() => providerSecrets(['codex'], {}, { proxyMode: true })).toThrow(/CODEX_API_KEY/);
  });

  it('deduplicates claude + codex, only forwarding codex', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(new Set(['claude', 'codex'] as const), env)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'c-key' },
      proxySecrets: {},
    });
  });

  it('forwards OPENAI_BASE_URL into the sandbox as VANGUARD_OPENAI_BASE_URL (custom endpoint, direct mode)', () => {
    const env = { CODEX_API_KEY: 'c-key', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['codex'], env)).toEqual({
      sandboxSecrets: { OPENAI_API_KEY: 'c-key', VANGUARD_OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' },
      proxySecrets: {},
    });
  });

  it('does not forward OPENAI_BASE_URL under --llm-proxy (the sidecar owns the upstream)', () => {
    const env = { CODEX_API_KEY: 'c-key', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' } as NodeJS.ProcessEnv;
    const { sandboxSecrets } = providerSecrets(['codex'], env, { proxyMode: true });
    expect(sandboxSecrets).not.toHaveProperty('VANGUARD_OPENAI_BASE_URL');
  });

  it('proxy mode holds the codex key back from the sandbox', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['codex'], env, { proxyMode: true });
    expect(sandboxSecrets).not.toHaveProperty('OPENAI_API_KEY');
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets.codex).toBe('c-key');
  });

  it('proxy mode keeps cursor sandbox-injected (no proxyKey, out of scope for v1.4)', () => {
    const env = { CURSOR_API_KEY: 'u-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['cursor'], env, { proxyMode: true })).toEqual({
      sandboxSecrets: { CURSOR_API_KEY: 'u-key' },
      proxySecrets: {},
    });
  });
});

describe('providerSecrets (zai)', () => {
  it('injects ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in normal mode (zai rides the Claude transport)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['zai'], env)).toEqual({
      sandboxSecrets: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4', ANTHROPIC_AUTH_TOKEN: 'z-key' },
      proxySecrets: {},
    });
  });

  it('withholds the z.ai key from the sandbox in proxy mode (no secondary sidecar; key comes via auth)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['zai'], env, { proxyMode: true });
    expect(sandboxSecrets).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(sandboxSecrets).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets).toEqual({});
  });

  it('throws when ZAI_API_KEY is missing (normal mode)', () => {
    expect(() => providerSecrets(['zai'], {})).toThrow(/ZAI_API_KEY/);
  });

  it('throws when ZAI_API_KEY is missing (proxy mode — key required either way)', () => {
    expect(() => providerSecrets(['zai'], {}, { proxyMode: true })).toThrow(/ZAI_API_KEY/);
  });
});

describe('providerSecrets (openrouter)', () => {
  it('injects ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN in normal mode', () => {
    const env = { OPENROUTER_API_KEY: 'or-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['openrouter'], env)).toEqual({
      sandboxSecrets: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'or-key' },
      proxySecrets: {},
    });
  });

  it('withholds the OpenRouter key from the sandbox in proxy mode', () => {
    const env = { OPENROUTER_API_KEY: 'or-key' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['openrouter'], env, { proxyMode: true });
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets).toEqual({});
  });

  it('throws when OPENROUTER_API_KEY is missing', () => {
    expect(() => providerSecrets(['openrouter'], {})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('providerSecrets (meridian)', () => {
  it('injects the operator base URL + a placeholder token in normal mode', () => {
    const env = { MERIDIAN_BASE_URL: 'http://192.168.1.10:3456' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['meridian'], env)).toEqual({
      sandboxSecrets: { ANTHROPIC_BASE_URL: 'http://192.168.1.10:3456', ANTHROPIC_AUTH_TOKEN: 'meridian' },
      proxySecrets: {},
    });
  });

  it('withholds the base URL from the sandbox in proxy mode (owns the primary transport)', () => {
    const env = { MERIDIAN_BASE_URL: 'http://192.168.1.10:3456' } as NodeJS.ProcessEnv;
    const { sandboxSecrets, proxySecrets } = providerSecrets(['meridian'], env, { proxyMode: true });
    expect(sandboxSecrets).toEqual({});
    expect(proxySecrets).toEqual({});
  });

  it('throws when MERIDIAN_BASE_URL is missing', () => {
    expect(() => providerSecrets(['meridian'], {})).toThrow(/MERIDIAN_BASE_URL/);
  });

  it('overrides the placeholder token with MERIDIAN_API_KEY when set (keyed proxy)', () => {
    const env = { MERIDIAN_BASE_URL: 'http://192.168.1.10:3000', MERIDIAN_API_KEY: 'real-key' } as NodeJS.ProcessEnv;
    expect(providerSecrets(['meridian'], env)).toEqual({
      sandboxSecrets: { ANTHROPIC_BASE_URL: 'http://192.168.1.10:3000', ANTHROPIC_AUTH_TOKEN: 'real-key' },
      proxySecrets: {},
    });
  });
});

describe('selectAgents', () => {
  it('routes codex secrets to the sandbox in normal mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.proxySecrets).toEqual({});
    expect(selected.injectAnthropicAuth).toBe(true);
  });

  it('holds the codex key in proxySecrets and out of the sandbox in proxy mode', () => {
    const env = { CODEX_API_KEY: 'c-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex' }, env, { proxyMode: true });
    expect(selected.secrets).not.toHaveProperty('OPENAI_API_KEY');
    expect(selected.proxySecrets.codex).toBe('c-key');
  });

  it('injects z.ai transport secrets and suppresses Anthropic auth for zai', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai' }, env);
    expect(selected.secrets).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      ANTHROPIC_AUTH_TOKEN: 'z-key',
    });
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.proxySecrets).toEqual({});
  });

  it('keeps the z.ai key out of the sandbox in proxy mode (delivered to the primary sidecar via auth)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai' }, env, { proxyMode: true });
    expect(selected.secrets).toEqual({});
    expect(selected.proxySecrets).toEqual({});
    expect(selected.injectAnthropicAuth).toBe(false);
  });

  it('keeps the OpenRouter key out of the sandbox in proxy mode (delivered to the primary sidecar via auth)', () => {
    const env = { OPENROUTER_API_KEY: 'or-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'openrouter' }, env, { proxyMode: true });
    expect(selected.secrets).toEqual({});
    expect(selected.proxySecrets).toEqual({});
    expect(selected.injectAnthropicAuth).toBe(false);
  });

  it('injects Meridian transport secrets and suppresses Anthropic auth', () => {
    const env = { MERIDIAN_BASE_URL: 'http://192.168.1.10:3456' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'meridian' }, env);
    expect(selected.secrets).toEqual({
      ANTHROPIC_BASE_URL: 'http://192.168.1.10:3456',
      ANTHROPIC_AUTH_TOKEN: 'meridian',
    });
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.proxySecrets).toEqual({});
  });

  it('rejects meridian under --llm-proxy (direct-mode only)', () => {
    const env = { MERIDIAN_BASE_URL: 'http://192.168.1.10:3456' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'meridian' }, env, { proxyMode: true })).toThrow(/direct-mode only/);
  });

  it('suppresses Anthropic auth when zai is only the REVIEWER (codex implements)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env);
    // Without this, ANTHROPIC_API_KEY would be injected and the zai reviewer's Claude CLI would
    // prefer it over z.ai's ANTHROPIC_AUTH_TOKEN, hitting api.anthropic.com instead of z.ai.
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
    expect(selected.secrets.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('suppresses Anthropic auth when zai IMPLEMENTS and cursor reviews', () => {
    const env = { CURSOR_API_KEY: 'u-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai', reviewProvider: 'cursor' }, env);
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.secrets.CURSOR_API_KEY).toBe('u-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
  });

  it('rejects mixing claude and zai across stages (shared ANTHROPIC_* transport collides)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'claude', reviewProvider: 'zai' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    expect(() => selectAgents({ provider: 'zai', reviewProvider: 'claude' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    // default provider is claude, so an unspecified implementer + zai reviewer also collides
    expect(() => selectAgents({ reviewProvider: 'zai' }, env)).toThrow(/cannot mix "claude" and "zai"/);
  });

  it('rejects mixing openrouter with other claude-cli-transport providers', () => {
    const env = { OPENROUTER_API_KEY: 'or-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'claude', reviewProvider: 'openrouter' }, env)).toThrow(
      /cannot mix "claude" and "openrouter"/,
    );
    expect(() => selectAgents({ provider: 'zai', reviewProvider: 'openrouter' }, env)).toThrow(
      /cannot mix "openrouter" and "zai"/,
    );
  });

  it('rejects zai as reviewer-only under --llm-proxy (no primary sidecar; would misroute to Anthropic)', () => {
    const env = { CODEX_API_KEY: 'c-key', CURSOR_API_KEY: 'u-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
    expect(() => selectAgents({ provider: 'cursor', reviewProvider: 'zai' }, env, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });

  it('allows codex+zai cross-provider WITHOUT --llm-proxy (zai key rides the sandbox directly)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env);
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.secrets.ANTHROPIC_AUTH_TOKEN).toBe('z-key');
    expect(selected.injectAnthropicAuth).toBe(false);
  });

  it('allows zai-implements + codex-reviews under --llm-proxy (zai owns the primary sidecar)', () => {
    const env = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'zai', reviewProvider: 'codex' }, env, { proxyMode: true });
    expect(selected.proxySecrets.codex).toBe('c-key'); // codex gets its secondary sidecar
    expect(selected.secrets).toEqual({}); // zai key withheld (primary sidecar via auth)
    expect(selected.injectAnthropicAuth).toBe(false);
  });
});

describe('validateProviderChoice', () => {
  it('throws on transport collision: claude + zai both own the claude-cli transport', () => {
    expect(() => validateProviderChoice({ provider: 'claude', reviewProvider: 'zai' })).toThrow(
      /cannot mix "claude" and "zai"/,
    );
  });

  it('does NOT throw when codex implements and zai reviews (different transports)', () => {
    expect(() => validateProviderChoice({ provider: 'codex', reviewProvider: 'zai' })).not.toThrow();
  });

  it('throws when zai is reviewer-only under proxy mode (no primary sidecar for it)', () => {
    expect(() => validateProviderChoice({ provider: 'codex', reviewProvider: 'zai' }, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });

  it('selectAgents still throws on the same combos (behaviour unchanged)', () => {
    const env = { ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'claude', reviewProvider: 'zai' }, env)).toThrow(
      /cannot mix "claude" and "zai"/,
    );
    const env2 = { CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' } as NodeJS.ProcessEnv;
    expect(() => selectAgents({ provider: 'codex', reviewProvider: 'zai' }, env2, { proxyMode: true })).toThrow(
      /needs "zai" as the implementer/,
    );
  });
});

describe('llmProxySupported', () => {
  const CUSTOM: CustomProviderEntry[] = [
    { index: 0, name: 'my-proxy', spec: { name: 'my-proxy', baseUrl: 'https://llm.example.com', keyEnv: 'MY_PROXY_API_KEY' } },
  ];

  it('true for every choice --llm-proxy accepts (claude, codex, zai implementing, codex reviewing zai)', () => {
    expect(llmProxySupported({})).toBe(true);
    expect(llmProxySupported({ provider: 'claude' })).toBe(true);
    expect(llmProxySupported({ provider: 'codex' })).toBe(true);
    expect(llmProxySupported({ provider: 'cursor' })).toBe(true);
    expect(llmProxySupported({ provider: 'zai' })).toBe(true);
    expect(llmProxySupported({ provider: 'zai', reviewProvider: 'codex' })).toBe(true);
  });

  it('false for proxy-specific ineligibility: direct-only providers, and a primary-sidecar owner in a secondary role', () => {
    expect(llmProxySupported({ provider: 'meridian' })).toBe(false);
    expect(llmProxySupported({ provider: 'my-proxy', customProviders: CUSTOM })).toBe(false);
    expect(llmProxySupported({ provider: 'codex', reviewProvider: 'meridian' })).toBe(false);
    expect(llmProxySupported({ provider: 'codex', reviewProvider: 'zai' })).toBe(false);
    expect(llmProxySupported({ provider: 'codex', fallbackProvider: 'zai' })).toBe(false);
  });

  it('RETHROWS what is wrong with the choice regardless of the proxy, instead of reporting "unsupported"', () => {
    // A caller that reads false runs direct; swallowing these would turn a run-stopping misconfiguration
    // into a silently different run.
    expect(() => llmProxySupported({ provider: 'claude', reviewProvider: 'zai' })).toThrow(/cannot mix "claude" and "zai"/);
    expect(() => llmProxySupported({ provider: 'claude', fallbackProvider: 'claude' })).toThrow(/is the implementer itself/);
    expect(() => llmProxySupported({ provider: 'bogus' })).toThrow(/Unknown provider "bogus"/);
    expect(() => llmProxySupported({ provider: 'bad', customProviders: [{ index: 0, name: 'bad', error: 'customProviders[0]: broken' }] })).toThrow(
      /customProviders\[0\]: broken/,
    );
  });
});

describe('subscriptionCredentialProvider', () => {
  const SUB = { CODEX_AUTH_JSON: '{"tokens":{}}' } as NodeJS.ProcessEnv;

  it('names the used provider whose subscription credential is set', () => {
    expect(subscriptionCredentialProvider({ provider: 'codex' }, SUB)).toBe('codex');
    // Every role counts, not just the implementer: the credential lands in the same sandbox.
    expect(subscriptionCredentialProvider({ provider: 'claude', reviewProvider: 'codex' }, SUB)).toBe('codex');
    expect(subscriptionCredentialProvider({ provider: 'claude', fallbackProvider: 'codex' }, SUB)).toBe('codex');
  });

  it('undefined when no used provider has one set: unset, empty, or simply not selected', () => {
    expect(subscriptionCredentialProvider({ provider: 'codex' }, {})).toBeUndefined();
    expect(subscriptionCredentialProvider({ provider: 'codex' }, { CODEX_AUTH_JSON: '' })).toBeUndefined();
    expect(subscriptionCredentialProvider({ provider: 'claude' }, SUB)).toBeUndefined(); // codex not in the run
    expect(subscriptionCredentialProvider({ provider: 'cursor' }, SUB)).toBeUndefined(); // no subscriptionEnv at all
  });
});

describe('providerUpstream', () => {
  it('reads the sidecar upstream from the provider table: zai and openrouter own one, the rest ride Anthropic', () => {
    expect(providerUpstream('zai')).toBe('zai');
    expect(providerUpstream('openrouter')).toBe('openrouter');
    for (const name of ['claude', 'codex', 'cursor', 'meridian', undefined, 'acme-custom']) {
      expect(providerUpstream(name)).toBe('anthropic');
    }
  });
});

describe('implementer fallback provider', () => {
  it('selects the fallback agent and delivers its secrets alongside the implementer (claude → codex)', () => {
    const env = { CODEX_API_KEY: 'c-key', CLAUDE_CODE_OAUTH_TOKEN: 't' } as NodeJS.ProcessEnv;
    const selected = selectAgents({ provider: 'claude', fallbackProvider: 'codex' }, env);
    expect(selected.agent.name).toBe('claude-code');
    expect(selected.fallbackAgent?.name).toBe('codex');
    expect(selected.secrets.OPENAI_API_KEY).toBe('c-key');
    expect(selected.injectAnthropicAuth).toBe(true);
  });

  it('rejects a fallback on the implementer\'s transport slot (claude → openrouter both drive the claude CLI via ANTHROPIC_BASE_URL)', () => {
    expect(() => validateProviderChoice({ provider: 'claude', fallbackProvider: 'openrouter' })).toThrow(/Implementer fallback cannot mix "claude" and "openrouter"/);
    expect(() => validateProviderChoice({ provider: 'codex', fallbackProvider: 'claude' })).not.toThrow();
  });

  it('rejects a fallback that collides with the review provider, or equals the implementer', () => {
    expect(() => validateProviderChoice({ provider: 'claude', reviewProvider: 'codex', fallbackProvider: 'codex' })).not.toThrow(); // same provider may serve both roles
    expect(() => validateProviderChoice({ provider: 'codex', reviewProvider: 'claude', fallbackProvider: 'openrouter' })).toThrow(/share the claude-cli transport/);
    expect(() => validateProviderChoice({ provider: 'claude', fallbackProvider: 'claude' })).toThrow(/is the implementer itself/);
  });

  it('under --llm-proxy a fallback that owns the primary sidecar transport is rejected', () => {
    expect(() => validateProviderChoice({ provider: 'codex', fallbackProvider: 'zai' }, { proxyMode: true })).toThrow(/cannot be a fallback under --llm-proxy/);
  });
});
