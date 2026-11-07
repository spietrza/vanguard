import { test, expect } from 'vitest';
import { startEgressEnclave } from './egress-network.js';
import type { DockerRunner } from './llm-proxy.js';

const ok = { exitCode: 0, stdout: '', stderr: '' };

function recordingDocker(failOn?: string): { calls: string[][]; docker: DockerRunner } {
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (failOn !== undefined && args[0] === failOn) return { exitCode: 1, stdout: '', stderr: 'boom' };
    return ok;
  };
  return { calls, docker };
}

test('the proxy runs as PID 1 under a restart policy — not an exec into a sleep container (dogfood #352)', async () => {
  const { calls, docker } = recordingDocker();
  const enclave = await startEgressEnclave({ allowlist: ['a.example'], docker });
  const create = calls.find((c) => c[0] === 'create');
  expect(create).toBeDefined();
  // Supervision: a proxy death must surface in docker logs and be revived, not leave a port-closed
  // "Up" container that bricks every remaining stage with ConnectionRefused.
  expect(create).toContain('--restart');
  expect(create![create!.indexOf('--restart') + 1]).toMatch(/^on-failure/);
  expect(create!.slice(-2)).toEqual(['node', '/tmp/egress-proxy.mjs']);
  expect(create!.join(' ')).not.toContain('sleep');
  // Env is baked at create time (exec -e no longer exists to carry it).
  expect(create!.join(' ')).toContain('ALLOW=a.example');
  expect(create!.join(' ')).toContain('PORT=8080');
  // The script is cp'd in BEFORE start — node is PID 1, so starting first would crash-loop on a
  // missing file.
  const order = calls.map((c) => c[0]);
  expect(order.indexOf('start')).toBeGreaterThan(order.lastIndexOf('cp'));
  expect(order).not.toContain('exec');
  expect(enclave.proxyUrl).toMatch(/^http:\/\/vg-proxy-[0-9a-f]{8}:8080$/);
  await enclave.destroy();
  expect(calls.filter((c) => c[0] === 'rm' || c[1] === 'rm').length).toBeGreaterThan(0);
});

test('the proxy sidecar runs on VANGUARD_SANDBOX_IMAGE when set — it is the sandbox image, not a dedicated proxy image', async () => {
  const ENV_VAR = 'VANGUARD_SANDBOX_IMAGE';
  const prev = process.env[ENV_VAR];
  process.env[ENV_VAR] = 'sha256:deadbeef';
  try {
    const { calls, docker } = recordingDocker();
    await startEgressEnclave({ allowlist: ['a.example'], docker });
    const create = calls.find((c) => c[0] === 'create');
    expect(create!.slice(-3)).toEqual(['sha256:deadbeef', 'node', '/tmp/egress-proxy.mjs']);
  } finally {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  }
});

test('adds the vanguard.owner label to both the network and the proxy container when VANGUARD_OWNER_LABEL is set', async () => {
  const prev = process.env.VANGUARD_OWNER_LABEL;
  process.env.VANGUARD_OWNER_LABEL = 'ci-job-42';
  try {
    const { calls, docker } = recordingDocker();
    await startEgressEnclave({ allowlist: ['a.example'], docker });
    const networkCreate = calls.find((c) => c[0] === 'network' && c[1] === 'create');
    const proxyCreate = calls.find((c) => c[0] === 'create');
    expect(networkCreate).toContain('vanguard.owner=ci-job-42');
    expect(proxyCreate).toContain('vanguard.owner=ci-job-42');
  } finally {
    if (prev === undefined) delete process.env.VANGUARD_OWNER_LABEL;
    else process.env.VANGUARD_OWNER_LABEL = prev;
  }
});

test('has no vanguard.owner label by default', async () => {
  const { calls, docker } = recordingDocker();
  await startEgressEnclave({ allowlist: ['a.example'], docker });
  expect(calls.flat().join(' ')).not.toContain('vanguard.owner=');
});

test('a failed docker step tears the enclave down and throws SandboxError', async () => {
  const { calls, docker } = recordingDocker('cp');
  await expect(startEgressEnclave({ docker })).rejects.toThrow(/egress enclave/);
  // Teardown ran: the half-built container and network are removed.
  expect(calls.some((c) => c[0] === 'rm' && c[1] === '-f')).toBe(true);
  expect(calls.some((c) => c[0] === 'network' && c[1] === 'rm')).toBe(true);
});

test('trusted custom hosts reach the proxy as TRUSTED; none by default', async () => {
  const withTrusted = recordingDocker();
  await startEgressEnclave({ allowlist: ['a.example', 'lan.example'], trusted: ['lan.example'], docker: withTrusted.docker });
  expect(withTrusted.calls.find((c) => c[0] === 'create')).toContain('TRUSTED=lan.example');
  const plain = recordingDocker();
  await startEgressEnclave({ allowlist: ['a.example'], docker: plain.docker });
  expect(plain.calls.find((c) => c[0] === 'create')!.join(' ')).not.toContain('TRUSTED=');
});
