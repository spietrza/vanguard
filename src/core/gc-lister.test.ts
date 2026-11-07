import { describe, it, expect, vi } from 'vitest';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));

const { dockerEgressNetworkLister, gitRemoteBranchLister, gitRemoteBranchRemover } = await import('./gc.js');

describe('gitRemoteBranchLister', () => {
  it('takes tips from ls-remote: a moved branch reads as fresh, a deleted one is dropped', async () => {
    const now = 1_000_000_000_000;
    const old = String(Math.floor(now / 1000) - 3600);
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return { stdout: [`origin/vanguard-a\t${old}\taaa`, `origin/vanguard-b\t${old}\tstale`, `origin/vanguard-gone\t${old}\tggg`].join('\n') };
      }
      return { exitCode: 0, stdout: 'aaa\trefs/heads/vanguard-a\nbbb\trefs/heads/vanguard-b' };
    });
    const branches = await gitRemoteBranchLister('/r', { prefix: 'vanguard-', now: () => now })();
    expect(branches).toEqual([
      { name: 'vanguard-a', ageMs: 3_600_000, sha: 'aaa' },
      { name: 'vanguard-b', ageMs: 0, sha: 'bbb' },
    ]);
  });

  it('keeps everything when ls-remote fails', async () => {
    execa.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === 'for-each-ref' ? { stdout: 'origin/vanguard-a\t1\taaa' } : { exitCode: 128, stdout: '' });
    expect(await gitRemoteBranchLister('/r', { prefix: 'vanguard-' })()).toEqual([]);
  });
});

describe('gitRemoteBranchRemover', () => {
  it('deletes with a lease on the checked tip', async () => {
    execa.mockReset();
    execa.mockResolvedValue({ exitCode: 0, stdout: '' });
    await gitRemoteBranchRemover('/r')('vanguard-a', 'aaa');
    expect(execa).toHaveBeenCalledWith('git', ['push', '--force-with-lease=refs/heads/vanguard-a:aaa', 'origin', ':refs/heads/vanguard-a'], { cwd: '/r', reject: false });
  });
});

describe('dockerEgressNetworkLister', () => {
  it('skips a network removed between ls and inspect, and warns only about unparseable output', async () => {
    const now = 1_000_000_000_000;
    const old = String(Math.floor(now / 1000) - 3600);
    execa.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === 'ls') return { stdout: 'vg-egr-gone\nvg-egr-legacy\nvg-egr-stale\nvg-egr-weird' };
      const byName: Record<string, { stdout: string; stderr: string; exitCode: number }> = {
        'vg-egr-gone': { stdout: '', stderr: 'Error response from daemon: network vg-egr-gone not found', exitCode: 1 },
        'vg-egr-legacy': { stdout: '', stderr: 'Error: No such network: vg-egr-legacy', exitCode: 1 },
        'vg-egr-stale': { stdout: `0 ${old}`, stderr: '', exitCode: 0 },
        'vg-egr-weird': { stdout: 'template: bad', stderr: '', exitCode: 0 },
      };
      return byName[args[2] ?? ''];
    });
    const warnings: string[] = [];

    const stale = await dockerEgressNetworkLister(60_000, () => now, (line) => warnings.push(line))();

    expect(stale).toEqual(['vg-egr-stale']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('vg-egr-weird');
    expect(warnings[0]).not.toContain('vg-egr-gone');
    expect(warnings[0]).not.toContain('vg-egr-legacy');
  });
});
