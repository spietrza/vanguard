import { describe, it, expect } from 'vitest';
import { isStaleEmptyNetwork, prsProveFinished, reapContainers, reapEgressNetworks, reapRemoteBranches } from './gc.js';
import type { ContainerInfo, RemoteBranchInfo } from './gc.js';

describe('prsProveFinished', () => {
  it('needs a PR in the state whose head commit is the current branch tip', () => {
    expect(prsProveFinished([{ state: 'CLOSED', headRefOid: 'tip' }], 'CLOSED', 'tip')).toBe(true);
    expect(prsProveFinished([{ state: 'MERGED', headRefOid: 'tip' }], 'MERGED', 'tip')).toBe(true);
  });

  it('keeps a live branch that only shares its head name with a closed PR (different tip)', () => {
    expect(prsProveFinished([{ state: 'CLOSED', headRefOid: 'old' }], 'CLOSED', 'new')).toBe(false);
  });

  it('keeps the branch while any OPEN PR uses that head name', () => {
    expect(prsProveFinished([{ state: 'CLOSED', headRefOid: 'tip' }, { state: 'OPEN', headRefOid: 'other' }], 'CLOSED', 'tip')).toBe(false);
  });

  it('keeps the branch when the tip is unknown or the state differs', () => {
    expect(prsProveFinished([{ state: 'CLOSED', headRefOid: 'tip' }], 'CLOSED', undefined)).toBe(false);
    expect(prsProveFinished([{ state: 'MERGED', headRefOid: 'tip' }], 'CLOSED', 'tip')).toBe(false);
    expect(prsProveFinished([], 'MERGED', 'tip')).toBe(false);
  });
});

describe('reapContainers', () => {
  it('removes only containers older than maxAge', async () => {
    const containers: ContainerInfo[] = [
      { id: 'old', ageMs: 10_000 },
      { id: 'fresh', ageMs: 100 },
    ];
    const removed: string[] = [];
    const result = await reapContainers(
      async () => containers,
      async (id) => {
        removed.push(id);
      },
      1_000,
    );
    expect(result).toEqual(['old']);
    expect(removed).toEqual(['old']);
  });

  it('removes nothing when all containers are fresh', async () => {
    const result = await reapContainers(
      async () => [{ id: 'a', ageMs: 5 }],
      async () => {},
      1_000,
    );
    expect(result).toEqual([]);
  });
});

describe('reapEgressNetworks', () => {
  it('removes all listed orphaned networks', async () => {
    const removed: string[] = [];
    const result = await reapEgressNetworks(
      async () => ['vg-egr-abc123', 'vg-egr-def456'],
      async (name) => {
        removed.push(name);
      },
    );
    expect(result).toEqual(['vg-egr-abc123', 'vg-egr-def456']);
    expect(removed).toEqual(['vg-egr-abc123', 'vg-egr-def456']);
  });

  it('returns empty array when no orphaned networks', async () => {
    const result = await reapEgressNetworks(async () => [], async () => {});
    expect(result).toEqual([]);
  });
});

describe('isStaleEmptyNetwork', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const hour = 60 * 60 * 1000;

  const unix = (iso: string): string => String(Date.parse(iso) / 1000);

  it('reaps an empty network older than the threshold', () => {
    expect(isStaleEmptyNetwork(`0 ${unix('2026-09-25T06:59:59Z')}\n`, 4 * hour, now)).toBe(true);
  });

  it('keeps an empty network younger than the threshold, so a concurrent job can still attach to it', () => {
    expect(isStaleEmptyNetwork(`0 ${unix('2026-09-25T11:59:58Z')}`, 4 * hour, now)).toBe(false);
  });

  it('keeps a network with containers attached', () => {
    expect(isStaleEmptyNetwork(`2 ${unix('2026-09-20T00:00:00Z')}`, 4 * hour, now)).toBe(false);
  });

  it('keeps a network whose creation time cannot be read, including the Go-rendered {{.Created}} string', () => {
    expect(isStaleEmptyNetwork('0', 0, now)).toBe(false);
    expect(isStaleEmptyNetwork('0 not-a-date', 0, now)).toBe(false);
    expect(isStaleEmptyNetwork('0 2026-09-25 06:59:59.123456789 +0000 UTC', 0, now)).toBe(false);
  });
});

