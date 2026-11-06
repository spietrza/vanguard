import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { runComplete, type CompleteDeps } from './complete.js';

/** A fake agent-SDK query() yielding a fixed message stream. */
function fakeQuery(...msgs: { type: string; subtype?: string; result?: string }[]) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  });
}
const msg = [{ role: 'user' as const, content: 'hi' }];

test('returns the model text on a success result', async () => {
  const r = await runComplete({ messages: msg }, { query: fakeQuery({ type: 'result', subtype: 'success', result: 'hello' }) });
  expect(r.text).toBe('hello');
});

test('surfaces an error result subtype (e.g. auth) as an error, not a throw', async () => {
  const r = await runComplete(
    { messages: msg },
    { query: fakeQuery({ type: 'result', subtype: 'error_during_execution' }) },
  );
  expect(r.error?.message).toMatch(/error_during_execution/);
});

test('no result message → error', async () => {
  const r = await runComplete({ messages: msg }, { query: fakeQuery({ type: 'assistant' }) });
  expect(r.error?.message).toMatch(/no result/);
});

test('empty messages → error', async () => {
  const r = await runComplete({ messages: [] }, { query: fakeQuery() });
  expect(r.error?.message).toMatch(/non-empty/);
});

test('malformed message shape → error', async () => {
  const r = await runComplete({ messages: [{ role: 'system', content: 'x' }] }, { query: fakeQuery() });
  expect(r.error).toBeDefined();
});

test('a thrown query → error, not reject', async () => {
  const boom = () => {
    throw new Error('spawn failed');
  };
  const r = await runComplete({ messages: msg }, { query: boom as never });
  expect(r.error?.message).toMatch(/spawn failed/);
});

test('passes system + model into the query options', async () => {
  let seen: Record<string, unknown> | undefined;
  const spy = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    seen = params.options;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete({ messages: msg, system: 'be terse', model: 'claude-sonnet-5' }, { query: spy });
  expect(seen?.['systemPrompt']).toBe('be terse');
  expect(seen?.['model']).toBe('claude-sonnet-5');
  expect(seen?.['allowedTools']).toEqual([]);
  // >1 (dogfood 2026-07-14): the SDK counts internal steps as turns, and maxTurns:1 died with
  // error_max_turns before any text. Tools stay empty, so the cap is only a runaway stop.
  expect(seen?.['maxTurns']).toBe(8);
});

test('prompt-inlines-mention: a file attachment (@mention / dropped text) is inlined as a fenced block tagged with its path', async () => {
  let prompt: string | AsyncIterable<unknown> | undefined;
  const spy = (params: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete(
    {
      messages: [{ role: 'user', content: 'summarise @src/wire.ts' }],
      attachments: [{ kind: 'file', path: 'src/wire.ts', content: 'export const X = 1;' }],
    },
    { query: spy },
  );
  // Text-only turn ⇒ a string prompt carrying both the message and the fenced file block.
  expect(typeof prompt).toBe('string');
  const text = prompt as string;
  expect(text).toContain('summarise @src/wire.ts');
  expect(text).toContain('`src/wire.ts`:');
  expect(text).toContain('```\nexport const X = 1;\n```');
});

test('a file attachment with no content is not inlined (a bad attachment cannot corrupt the prompt)', async () => {
  let prompt: string | AsyncIterable<unknown> | undefined;
  const spy = (params: { prompt: string | AsyncIterable<unknown> }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete({ messages: msg, attachments: [{ kind: 'file', path: 'x.ts' }] }, { query: spy });
  expect(prompt).toBe('User: hi');
});

test('bounded-payload: inlined file content over the 256KB total is refused before send, with a clear error', async () => {
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    {
      messages: msg,
      attachments: [
        { kind: 'file', path: 'a.ts', content: 'x'.repeat(200_000) },
        { kind: 'file', path: 'b.ts', content: 'y'.repeat(100_000) },
      ],
    },
    { query: spy },
  );
  expect(r.text).toBeUndefined();
  expect(r.error?.message).toMatch(/inline limit/);
  expect(called).toBe(false); // refused before the model is ever hit
});

test('an image path outside the trusted asset root is refused before the model is hit (review r1 security)', async () => {
  // The renderer hands __complete image PATHS; without containment any request could read an
  // arbitrary host file (~/.ssh, .env) and exfiltrate it base64'd into the prompt. The sidecar
  // stamps the TRUSTED assetRoot; every image path must canonicalize under it.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const outside = mkdtempSync(join(tmpdir(), 'vg-outside-'));
  const secret = join(outside, 'secret.png');
  writeFileSync(secret, 'top secret');
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: secret }] },
    { query: spy },
  );
  expect(r.error?.message).toMatch(/asset root/);
  expect(called).toBe(false);
});

test('image attachments without a trusted asset root are refused outright', async () => {
  const r = await runComplete(
    { messages: msg, attachments: [{ kind: 'image', path: '/etc/passwd' }] },
    { query: fakeQuery({ type: 'result', subtype: 'success', result: 'ok' }) },
  );
  expect(r.error?.message).toMatch(/asset root/);
});

