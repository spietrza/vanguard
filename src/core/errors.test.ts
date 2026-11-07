import { describe, it, expect } from 'vitest';
import { isRateLimitError, failureReason, formatFailureComment, visibleError, VanguardError } from './errors.js';

describe('failureReason', () => {
  it('masks credentials and collapses the message to one line, since it lands in a public CI log', () => {
    const key = `sk-${'A1b2'.repeat(12)}`;
    const reason = failureReason(new Error(`codex exec failed\n\n  OPENAI_API_KEY=${key} rejected\n  Authorization: Bearer ${'x'.repeat(40)}`));
    expect(reason).toBe('codex exec failed OPENAI_API_KEY=[REDACTED-KEY] rejected Authorization: Bearer [REDACTED]');
    expect(reason).not.toContain(key);
  });

  it('strips credentials from a git remote URL, the shape a failed push or fetch prints', () => {
    const reason = failureReason(new Error(`fatal: unable to access 'https://oauth2:glpat-${'Ab1'.repeat(8)}@gitlab.com/g/p.git/'`));
    expect(reason).toBe("fatal: unable to access 'https://[REDACTED]@gitlab.com/g/p.git/'");
  });

  it('caps a multi-kilobyte provider dump to a short excerpt', () => {
    const reason = failureReason('x'.repeat(2000));
    expect(reason.length).toBeLessThanOrEqual(201);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('handles a non-Error throw', () => {
    expect(failureReason('plain string')).toBe('plain string');
  });
});

describe('formatFailureComment', () => {
  it('carries the throwing site, so a bare TypeError is diagnosable from the comment alone', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'split')");

    const comment = formatFailureComment('Vanguard run failed', error);

    expect(comment).toContain("Vanguard run failed: TypeError: Cannot read properties of undefined (reading 'split')");
    expect(comment).toContain('<details><summary>stack</summary>');
    expect(comment).toContain('errors.test.ts');
  });

  it('trims the stack to 25 lines so a deep async trace cannot flood the comment', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 200 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`)].join(
      '\n',
    );

    const fenced = formatFailureComment('Vanguard run failed', error).split('```')[1] ?? '';

    expect(fenced.trim().split('\n')).toHaveLength(25);
    expect(fenced).toContain('at frame23');
    expect(fenced).not.toContain('at frame24');
  });

  it('falls back to the one-line shape for a non-Error throw', () => {
    expect(formatFailureComment('Vanguard spec failed', 'plain string')).toBe('Vanguard spec failed: plain string');
  });

  it('falls back to the one-line shape when an Error carries no stack', () => {
    const error = new Error('no stack here');
    error.stack = '';

    expect(formatFailureComment('Vanguard run failed', error)).toBe('Vanguard run failed: Error: no stack here');
  });
});

describe('visibleError', () => {
  it('passes a VanguardError through untouched', () => {
    const error = new VanguardError('already visible');

    expect(visibleError(error)).toBe(error);
  });

  it('wraps a foreign error with the first non-empty message line', () => {
    expect(visibleError(new Error('\n\ngh: not found\nusage: gh issue view')).message).toBe('gh: not found');
  });
});

describe('isRateLimitError', () => {
  it.each(['HTTP 429', 'status code 429', 'API Error: 429', '{"code":429}', '429 Too Many Requests', 'rate_limit_error', 'rate_limit_exceeded', 'Rate limit reached for gpt-5'])('recognizes %s', (message) => {
    expect(isRateLimitError(new Error(message))).toBe(true);
  });
  it.each(['API rate limit exceeded for user alice', 'gh failed: API rate limit exceeded', 'line 429', 'implement rate limiting', 'invalid API key'])('rejects %s', (message) => {
    expect(isRateLimitError(new Error(message))).toBe(false);
  });
});
