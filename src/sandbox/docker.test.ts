import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execa, execaSync } from 'execa';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandboxProvider, toExecResult, isOlderVersion, refreshSandboxClaudeCli, sandboxImage, SANDBOX_CLAUDE_VERSION } from './docker.js';
import { sandboxSecurityOpts } from './limits.js';

const ENV_VAR = 'VANGUARD_SANDBOX_IMAGE';

// Ungated on purpose: pure env resolution, no Docker needed. Every sandbox start and sidecar reads
// this — a wrong verdict either strands CI on the mutable `:latest` tag it was meant to pin past, or
// silently drops a deliberate override.
describe('sandboxImage', () => {
  const prev = process.env[ENV_VAR];
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  });

  it('honours VANGUARD_SANDBOX_IMAGE when set', () => {
    process.env[ENV_VAR] = 'sha256:deadbeef';
    expect(sandboxImage()).toBe('sha256:deadbeef');
  });

  it('falls back to the mutable tag when the env var is empty', () => {
    process.env[ENV_VAR] = '';
    expect(sandboxImage()).toBe('vanguard-sandbox:latest');
  });

  it('falls back to the mutable tag when the env var is unset', () => {
    delete process.env[ENV_VAR];
    expect(sandboxImage()).toBe('vanguard-sandbox:latest');
  });

  it('rejects a value docker would read as a flag, or one with whitespace', () => {
    for (const value of ['--privileged', '-v/:/host', 'vanguard-sandbox:latest --privileged']) {
      expect(() => sandboxImage({ [ENV_VAR]: value }), value).toThrow(/not an image reference/);
    }
  });

  it('reads from an injected env map rather than process.env when given one', () => {
    expect(sandboxImage({ [ENV_VAR]: 'sha256:cafef00d' })).toBe('sha256:cafef00d');
    expect(sandboxImage({})).toBe('vanguard-sandbox:latest');
  });
});

const hasDocker = ((): boolean => {
  try {
    execaSync('docker', ['version']);
    return true;
  } catch {
    return false;
  }
})();

const suite = hasDocker ? describe : describe.skip;

// Ungated on purpose: the comparison is pure, and it gates every sandbox start — a wrong verdict
// either blocks a healthy image or lets a stale CLI fail deep inside a run (see assertClaudeCliCurrent).
describe('refreshSandboxClaudeCli', () => {
  it('refuses an immutable image ID instead of committing to a stray sha256 repository', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: '' };
    };

    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: `sha256:${'a'.repeat(64)}`, run })).rejects.toThrow(/immutable/);
    await expect(
      refreshSandboxClaudeCli({ cwd: '/repo', image: `registry.example.com/vanguard-sandbox@sha256:${'b'.repeat(64)}`, run }),
    ).rejects.toThrow(/immutable/);
    expect(calls).toEqual([]);
  });

  it('refuses a short image ID, and still refreshes a hex repository name that is not an ID prefix', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: args.at(-1) === '{{.Id}}' ? `sha256:abc1234${'0'.repeat(57)}` : '' };
    };

    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: 'abc1234', run })).rejects.toThrow(/immutable/);
    await expect(refreshSandboxClaudeCli({ cwd: '/repo', image: 'sha256:abc1', run })).rejects.toThrow(/immutable/);
    expect(calls.some((args) => args[0] === 'commit')).toBe(false);

    await refreshSandboxClaudeCli({ cwd: '/repo', image: 'cafe', run });
    expect(calls.some((args) => args[0] === 'commit' && args.at(-1) === 'cafe')).toBe(true);
  });
});

describe('isOlderVersion', () => {
  it('orders released CLI versions numerically, not lexically', () => {
    // '2.1.165' > '2.1.260' as strings; the whole check hinges on this not being a string compare.
    expect(isOlderVersion('2.1.165', '2.1.260')).toBe(true);
    expect(isOlderVersion('2.1.260', '2.1.260')).toBe(false);
    expect(isOlderVersion('2.1.261', '2.1.260')).toBe(false);
    expect(isOlderVersion('2.2.0', '2.1.260')).toBe(false);
    expect(isOlderVersion('1.99.99', '2.1.260')).toBe(true);
  });

  it('treats a missing part as zero and an unparseable one as older', () => {
    expect(isOlderVersion('2.1', '2.1.260')).toBe(true);
    expect(isOlderVersion('2.2', '2.1.260')).toBe(false);
    expect(isOlderVersion('nightly', SANDBOX_CLAUDE_VERSION)).toBe(true);
  });
});