test('an oversize image is refused before send (bounded-payload applies to images too)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const big = join(root, 'big.png');
  writeFileSync(big, Buffer.alloc(6_000_000));
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: big }] },
    { query: spy },
  );
  expect(r.error?.message).toMatch(/too large|image/i);
  expect(called).toBe(false);
});

test('a contained, small image goes through as a base64 content block', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  const ok = join(root, 'draft-1-assets');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ok);
  const img = join(ok, 'pic.png');
  writeFileSync(img, Buffer.from('img-bytes'));
  let prompt: unknown;
  const spy = (params: { prompt: unknown }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete(
    { messages: msg, assetRoot: root, attachments: [{ kind: 'image', path: img, mediaType: 'image/png' }] },
    { query: spy },
  );
  expect(r.text).toBe('ok');
  expect(typeof prompt).not.toBe('string'); // streaming-input form with the image block
});

test('aggregate image bytes over the total cap are refused before send (bounded-payload for images)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'vg-assets-'));
  // Four 4MB images: each is under MAX_IMAGE_BYTES (5MB) but together 16MB > MAX_IMAGE_TOTAL_BYTES.
  const attachments = [] as { kind: 'image'; path: string }[];
  for (let i = 0; i < 4; i++) {
    const p = join(root, `img${i}.png`);
    writeFileSync(p, Buffer.alloc(4_000_000));
    attachments.push({ kind: 'image', path: p });
  }
  let called = false;
  const spy = () => {
    called = true;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  const r = await runComplete({ messages: msg, assetRoot: root, attachments }, { query: spy });
  expect(r.error?.message).toMatch(/total|aggregate|images/i);
  expect(called).toBe(false);
});

test('fenced inlining is fence-safe: content with a ``` run gets a longer fence (review r5)', async () => {
  let prompt: unknown;
  const spy = (params: { prompt: unknown }) => {
    prompt = params.prompt;
    return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
  };
  await runComplete(
    { messages: msg, attachments: [{ kind: 'file', path: 'x.md', content: 'a\n```\nfenced\n```\nb' }] },
    { query: spy },
  );
  // The wrapping fence must be longer than the ``` inside so the block can't be broken out of.
  expect(String(prompt)).toContain('````'); // 4+ backticks
});

describe('chatBaseUrl origin allowlist', () => {
  const ENV = 'VANGUARD_CHAT_ALLOWED_ORIGINS';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  /** Records each SDK call's ANTHROPIC_BASE_URL (undefined when no env override was passed). */
  function recorder(): { query: CompleteDeps['query']; calls: (string | undefined)[] } {
    const calls: (string | undefined)[] = [];
    const query: CompleteDeps['query'] = (params) => {
      const env = params.options?.['env'] as Record<string, string> | undefined;
      calls.push(env?.['ANTHROPIC_BASE_URL']);
      return fakeQuery({ type: 'result', subtype: 'success', result: 'ok' })();
    };
    return { query, calls };
  }

  test('a foreign origin is refused without an allowlist and the SDK is never called', async () => {
    const rec = recorder();
    const r = await runComplete({ messages: msg, baseUrl: 'https://collector.example/v1' }, rec);
    expect(r.error?.message).toContain('https://collector.example');
    expect(r.error?.message).toContain(ENV);
    expect(rec.calls).toEqual([]);
  });

  test('a non-http(s) or malformed baseUrl is refused', async () => {
    for (const bad of ['file:///etc/passwd', 'not a url', '']) {
      const rec = recorder();
      const r = await runComplete({ messages: msg, baseUrl: bad }, rec);
      expect(r.error).toBeDefined();
      expect(rec.calls).toEqual([]);
    }
  });

  test('an origin the operator allowlisted is used', async () => {
    process.env[ENV] = ' https://other.example , https://proxy.internal:8443/ ';
    const rec = recorder();
    const r = await runComplete({ messages: msg, baseUrl: 'https://proxy.internal:8443/anthropic' }, rec);
    expect(r.text).toBe('ok');
    expect(rec.calls).toEqual(['https://proxy.internal:8443/anthropic']);
  });

  test('the allowlist matches whole origins, not prefixes, other ports or schemes', async () => {
    process.env[ENV] = 'https://proxy.internal';
    for (const bad of ['https://proxy.internal.evil.example', 'https://proxy.internal:9999', 'http://proxy.internal']) {
      const rec = recorder();
      const r = await runComplete({ messages: msg, baseUrl: bad }, rec);
      expect(r.error).toBeDefined();
      expect(rec.calls).toEqual([]);
    }
  });

  test('the Anthropic API origin and the no-baseUrl default are unaffected', async () => {
    const rec = recorder();
    expect((await runComplete({ messages: msg, baseUrl: 'https://api.anthropic.com' }, rec)).text).toBe('ok');
    expect((await runComplete({ messages: msg }, rec)).text).toBe('ok');
    expect(rec.calls).toEqual(['https://api.anthropic.com', undefined]);
  });
});
