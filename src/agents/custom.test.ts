import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CustomProvider, customProviderError, loadCustomProviders } from './custom.js';
import {
  assertEgressCompatible,
  claudeCliKeyEnv,
  customEgressHosts,
  forcedProviderModel,
  makeProvider,
  needsAnthropicAuth,
  providerSecrets,
  selectAgents,
  validateProviderChoice,
} from './registry.js';
import { agentAuthFromEnv } from './auth.js';
import type { CustomProviderEntry } from './custom.js';

async function repoWith(config: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vg-custom-'));
  await mkdir(join(repo, '.vanguard'), { recursive: true });
  await writeFile(join(repo, '.vanguard', 'app.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return repo;
}

const ENTRY = { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY', model: 'glm-5.2' };

const loaded = (over: Partial<typeof ENTRY> & Record<string, unknown> = {}): CustomProviderEntry[] => {
  const spec = { ...ENTRY, ...over } as typeof ENTRY;
  return [{ index: 0, name: spec.name, spec }];
};

describe('customProviderError (the one validity predicate)', () => {
  const seen = new Set<string>();
  it.each([
    ['non-object', 'nope', /entry must be an object/],
    ['unknown key', { ...ENTRY, label: 'x' }, /unknown key "label"/],
    ['bad name grammar', { ...ENTRY, name: 'My-Proxy' }, /"name" must match/],
    ['missing name', { baseUrl: ENTRY.baseUrl, keyEnv: ENTRY.keyEnv }, /"name" must match/],
    ['built-in collision', { ...ENTRY, name: 'zai' }, /built-in provider name/],
    ['relative baseUrl', { ...ENTRY, baseUrl: '/api' }, /absolute http/],
    ['non-http scheme', { ...ENTRY, baseUrl: 'ftp://x.example' }, /absolute http/],
    ['missing keyEnv', { name: 'a', baseUrl: ENTRY.baseUrl }, /"keyEnv" must name/],
    ['bad keyEnv grammar', { ...ENTRY, keyEnv: '1BAD' }, /"keyEnv" must name/],
    ['keyEnv borrowing the subscription token', { ...ENTRY, keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }, /must not name a credential/],
    ['keyEnv borrowing the push token', { ...ENTRY, keyEnv: 'GH_TOKEN' }, /must not name a credential/],
    ['empty model', { ...ENTRY, model: '' }, /"model" must be a non-empty string/],
  ])('rejects %s', (_label, entry, re) => {
    expect(customProviderError(entry, seen)).toMatch(re);
  });

  it('accepts the reference entry, with and without model', () => {
    expect(customProviderError(ENTRY, seen)).toBeUndefined();
    const { model: _m, ...noModel } = ENTRY;
    expect(customProviderError(noModel, seen)).toBeUndefined();
  });

  it('rejects a duplicate of an earlier healthy name', () => {
    expect(customProviderError(ENTRY, new Set(['my-proxy']))).toMatch(/duplicate provider name/);
  });

  it('is prototype-key-proof: "toString" is a legal name, not an inherited hit', () => {
    expect(customProviderError({ ...ENTRY, name: 'tostring' }, seen)).toBeUndefined();
  });
});

describe('loadCustomProviders (lenient edges)', () => {
  it('missing file / missing key / null / [] ⇒ []', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'vg-none-'));
    expect(await loadCustomProviders(bare)).toEqual([]);
    expect(await loadCustomProviders(await repoWith({}))).toEqual([]);
    expect(await loadCustomProviders(await repoWith({ customProviders: null }))).toEqual([]);
    expect(await loadCustomProviders(await repoWith({ customProviders: [] }))).toEqual([]);
  });

  it('unparseable JSON ⇒ one index -1 pseudo-entry, never a throw', async () => {
    const entries = await loadCustomProviders(await repoWith('{not json'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ index: -1 });
    expect(entries[0]?.error).toMatch(/not valid JSON/);
  });

  it('non-array customProviders ⇒ index -1 pseudo-entry', async () => {
    const entries = await loadCustomProviders(await repoWith({ customProviders: 'yes' }));
    expect(entries[0]).toMatchObject({ index: -1, error: '"customProviders" must be an array' });
  });

  it('healthy + broken entries coexist; the broken one names its index and rule', async () => {
    const repo = await repoWith({ customProviders: [ENTRY, { ...ENTRY, name: 'claude' }] });
    const entries = await loadCustomProviders(repo);
    expect(entries[0]).toMatchObject({ index: 0, name: 'my-proxy' });
    expect(entries[0]?.spec).toEqual(ENTRY);
    expect(entries[1]?.error).toMatch(/customProviders\[1\].*built-in/);
    expect(entries[1]?.spec).toBeUndefined();
  });

  it('a broken entry cannot silently shadow a later healthy same-name entry (review #340 obs 2)', async () => {
    const repo = await repoWith({ customProviders: [{ ...ENTRY, baseUrl: 'bad' }, ENTRY] });
    const entries = await loadCustomProviders(repo);
    expect(entries[0]?.error).toMatch(/baseUrl/);
    expect(entries[1]?.error).toMatch(/duplicate/); // NOT silently healthy behind the broken first
  });

  it('duplicate names: the SECOND entry is flagged', async () => {
    const repo = await repoWith({ customProviders: [ENTRY, ENTRY] });
    const entries = await loadCustomProviders(repo);
    expect(entries[0]?.error).toBeUndefined();
    expect(entries[1]?.error).toMatch(/duplicate/);
  });
});

