import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { injectHubMarker, serveStatic } from './static.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

class FakeRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  ended = false;

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    this.ended = true;
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

let uiDir: string;

beforeEach(async () => {
  uiDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-static-'));
});

afterEach(async () => {
  await rm(uiDir, { recursive: true, force: true });
});

describe('injectHubMarker', () => {
  test('T-67 injects the marker exactly once right after <head>, leaving the rest byte-identical', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
    const out = injectHubMarker(html);
    const marker = '<script>window.__VANGUARD_HUB__=true</script>';
    expect(out.split(marker)).toHaveLength(2);
    expect(out).toBe(html.replace('<head>', `<head>${marker}`));
  });

  test('injects the per-launch token script after the marker when one is passed', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
    const out = injectHubMarker(html, 'de:ad"beef');
    expect(out).toBe(
      html.replace(
        '<head>',
        '<head><script>window.__VANGUARD_HUB__=true</script><script>window.__VANGUARD_HUB_TOKEN__="de:ad\\"beef"</script>',
      ),
    );
  });

  test('omits the token script entirely when no token is passed (the CLI build check)', () => {
    const out = injectHubMarker('<html><head></head><body></body></html>');
    expect(out).not.toContain('__VANGUARD_HUB_TOKEN__');
    expect(out).toContain('__VANGUARD_HUB__');
  });

  test('throws when there is no <head> to inject after', () => {
    expect(() => injectHubMarker('<html><body>no head here</body></html>')).toThrow(/<head>/);
  });
});

describe('serveStatic', () => {
  test('index.html gets the marker, HEAD has no body, and symlinks cannot escape the UI root', async () => {
    await writeFile(join(uiDir, 'index.html'), '<html><head></head></html>');
    const index = new FakeRes();
    await serveStatic({ uiDir }, fakeReq('/index.html'), index as unknown as ServerResponse);
    expect(index.body).toContain('__VANGUARD_HUB__');
    expect(index.headers['cache-control']).toBe('no-store');
    const head = new FakeRes();
    await serveStatic({ uiDir }, fakeReq('/', 'HEAD'), head as unknown as ServerResponse);
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    await symlink('/etc/hosts', join(uiDir, 'outside.txt'));
    const outside = new FakeRes();
    await serveStatic({ uiDir }, fakeReq('/outside.txt'), outside as unknown as ServerResponse);
    expect(outside.statusCode).toBe(404);
  });

  test('T-68 a hashed static asset gets an immutable cache header; index.html gets no-store', async () => {
    await mkdir(join(uiDir, 'assets'), { recursive: true });
    await writeFile(join(uiDir, 'assets', 'x-abc123.js'), 'console.log(1)');
    await writeFile(join(uiDir, 'index.html'), '<html><head></head><body></body></html>');

    const assetRes = new FakeRes();
    await serveStatic({ uiDir }, fakeReq('/assets/x-abc123.js'), assetRes as unknown as ServerResponse);
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const indexRes = new FakeRes();
    await serveStatic({ uiDir }, fakeReq('/'), indexRes as unknown as ServerResponse);
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.headers['cache-control']).toBe('no-store');
    expect(indexRes.body).toContain('__VANGUARD_HUB__');
  });

  test('T-69 a traversal-style request is refused, not resolved outside uiDir', async () => {
    await writeFile(join(uiDir, 'index.html'), '<html><head></head><body></body></html>');
    const secretDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-secret-'));
    await writeFile(join(secretDir, 'passwd'), 'root:x:0:0');

    const res = new FakeRes();
    const handled = await serveStatic({ uiDir }, fakeReq('/../../etc/passwd'), res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'not found', kind: 'bad-request' } });

    await rm(secretDir, { recursive: true, force: true });
  });

  test('T-70 a non-GET/HEAD request is not handled here (left for the caller)', async () => {
    const res = new FakeRes();
    const handled = await serveStatic({ uiDir }, fakeReq('/', 'POST'), res as unknown as ServerResponse);
    expect(handled).toBe(false);
    expect(res.ended).toBe(false);
  });

  test('T-70 a missing hashed asset 404s with the same JSON shape', async () => {
    await writeFile(join(uiDir, 'index.html'), '<html><head></head><body></body></html>');
    const res = new FakeRes();
    const handled = await serveStatic({ uiDir }, fakeReq('/assets/missing-abc.js'), res as unknown as ServerResponse);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'not found', kind: 'bad-request' } });
  });
});