// Ungated on purpose: the coercion is pure, and it guards the seam whose broken contract crashed a
// codex review run with a bare `undefined.split` (see toExecResult's comment).
describe('toExecResult', () => {
  it('substitutes empty strings when execa buffered nothing (cancelled or never-spawned subprocess)', () => {
    expect(toExecResult({ stdout: undefined, stderr: undefined, exitCode: undefined })).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
    });
  });

  it('passes real streams through untouched', () => {
    expect(toExecResult({ stdout: 'out', stderr: 'err', exitCode: 3 })).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });
  });

  it('keeps a zero exit code (a falsy-check here would report failure on success)', () => {
    expect(toExecResult({ stdout: '', stderr: '', exitCode: 0 }).exitCode).toBe(0);
  });

  it('yields a splittable stdout, which is what the consumer actually relies on', () => {
    expect(() => toExecResult({ stdout: undefined }).stdout.split('\n')).not.toThrow();
  });
});

suite('DockerSandboxProvider', () => {
  const sb = new DockerSandboxProvider({ image: 'alpine:3.20', workdir: '/workspace' });

  afterAll(async () => {
    await sb.destroy();
  }, 60_000);

  it('starts and runs a command', async () => {
    await sb.start();
    const r = await sb.exec('echo hi');
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('returns a non-zero exit code without throwing', async () => {
    const r = await sb.exec('exit 3');
    expect(r.exitCode).toBe(3);
  }, 30_000);

  it('round-trips a directory of files (contents, not nested)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-cp-'));
    await writeFile(join(host, 'a.txt'), 'alpha');
    await sb.copyIn(host, '/workspace/in');
    expect(await sb.exists('/workspace/in/a.txt')).toBe(true);
    const out = await mkdtemp(join(tmpdir(), 'vg-out-'));
    await sb.copyFileOut('/workspace/in', out);
    expect(await readFile(join(out, 'a.txt'), 'utf8')).toBe('alpha');
    await rm(host, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }, 60_000);

  it('makes copied-in files editable by the sandbox user (chown)', async () => {
    const host = await mkdtemp(join(tmpdir(), 'vg-edit-'));
    await writeFile(join(host, 'f.txt'), 'one');
    await sb.copyIn(host, '/workspace/edit');
    const r = await sb.exec('echo two >> /workspace/edit/f.txt && cat /workspace/edit/f.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('two');
    await rm(host, { recursive: true, force: true });
  }, 60_000);

  it('exposes secrets to commands but keeps them out of docker inspect (tmpfs default)', async () => {
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_SECRET: 'topsecret' } });
    try {
      await sec.start();
      const r = await sec.exec('echo $VG_SECRET');
      expect(r.stdout.trim()).toBe('topsecret');
      const inspect = await execa('docker', ['inspect', `vg-${sec.id}`, '--format', '{{json .Config.Env}}'], {
        reject: false,
      });
      expect(inspect.stdout).not.toContain('topsecret');
    } finally {
      await sec.destroy();
    }
  }, 120_000);

  it('keeps shell metacharacters in secret values literal (no injection)', async () => {
    const tricky = "a'b$(echo pwned);c`d`";
    const sec = new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { VG_TRICKY: tricky } });
    try {
      await sec.start();
      const r = await sec.exec('printf %s "$VG_TRICKY"');
      expect(r.stdout).toBe(tricky);
    } finally {
      await sec.destroy();
    }
  }, 120_000);
});