describe('registry resolution with customs', () => {
  it('synthesizes a claude-CLI provider named custom:<name>', () => {
    const agent = makeProvider('my-proxy', loaded());
    expect(agent).toBeInstanceOf(CustomProvider);
    expect(agent.name).toBe('custom:my-proxy');
  });

  it('unknown name lists built-ins + healthy custom names', () => {
    expect(() => makeProvider('bogus', loaded())).toThrow(/claude.*my-proxy/s);
  });

  it('a broken entry throws its recorded error when USED (and only then)', () => {
    const entries: CustomProviderEntry[] = [{ index: 0, name: 'bad', error: 'customProviders[0]: "baseUrl" must be an absolute http:// or https:// URL' }];
    expect(() => makeProvider('bad', entries)).toThrow(/baseUrl/);
    expect(() => makeProvider('claude', entries)).not.toThrow();
  });

  it('providerSecrets injects base URL + key from keyEnv; missing key fails fast naming it', () => {
    const env = { MY_PROXY_API_KEY: 'sk-custom' };
    const { sandboxSecrets } = providerSecrets(['my-proxy'], env, {}, loaded());
    expect(sandboxSecrets).toEqual({ ANTHROPIC_BASE_URL: 'https://llm.example.com/api', ANTHROPIC_AUTH_TOKEN: 'sk-custom' });
    expect(() => providerSecrets(['my-proxy'], {}, {}, loaded())).toThrow(/MY_PROXY_API_KEY/);
  });

  it('owns the Claude CLI transport: auth suppression + keyEnv-carried credential', () => {
    const customs = loaded();
    expect(needsAnthropicAuth({ provider: 'my-proxy', customProviders: customs })).toBe(false);
    expect(claudeCliKeyEnv('my-proxy', customs)).toEqual(['MY_PROXY_API_KEY']);
    const auth = agentAuthFromEnv({ provider: 'my-proxy', customProviders: customs }, { MY_PROXY_API_KEY: 'sk-x' });
    expect(auth).toEqual({ mode: 'api', apiKey: 'sk-x' });
  });

  it('selectAgents: sandbox secrets set, Anthropic authSecrets suppressed', () => {
    const selected = selectAgents({ provider: 'my-proxy', customProviders: loaded() }, { MY_PROXY_API_KEY: 'k' });
    expect(selected.agent.name).toBe('custom:my-proxy');
    expect(selected.injectAnthropicAuth).toBe(false);
    expect(selected.secrets.ANTHROPIC_BASE_URL).toBe('https://llm.example.com/api');
  });

  it('forcedProviderModel: custom model + zai forced, claude undefined', () => {
    expect(forcedProviderModel('my-proxy', loaded())).toBe('glm-5.2');
    const { model: _m, ...noModel } = ENTRY;
    expect(forcedProviderModel('my-proxy', [{ index: 0, name: 'my-proxy', spec: noModel }])).toBeUndefined();
    expect(forcedProviderModel('zai')).toBe('glm-5.2');
    expect(forcedProviderModel('openrouter')).toBe('anthropic/claude-sonnet-4.6');
    expect(forcedProviderModel('claude')).toBeUndefined();
  });

  it('directOnly: rejected under --llm-proxy at validate time, naming the custom', () => {
    expect(() => validateProviderChoice({ provider: 'my-proxy', customProviders: loaded() }, { proxyMode: true }))
      .toThrow(/"my-proxy" is direct-mode only/);
  });

  it('transport collision: custom + claude cross-review rejected', () => {
    expect(() => validateProviderChoice({ provider: 'my-proxy', reviewProvider: 'claude', customProviders: loaded() }))
      .toThrow(/share the claude-cli transport/);
  });

  it('customEgressHosts extracts the hostname (port dropped); built-ins contribute none', () => {
    expect(customEgressHosts({ provider: 'my-proxy', customProviders: loaded({ baseUrl: 'https://llm.example.com:8443/api' }) }))
      .toEqual(['llm.example.com']);
    expect(customEgressHosts({ provider: 'zai' })).toEqual([]);
    expect(customEgressHosts({})).toEqual([]);
  });

  it('http endpoint: assertEgressCompatible throws; https passes', () => {
    expect(() => assertEgressCompatible({ provider: 'my-proxy', customProviders: loaded({ baseUrl: 'http://nas.local:3456' }) }))
      .toThrow(/http:\/\/ endpoint.*egress/s);
    expect(() => assertEgressCompatible({ provider: 'my-proxy', customProviders: loaded() })).not.toThrow();
  });
});

describe('CustomProvider model forcing (zai pattern via the mocked stream seam)', () => {
  it('forces spec.model when the run picks none; an explicit input.model wins; no model config passes through', async () => {
    vi.resetModules();
    const calls: Array<{ input: { model?: string }; args: string[] }> = [];
    vi.doMock('./claude-stream.js', () => ({
      runClaudeCli: (input: { model?: string }, buildArgs: (i: { model?: string }) => string[]) => {
        calls.push({ input, args: buildArgs(input) });
        return (async function* () {
          return { finalText: '', turns: 0 };
        })();
      },
    }));
    const { CustomProvider: MockedCustom } = await import('./custom.js');

    const forced = new MockedCustom(ENTRY);
    forced.run({ prompt: 'p' } as Parameters<typeof forced.run>[0]);
    forced.run({ prompt: 'p', model: 'explicit' } as Parameters<typeof forced.run>[0]);
    const { model: _m, ...noModel } = ENTRY;
    new MockedCustom(noModel).run({ prompt: 'p' } as Parameters<typeof forced.run>[0]);

    expect(calls[0]?.args.join(' ')).toContain('glm-5.2');
    expect(calls[1]?.args.join(' ')).toContain('explicit');
    expect(calls[1]?.args.join(' ')).not.toContain('glm-5.2');
    expect(calls[2]?.args.join(' ')).not.toContain('glm-5.2');
    vi.doUnmock('./claude-stream.js');
    vi.resetModules();
  });
});
