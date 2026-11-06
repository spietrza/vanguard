import { describe, it, expect } from 'vitest';
import {
  mergeAnthropicBeta,
  filterAnthropicBeta,
  upstreamAuthHeaders,
  openaiAuthHeaders,
  isAllowedLlmPath,
  constantTimeEqual,
  upstreamPath,
  UPSTREAMS,
} from './llm-proxy-rewrite.mjs';

describe('mergeAnthropicBeta', () => {
  it('appends the oauth beta and dedupes, preserving request betas', () => {
    expect(mergeAnthropicBeta('foo-1,bar-2', 'oauth-2025-04-20')).toBe('foo-1,bar-2,oauth-2025-04-20');
    expect(mergeAnthropicBeta('oauth-2025-04-20,foo', 'oauth-2025-04-20')).toBe('oauth-2025-04-20,foo');
    expect(mergeAnthropicBeta(undefined, 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('drops empty/whitespace segments', () => {
    expect(mergeAnthropicBeta('foo,,bar', 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(' , ', 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
  it('coerces an array input to a comma-joined string', () => {
    expect(mergeAnthropicBeta(['foo', 'bar'], 'oauth-2025-04-20')).toBe('foo,bar,oauth-2025-04-20');
    expect(mergeAnthropicBeta(['oauth-2025-04-20'], 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
  });
});

describe('filterAnthropicBeta', () => {
  it('keeps the betas Claude Code sends for normal runs', () => {
    const cc = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24';
    expect(filterAnthropicBeta(cc)).toBe(cc);
  });
  it('drops egress-capable families, including re-dated and mixed-case variants', () => {
    expect(filterAnthropicBeta('mcp-client-2025-04-04,foo,web-fetch-2025-09-10,Files-API-2025-04-14,code-execution-2099-01-01')).toBe('foo');
    expect(filterAnthropicBeta(['mcp-servers-2025-12-04', 'skills-2025-10-02'])).toBeUndefined();
  });
  it('does not drop a family that merely shares a prefix', () => {
    expect(filterAnthropicBeta('skills-extra-2026-01-01')).toBe('skills-extra-2026-01-01');
  });
  it('blocked betas never reach the upstream in either auth mode', () => {
    const req = { 'anthropic-beta': 'mcp-client-2025-04-04,foo' };
    expect(upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, req)['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect(upstreamAuthHeaders({ mode: 'api', secret: 'sk' }, req)['anthropic-beta']).toBe('foo');
    expect('anthropic-beta' in upstreamAuthHeaders({ mode: 'api', secret: 'sk' }, { 'anthropic-beta': 'web-fetch-2025-09-10' })).toBe(false);
  });
});

describe('upstreamAuthHeaders', () => {
  it('subscription: Bearer + merged oauth beta, drops x-api-key', () => {
    const h = upstreamAuthHeaders({ mode: 'subscription', secret: 'oat' }, { 'anthropic-beta': 'foo' });
    expect(h.authorization).toBe('Bearer oat');
    expect(h['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    expect('x-api-key' in h).toBe(false);
  });
  it('api: x-api-key, no oauth beta, no authorization', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, { 'anthropic-beta': 'foo' });
    expect(h['x-api-key']).toBe('sk-ant');
    expect('authorization' in h).toBe(false);
    expect(h['anthropic-beta']).toBe('foo'); // unchanged in api mode
  });
  it('api: omits anthropic-beta when the request has none', () => {
    const h = upstreamAuthHeaders({ mode: 'api', secret: 'sk-ant' }, {});
    expect(h['x-api-key']).toBe('sk-ant');
    expect('anthropic-beta' in h).toBe(false);
    expect('authorization' in h).toBe(false);
  });
});

describe('isAllowedLlmPath', () => {
  it('allows only the two messages endpoints by POST', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true')).toBe(true); // query allowed
    expect(isAllowedLlmPath('GET', '/v1/messages')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/complete')).toBe(false);
  });

  it('defaults to anthropic when no upstream arg is given', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'anthropic')).toBe(isAllowedLlmPath('POST', '/v1/messages'));
    expect(isAllowedLlmPath('POST', '/v1/responses')).toBe(false); // anthropic default rejects responses
    expect(isAllowedLlmPath('POST', '/v1/messages')).toBe(true);
  });

  it('openai: allows only POST /v1/responses (query ignored)', () => {
    expect(isAllowedLlmPath('POST', '/v1/responses', 'openai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/responses?x=1', 'openai')).toBe(true);
    expect(isAllowedLlmPath('GET', '/v1/responses', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/messages', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'openai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/models', 'openai')).toBe(false);
  });
});

describe('openaiAuthHeaders', () => {
  it('returns only a Bearer authorization header', () => {
    const h = openaiAuthHeaders('sk-openai');
    expect(h.authorization).toBe('Bearer sk-openai');
    expect('anthropic-beta' in h).toBe(false);
    expect('x-api-key' in h).toBe(false);
    expect(Object.keys(h)).toEqual(['authorization']);
  });

  it('presents the OpenRouter key as a plain Bearer header (openrouter upstream authenticates by bearer)', () => {
    expect(UPSTREAMS.openrouter.auth).toBe('bearer');
    expect(openaiAuthHeaders('sk-or')).toEqual({ authorization: 'Bearer sk-or' });
  });
});

describe('isAllowedLlmPath (zai)', () => {
  it('accepts the anthropic-compatible paths z.ai serves and rejects the rest', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens', 'zai')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages?beta=true', 'zai')).toBe(true);
    // z.ai is not OpenAI-Responses-compatible.
    expect(isAllowedLlmPath('POST', '/v1/responses', 'zai')).toBe(false);
    expect(isAllowedLlmPath('POST', '/v1/chat/completions', 'zai')).toBe(false);
    expect(isAllowedLlmPath('GET', '/v1/messages', 'zai')).toBe(false);
  });
});

describe('isAllowedLlmPath (openrouter)', () => {
  it('accepts the Anthropic-compatible paths OpenRouter serves and rejects the rest', () => {
    expect(isAllowedLlmPath('POST', '/v1/messages', 'openrouter')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/messages/count_tokens', 'openrouter')).toBe(true);
    expect(isAllowedLlmPath('POST', '/v1/responses', 'openrouter')).toBe(false);
    expect(isAllowedLlmPath('GET', '/v1/messages', 'openrouter')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('matches equal strings and rejects others without leaking length via early return', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('upstreamPath', () => {
  it('prepends the z.ai Coding-Plan base path for the zai upstream', () => {
    expect(upstreamPath('zai', '/v1/messages')).toBe('/api/coding/paas/v4/v1/messages');
  });
  it('prepends the OpenRouter Anthropic-skin base path for the openrouter upstream', () => {
    expect(upstreamPath('openrouter', '/v1/messages')).toBe('/api/v1/messages');
  });
  it('preserves query strings when prepending', () => {
    expect(upstreamPath('zai', '/v1/messages?beta=1')).toBe('/api/coding/paas/v4/v1/messages?beta=1');
  });
  it('passes through the path unchanged for anthropic (no base path)', () => {
    expect(upstreamPath('anthropic', '/v1/messages')).toBe('/v1/messages');
  });
  it('falls back to base path + "/" when reqUrl is undefined', () => {
    expect(upstreamPath('zai', undefined)).toBe('/api/coding/paas/v4/');
  });
});
