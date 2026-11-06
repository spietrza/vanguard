import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd, sessionPath, captureSession, restoreSession, isSafeSessionId, hostSessionFile } from './session-store.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

describe('encodeCwd', () => {
  it('encodes cwd like the Agent SDK (non-alphanumeric -> -)', () => {
    expect(encodeCwd('/workspace')).toBe('-workspace');
    expect(encodeCwd('/Users/me/proj')).toBe('-Users-me-proj');
  });
});

describe('sessionPath', () => {
  it('builds the jsonl path under <home>/.claude/projects, honouring HOME', () => {
    expect(sessionPath('/root', '/workspace', 'abc')).toBe('/root/.claude/projects/-workspace/abc.jsonl');
    expect(sessionPath('/home/agent', '/workspace', 'abc')).toBe('/home/agent/.claude/projects/-workspace/abc.jsonl');
  });
});

describe('captureSession / restoreSession', () => {
  it('copies the jsonl out to the host dir', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyFileOut: async (s: string, h: string): Promise<void> => {
        calls.push([s, h]);
      },
    } as unknown as IsolatedSandboxProvider;
    const dest = await captureSession(sandbox, { home: '/home/agent', cwd: '/workspace', sessionId: 'sid', hostDir: '/host/sessions' });
    expect(dest).toBe('/host/sessions/sid.jsonl');
    expect(calls).toEqual([['/home/agent/.claude/projects/-workspace/sid.jsonl', '/host/sessions/sid.jsonl']]);
  });

  it('copies a captured jsonl back into the sandbox', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await restoreSession(sandbox, { home: '/root', cwd: '/workspace', sessionId: 'sid', hostFile: '/host/sessions/sid.jsonl' });
    expect(calls).toEqual([['/host/sessions/sid.jsonl', '/root/.claude/projects/-workspace/sid.jsonl']]);
  });
});

describe('session id validation', () => {
  const forged = ['../../runs/metrics', '/etc/passwd', '..', 'a/b', 'a\\b', '.hidden', '-flag', '', 'x'.repeat(129)];

  it('accepts real Claude Code ids and plain tokens', () => {
    expect(isSafeSessionId('9b5b760d-5016-4e23-ab06-e3d2968346a6')).toBe(true);
    expect(isSafeSessionId('sess-1')).toBe(true);
  });

  it.each(forged)('rejects %j', (id) => {
    expect(isSafeSessionId(id)).toBe(false);
    expect(() => sessionPath('/root', '/workspace', id)).toThrow(/unsafe session id/);
    expect(() => hostSessionFile('/host/sessions', id)).toThrow(/unsafe session id/);
  });

  it('never copies out for a traversal or absolute id', async () => {
    const calls: string[] = [];
    const sandbox = {
      copyFileOut: async (_s: string, h: string): Promise<void> => {
        calls.push(h);
      },
      copyIn: async (h: string): Promise<void> => {
        calls.push(h);
      },
    } as unknown as IsolatedSandboxProvider;
    for (const sessionId of ['../../runs/metrics', '/tmp/host-other/history']) {
      await expect(captureSession(sandbox, { home: '/root', cwd: '/workspace', sessionId, hostDir: '/host/sessions' })).rejects.toThrow();
      await expect(
        restoreSession(sandbox, { home: '/root', cwd: '/workspace', sessionId, hostFile: '/host/sessions/x.jsonl' }),
      ).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('refuses a symlink at the capture destination and at the restore source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-sess-'));
    try {
      const victim = join(dir, 'victim.jsonl');
      await writeFile(victim, 'operator data\n');
      await symlink(victim, join(dir, 'sid.jsonl'));
      const calls: string[] = [];
      const sandbox = {
        copyFileOut: async (_s: string, h: string): Promise<void> => {
          calls.push(h);
        },
        copyIn: async (h: string): Promise<void> => {
          calls.push(h);
        },
      } as unknown as IsolatedSandboxProvider;
      await expect(captureSession(sandbox, { home: '/root', cwd: '/workspace', sessionId: 'sid', hostDir: dir })).rejects.toThrow(/symlink/);
      await expect(
        restoreSession(sandbox, { home: '/root', cwd: '/workspace', sessionId: 'sid', hostFile: join(dir, 'sid.jsonl') }),
      ).rejects.toThrow(/regular file/);
      expect(calls).toEqual([]);
      expect(await readFile(victim, 'utf8')).toBe('operator data\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
