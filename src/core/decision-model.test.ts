import { describe, it, expect, vi } from 'vitest';
import { decide, decisionModelConfig, decisionModelMissing, decisionEgressAllowed, isDecisionModelName, probability } from './decision-model.js';

const cfg = { url: 'https://example.test/run', token: 'tok', model: 'clef-flash' };
const questions = { ok: { type: 'noul' as const, instructions: 'ok?' } };

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('decisionModelConfig', () => {
  it('needs credentials and, on Workers AI, a hosted model; a generic URL wins and never gets the Cloudflare token', () => {
    expect(decisionModelConfig({})).toBeUndefined();
    const cf = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't' };
    expect(decisionModelConfig(cf)).toEqual({ url: 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef', token: 't', model: 'clef' });
    expect(decisionModelConfig(cf, 'clef')?.model).toBe('clef');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(decisionModelConfig(cf, 'jev')).toBeUndefined();
    warn.mockRestore();
    expect(decisionModelConfig({ ...cf, VANGUARD_DECISION_URL: 'http://ai-box/decide' }, 'jev')).toEqual({ url: 'http://ai-box/decide', model: 'jev' });
  });

  it('refuses plain http to a non-local host, with or without a token; local http stays allowed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://ai-box.example.com/decide', VANGUARD_DECISION_TOKEN: 't' })).toBeUndefined();
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://ai-box.example.com/decide' })).toBeUndefined(); // the state still leaks
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://[2001:db8::1]/decide' })).toBeUndefined();
    // A public name that merely starts like a private range is not local.
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://10.attacker.com/decide' })).toBeUndefined();
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://192.168.evil.io/decide' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(5);
    expect(decisionModelMissing('clef', { VANGUARD_DECISION_URL: 'http://ai-box.example.com/decide' })).toMatch(/use https/);
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://100.64.0.9:8080/decide', VANGUARD_DECISION_TOKEN: 't' })?.url).toBe('http://100.64.0.9:8080/decide'); // Tailscale
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://localhost:8080/decide', VANGUARD_DECISION_TOKEN: 't' })).toBeDefined();
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://[::1]:8080/decide' })).toBeDefined();
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'https://ai-box.example.com/decide', VANGUARD_DECISION_TOKEN: 't' })).toBeDefined();
    expect(decisionModelConfig({ VANGUARD_DECISION_URL: 'http://192.168.1.214:8080/decide' })).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it('a malformed success body is "no answers", not a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const junk = (async () => { n += 1; return new Response('not json', { status: 200 }); }) as unknown as typeof fetch;
    expect(await decide({}, questions, cfg, { fetchImpl: junk, retries: 1 })).toBeUndefined();
    expect(n).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('no answers');
    warn.mockRestore();
  });

  it('isDecisionModelName recognises the decision-model names only', () => {
    expect(isDecisionModelName('clef')).toBe(true);
    expect(isDecisionModelName('clef-flash')).toBe(true);
    expect(isDecisionModelName('jev')).toBe(true);
    expect(isDecisionModelName('claude-haiku-4-5-20251001')).toBe(false);
  });
});

describe('decide', () => {
  it('posts model/state/questions with the bearer token and unwraps a Workers AI or bare body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const wrapped = await decide({ a: 1 }, questions, cfg, { fetchImpl: fakeFetch(200, { success: true, result: { model: 'clef-flash', answers: { ok: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 42 } } }, calls) });
    expect(wrapped).toMatchObject({ model: 'clef-flash', answers: { ok: { noul: 0.8 } }, inputTokens: 42 });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'clef-flash', state: { a: 1 }, questions });
    const bare = await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { model: 'jev', answers: { ok: { noul: 0.1 } }, usage: { input_tokens: 1 } }) });
    expect(bare?.model).toBe('jev');
  });

  it('returns undefined (never throws) on non-2xx, a body without/with null answers, or a network error, quoting the endpoint error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(401, { errors: [{ code: 10000, message: 'Authentication error' }] }) })).toBeUndefined();
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { success: false, result: null, errors: [{ message: 'No such model' }] }) })).toBeUndefined();
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { result: { answers: null } }) })).toBeUndefined();
    expect(await decide({}, questions, cfg, { fetchImpl: fakeFetch(200, { answers: [] }) })).toBeUndefined();
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    expect(await decide({}, questions, cfg, { fetchImpl: boom, label: 'x' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(5);
    const lines = warn.mock.calls.map(([l]) => String(l));
    expect(lines[0]).toContain('HTTP 401: Authentication error');
    expect(lines[1]).toContain('No such model');
    expect(lines.every((l) => !l.includes('example.test'))).toBe(true);
    warn.mockRestore();
  });

  it('retries once on a 5xx/429 or network error, never on another 4xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const flaky = (async () => {
      n += 1;
      return n === 1 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ answers: { ok: { noul: 0.9 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await decide({}, questions, cfg, { fetchImpl: flaky, retries: 1 }))?.answers['ok']?.noul).toBe(0.9);
    expect(n).toBe(2);
    let m = 0;
    const forbidden = (async () => { m += 1; return new Response('{}', { status: 403 }); }) as unknown as typeof fetch;
    expect(await decide({}, questions, cfg, { fetchImpl: forbidden, retries: 1 })).toBeUndefined();
    expect(m).toBe(1);
    warn.mockRestore();
  });

  it('decisionModelMissing explains jev-on-Workers-AI, and decisionEgressAllowed gates white-label on the consent switch', () => {
    const cf = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AUTH_TOKEN: 't' };
    expect(decisionModelMissing('jev', cf)).toMatch(/not hosted on Workers AI/);
    expect(decisionModelMissing('clef-flash', {})).toMatch(/set CLOUDFLARE_ACCOUNT_ID/);
    expect(decisionEgressAllowed(false, {})).toBe(true);
    expect(decisionEgressAllowed(true, {})).toBe(false);
    expect(decisionEgressAllowed(true, { VANGUARD_DECISION_PROBE: '1' })).toBe(false);
    expect(decisionEgressAllowed(true, { VANGUARD_DECISION_PROBE: 'all' })).toBe(true);
    expect(probability(0.5)).toBe(0.5);
    expect(probability(82)).toBeUndefined();
    expect(probability('0.8')).toBeUndefined();
    expect(probability(null)).toBeUndefined();
  });
});