describe('reapRemoteBranches', () => {
  it('removes only aged branches whose PR was merged', async () => {
    const branches: RemoteBranchInfo[] = [
      { name: 'vanguard/old-merged', ageMs: 10_000 },
      { name: 'vanguard/old-unmerged', ageMs: 10_000 },
      { name: 'vanguard/fresh', ageMs: 100 },
    ];
    const removed: string[] = [];
    const result = await reapRemoteBranches(
      async () => branches,
      async (name) => name === 'vanguard/old-merged',
      async (name) => {
        removed.push(name);
      },
      1_000,
    );
    expect(result).toEqual(['vanguard/old-merged']);
    expect(removed).toEqual(['vanguard/old-merged']);
  });

  it('does not check the merge state of fresh branches', async () => {
    const checked: string[] = [];
    const result = await reapRemoteBranches(
      async () => [{ name: 'vanguard/fresh', ageMs: 5 }],
      async (name) => {
        checked.push(name);
        return true;
      },
      async () => {},
      1_000,
    );
    expect(result).toEqual([]);
    expect(checked).toEqual([]);
  });

  describe('abandoned mode', () => {
    it('reaps aged branches with a closed-unmerged PR when abandoned=true', async () => {
      const branches: RemoteBranchInfo[] = [
        { name: 'vanguard/old-abandoned', ageMs: 10_000 },
        { name: 'vanguard/old-open', ageMs: 10_000 },
      ];
      const removed: string[] = [];
      const result = await reapRemoteBranches(
        async () => branches,
        async () => false,
        async (name) => { removed.push(name); },
        1_000,
        { abandoned: true, isAbandoned: async (name) => name === 'vanguard/old-abandoned' },
      );
      expect(result).toEqual(['vanguard/old-abandoned']);
      expect(removed).toEqual(['vanguard/old-abandoned']);
    });

    it('does not reap fresh branches even when abandoned=true', async () => {
      const checked: string[] = [];
      const result = await reapRemoteBranches(
        async () => [{ name: 'vanguard/fresh-abandoned', ageMs: 5 }],
        async () => false,
        async () => {},
        1_000,
        { abandoned: true, isAbandoned: async (name) => { checked.push(name); return true; } },
      );
      expect(result).toEqual([]);
      expect(checked).toEqual([]);
    });

    it('reaps both merged and abandoned aged branches when abandoned=true', async () => {
      const branches: RemoteBranchInfo[] = [
        { name: 'vanguard/merged', ageMs: 10_000 },
        { name: 'vanguard/abandoned', ageMs: 10_000 },
        { name: 'vanguard/open', ageMs: 10_000 },
      ];
      const result = await reapRemoteBranches(
        async () => branches,
        async (name) => name === 'vanguard/merged',
        async () => {},
        1_000,
        { abandoned: true, isAbandoned: async (name) => name === 'vanguard/abandoned' },
      );
      expect(result).toEqual(['vanguard/merged', 'vanguard/abandoned']);
    });

    it('hands each checker the branch tip so a PR is matched by head commit, not by name alone', async () => {
      const seen: Array<[string, string | undefined]> = [];
      await reapRemoteBranches(
        async () => [{ name: 'vanguard/x', ageMs: 10_000, sha: 'tip1' }],
        async (name, sha) => { seen.push([name, sha]); return false; },
        async () => {},
        1_000,
        { abandoned: true, isAbandoned: async (name, sha) => { seen.push([name, sha]); return false; } },
      );
      expect(seen).toEqual([['vanguard/x', 'tip1'], ['vanguard/x', 'tip1']]);
    });

    it('does not reap closed-unmerged branches when abandoned flag is absent', async () => {
      const result = await reapRemoteBranches(
        async () => [{ name: 'vanguard/abandoned', ageMs: 10_000 }],
        async () => false,
        async () => {},
        1_000,
      );
      expect(result).toEqual([]);
    });
  });
});