// Runs without Docker: exercises the pure argv builder directly.
describe('DockerSandboxProvider buildRunArgs (hardening flags)', () => {
  it('drops all capabilities and blocks privilege escalation by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--security-opt');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
  });

  it('maps host.docker.internal only for a sandbox pointed at the docker host', () => {
    const alias = 'host.docker.internal:host-gateway';
    // Default runs, and the egress enclave / llm-proxy (reached by container name), need no alias.
    expect(new DockerSandboxProvider({}).buildRunArgs()).not.toContain(alias);
    expect(
      new DockerSandboxProvider({
        network: 'vg-egr-1',
        env: { HTTPS_PROXY: 'http://vg-proxy-1:8080', ANTHROPIC_BASE_URL: 'http://vg-llm-1:8080' },
      }).buildRunArgs(),
    ).not.toContain(alias);

    // A host egress proxy (startEgressProxy) or a provider endpoint on the docker host does.
    const viaEnv = new DockerSandboxProvider({ env: { HTTPS_PROXY: 'http://host.docker.internal:3128' } }).buildRunArgs();
    expect(viaEnv[viaEnv.indexOf(alias) - 1]).toBe('--add-host');
    expect(
      new DockerSandboxProvider({ secrets: { ANTHROPIC_BASE_URL: 'http://Host.Docker.Internal:3000' } }).buildRunArgs(),
    ).toContain(alias);

    // An explicit setting wins either way.
    expect(new DockerSandboxProvider({ hostGateway: true }).buildRunArgs()).toContain(alias);
    expect(
      new DockerSandboxProvider({ hostGateway: false, env: { HTTPS_PROXY: 'http://host.docker.internal:3128' } }).buildRunArgs(),
    ).not.toContain(alias);
  });

  it('adds back the chown trio needed by copyIn, after the drop', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    const dropIdx = args.indexOf('--cap-drop');
    for (const cap of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']) {
      const capIdx = args.indexOf(cap);
      expect(capIdx).toBeGreaterThan(-1);
      expect(args[capIdx - 1]).toBe('--cap-add');
      expect(capIdx).toBeGreaterThan(dropIdx);
    }
  });

  it('coexists with resource limits, network, secrets tmpfs, and the terminal image/command', () => {
    const sb = new DockerSandboxProvider({
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 128,
      network: 'vg-net',
      secrets: { FOO: 'bar' },
      security: sandboxSecurityOpts({}),
    });
    const args = sb.buildRunArgs();
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--network');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('--security-opt');
    expect(args.filter((a) => a === '--tmpfs').length).toBeGreaterThanOrEqual(1);
    expect(args.slice(-3)).toEqual(['vanguard-sandbox:latest', 'sleep', 'infinity']);
  });

  it('defaults to VANGUARD_SANDBOX_IMAGE over the mutable tag when no explicit image is given', () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const sb = new DockerSandboxProvider({});
      expect(sb.buildRunArgs().slice(-3)).toEqual(['sha256:deadbeef', 'sleep', 'infinity']);
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('an explicit config.image still wins over VANGUARD_SANDBOX_IMAGE', () => {
    const prev = process.env[ENV_VAR];
    process.env[ENV_VAR] = 'sha256:deadbeef';
    try {
      const sb = new DockerSandboxProvider({ image: 'alpine:3.20' });
      expect(sb.buildRunArgs().slice(-3)).toEqual(['alpine:3.20', 'sleep', 'infinity']);
    } finally {
      if (prev === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prev;
    }
  });

  it('config.security override disables hardening', () => {
    const sb = new DockerSandboxProvider({
      security: { capDrop: [], capAdd: [], noNewPrivileges: false, readOnlyRootfs: false },
    });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--cap-drop');
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('--security-opt');
    expect(args).not.toContain('--read-only');
  });

  it('config.security override can customize the added-back caps', () => {
    const sb = new DockerSandboxProvider({ security: { capAdd: ['NET_BIND_SERVICE'] } });
    const args = sb.buildRunArgs();
    expect(args).toContain('NET_BIND_SERVICE');
    expect(args).not.toContain('CHOWN');
  });

  it('stretch: readOnlyRootfs adds --read-only and writable tmpfs for workspace/$HOME/tmp', () => {
    const sb = new DockerSandboxProvider({ security: { ...sandboxSecurityOpts({}), readOnlyRootfs: true } });
    const args = sb.buildRunArgs();
    expect(args).toContain('--read-only');
    const tmpfsArgs = args.filter((_, i) => args[i - 1] === '--tmpfs');
    expect(tmpfsArgs.some((a) => a.startsWith('/workspace:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/home/agent:'))).toBe(true);
    expect(tmpfsArgs.some((a) => a.startsWith('/tmp:'))).toBe(true);
  });

  it('stretch: readOnlyRootfs is off by default', () => {
    const sb = new DockerSandboxProvider({ security: sandboxSecurityOpts({}) });
    const args = sb.buildRunArgs();
    expect(args).not.toContain('--read-only');
  });

  it('has no vanguard.owner label by default', () => {
    const sb = new DockerSandboxProvider({});
    expect(sb.buildRunArgs()).not.toContain('vanguard.owner=');
  });

  it('adds the vanguard.owner label when VANGUARD_OWNER_LABEL is set', () => {
    const prev = process.env.VANGUARD_OWNER_LABEL;
    process.env.VANGUARD_OWNER_LABEL = 'ci-job-42';
    try {
      const sb = new DockerSandboxProvider({});
      const args = sb.buildRunArgs();
      expect(args).toContain('vanguard.owner=ci-job-42');
    } finally {
      if (prev === undefined) delete process.env.VANGUARD_OWNER_LABEL;
      else process.env.VANGUARD_OWNER_LABEL = prev;
    }
  });
});

// Runs without Docker: the validation throws in the constructor, before any docker invocation.
describe('DockerSandboxProvider secret validation', () => {
  it('rejects a secret value containing a newline', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { BAD: 'a\nb' } })).toThrow(/newline/);
  });

  it('rejects an invalid secret name', () => {
    expect(() => new DockerSandboxProvider({ image: 'alpine:3.20', secrets: { 'bad name': 'x' } })).toThrow(
      /Invalid secret name/,
    );
  });

  it('builds an interactive shell command', () => {
    const sb = new DockerSandboxProvider({ image: 'alpine:3.20' });
    expect(sb.shellCommand()).toMatch(/^docker exec -it vg-.* bash$/);
  });
});

describe('toExecResult on a real execa 10 result (reject: false)', () => {
  it('normalises a failed subprocess result exactly as it did under execa 9', async () => {
    const raw = await execa('node', ['-e', 'process.stderr.write("boom"); process.exit(7)'], { reject: false });
    expect(toExecResult(raw)).toEqual({ stdout: '', stderr: 'boom', exitCode: 7 });
  });
});
