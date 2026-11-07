import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import {
  watchOnce,
  specOnce,
  runLoopV1,
  linearWatchPrimitives,
  githubProjectWatchPrimitives,
  githubSpecPrimitives,
  githubIssueWatchPrimitives,
  gitlabWatchPrimitives,
} from './watch.js';
import { runGithubIssue } from './github.js';
import { runGitlabIssue } from './gitlab.js';
import { runLinearIssue } from './linear.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL, GITHUB_SECRET_BLOCKED_LABEL } from '../github-labels.js';
import type { SpecWatchPrimitives, WatchPrimitives, WatchGitlabOptions } from './watch.js';
import type { RunGithubIssueResult } from './github.js';
import type { RunGitlabIssueResult } from './gitlab.js';
import type { RunLinearIssueResult } from './linear.js';
import { GitHubTaskFetcher } from '../tasks/github.js';
import type { GhRunner } from '../tasks/github.js';
import type { TaskFetcher } from '../tasks/fetcher.js';
import type { LinearCliRunner } from '../tasks/linear-cli.js';

describe('watchOnce', () => {
  it('claims, runs, reviews each ready issue and categorizes the outcomes', async () => {
    const calls: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        calls.push(`claim:${id}`);
        if (id === 'D') throw new Error('already taken');
      },
      runOne: async (id) => {
        calls.push(`run:${id}`);
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? {} : { prUrl: `pr/${id}` };
      },
      review: async (id) => {
        calls.push(`review:${id}`);
      },
      onNoChange: async (id) => {
        calls.push(`nochange:${id}`);
      },
      onFailure: async (id) => {
        calls.push(`fail:${id}`);
      },
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['A']);
    expect(tick.noChange).toEqual(['B']);
    expect(tick.failed).toEqual(['C']);
    expect(tick.skipped).toEqual(['D']); // claim threw -> never run
    expect(calls).not.toContain('run:D');
    expect(calls.indexOf('claim:A')).toBeLessThan(calls.indexOf('run:A')); // claim precedes run
    expect(calls).toContain('review:A');
    expect(calls).not.toContain('review:B'); // no PR -> no review
    expect(calls).toEqual(expect.arrayContaining(['nochange:B']));
    expect(calls).not.toContain('nochange:A');
    expect(calls).not.toContain('nochange:C');
    expect(calls).toContain('fail:C');
  });

  it('holds a secret-blocked run for a human: onSecretBlocked instead of onNoChange, counted apart from no-change', async () => {
    const calls: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async (id) => {
        calls.push(`claim:${id}`);
      },
      // A: the secret scan withheld the PR (no prUrl). B: genuine empty diff.
      runOne: async (id) => (id === 'A' ? { secretBlocked: true } : {}),
      review: async (id) => {
        calls.push(`review:${id}`);
      },
      onNoChange: async (id) => {
        calls.push(`nochange:${id}`);
      },
      onSecretBlocked: async (id) => {
        calls.push(`secret:${id}`);
      },
      onFailure: async (id) => {
        calls.push(`fail:${id}`);
      },
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(tick.secretBlocked).toEqual(['A']);
    expect(tick.noChange).toEqual(['B']);
    expect(tick.opened).toEqual([]);
    expect(tick.failed).toEqual([]);
    expect(calls).toContain('secret:A');
    expect(calls).not.toContain('nochange:A'); // the claim is never reverted to the trigger
    expect(calls).not.toContain('review:A');
    expect(calls).toContain('nochange:B');
    expect(calls).not.toContain('secret:B');
  });

  it('a secret-blocked run without an onSecretBlocked primitive still skips onNoChange (claim stays)', async () => {
    const onNoChange = vi.fn(async () => {});
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runOne: async () => ({ secretBlocked: true }),
      review: async () => {},
      onNoChange,
      onFailure: async () => {},
    };

    const tick = await watchOnce(primitives);

    expect(tick.secretBlocked).toEqual(['A']);
    expect(tick.noChange).toEqual([]);
    expect(onNoChange).not.toHaveBeenCalled();
  });

  it('the per-source runners keep secretBlocked in their result type so the watch loop can see it', () => {
    // runSourcedIssue returns { task, secretBlocked: true } on a withheld PR; a narrowed wrapper
    // type would let watchOnce read that as "no changes" and revert the claim.
    expectTypeOf<RunGithubIssueResult>().toHaveProperty('secretBlocked');
    expectTypeOf<RunGitlabIssueResult>().toHaveProperty('secretBlocked');
    expectTypeOf<RunLinearIssueResult>().toHaveProperty('secretBlocked');
    // ...and the real seams, so a re-narrowed signature on the function itself cannot slip through.
    expectTypeOf(runGithubIssue).returns.resolves.toHaveProperty('secretBlocked');
    expectTypeOf(runGitlabIssue).returns.resolves.toHaveProperty('secretBlocked');
    expectTypeOf(runLinearIssue).returns.resolves.toHaveProperty('secretBlocked');
  });

  it('a rejecting onSecretBlocked is reported as a failure and never reverts the claim', async () => {
    const onNoChange = vi.fn(async () => {});
    const onFailure = vi.fn(async () => {});
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runOne: async () => ({ secretBlocked: true }),
      review: async () => {},
      onNoChange,
      onSecretBlocked: async () => {
        throw new Error('label API down');
      },
      onFailure,
    };
    const logs: string[] = [];

    const tick = await watchOnce(primitives, { log: (msg) => logs.push(msg) });

    expect(tick.failed).toEqual(['A']);
    expect(tick.secretBlocked).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith('A', expect.any(Error));
    expect(onNoChange).not.toHaveBeenCalled(); // the claim is never reverted to the trigger
    expect(logs).toContain('watch A: secret blocked -> held for a human'); // logged before the edit, so the block is on record
  });

  it('does not call onNoChange when runOne reports the outcome is already parked', async () => {
    const calls: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runOne: async () => ({ parked: true }),
      review: async () => {
        calls.push('review');
      },
      onNoChange: async () => {
        calls.push('nochange');
      },
      onFailure: async () => {
        calls.push('fail');
      },
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(tick.noChange).toEqual(['A']);
    expect(calls).toEqual([]);
  });

  it('emits compact operator logs for each watch outcome', async () => {
    const logs: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        if (id === 'D') throw new Error('already claimed');
      },
      runOne: async (id) => {
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? {} : { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await watchOnce(primitives, { concurrency: 1, log: (msg) => logs.push(msg) });

    expect(logs).toEqual([
      'watch: poll -> 4 ready',
      'watch A: claim -> running',
      'watch A: pr opened -> review',
      'watch B: claim -> running',
      'watch B: no change -> idle',
      'watch C: claim -> running',
      'watch C: failed -> failure noted',
      'watch D: skipped -> already claimed',
    ]);
  });

  it('claims and processes only the first maxTasks ready items, leaving the rest untouched', async () => {
    const claimed: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      claim: async (id) => {
        claimed.push(id);
      },
      runOne: async (id) => ({ prUrl: `pr/${id}` }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    const tick = await watchOnce(primitives, { concurrency: 1, maxTasks: 2 });

    expect(claimed).toEqual(['A', 'B']);
    expect(tick.opened).toEqual(['A', 'B']);
  });

  it('does not count an item another runner already claimed against maxTasks', async () => {
    const attempted: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      claim: async (id) => {
        attempted.push(id);
        if (id === 'A') throw new Error('already claimed');
      },
      runOne: async (id) => ({ prUrl: `pr/${id}` }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    const tick = await watchOnce(primitives, { concurrency: 2, maxTasks: 2 });

    expect(attempted).toEqual(['A', 'B', 'C']);
    expect(tick.opened).toEqual(['B', 'C']);
    expect(tick.skipped).toEqual(['A']);
    expect(tick.deferred).toEqual(['D', 'E']);
  });

  it('never claims more than maxTasks when claims run concurrently', async () => {
    const claimed: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        claimed.push(id);
      },
      runOne: async (id) => ({ prUrl: `pr/${id}` }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    const tick = await watchOnce(primitives, { concurrency: 4, maxTasks: 1 });

    expect(claimed).toEqual(['A']);
    expect(tick.opened).toEqual(['A']);
  });

  it('processes every ready item when maxTasks is unset', async () => {
    const claimed: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      claim: async (id) => {
        claimed.push(id);
      },
      runOne: async (id) => ({ prUrl: `pr/${id}` }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(claimed).toEqual(['A', 'B', 'C']);
    expect(tick.opened).toEqual(['A', 'B', 'C']);
  });
});

describe('specOnce', () => {
  it('emits compact operator logs for each spec outcome', async () => {
    const logs: string[] = [];
    const primitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        if (id === 'D') throw new Error('already claimed');
      },
      runSpec: async (id) => {
        if (id === 'B') return 'needs_info';
        if (id === 'C') throw new Error('boom');
        return 'advanced';
      },
      onFailure: async () => {},
    };

    await specOnce(primitives, { concurrency: 1, log: (msg) => logs.push(msg) });

    expect(logs).toEqual([
      'spec: poll -> 4 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec B: claim -> triage',
      'spec B: needs info -> waiting human',
      'spec C: claim -> triage',
      'spec C: failed -> retry later (boom)',
      'spec D: skipped -> already claimed',
    ]);
  });

  it('claims and specs only the first maxTasks ready items', async () => {
    const claimed: string[] = [];
    const logs: string[] = [];
    const primitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      claim: async (id) => {
        claimed.push(id);
      },
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };

    const tick = await specOnce(primitives, { concurrency: 1, maxTasks: 1, log: (msg) => logs.push(msg) });

    expect(claimed).toEqual(['A']);
    expect(tick.advanced).toEqual(['A']);
    expect(logs[0]).toBe('spec: poll -> 3 ready (capped to 1 by --max-tasks)');
  });

  it('fills maxTasks past an item that fails to claim', async () => {
    const primitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      claim: async (id) => {
        if (id === 'A') throw new Error('already claimed');
      },
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };

    const tick = await specOnce(primitives, { concurrency: 1, maxTasks: 1 });

    expect(tick.advanced).toEqual(['B']);
    expect(tick.skipped).toEqual(['A']);
    expect(tick.deferred).toEqual(['C']);
  });
});

describe('runLoopV1', () => {
  // T4 — continuous mode: freshly-advanced ticket is deferred (human-intervention window preserved)
  it('defers freshly-advanced tickets in continuous mode', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async () => {},
      runOne: async () => ({ prUrl: 'pr/B' }),
      review: async () => {
        controller.abort();
      },
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(
      specPrimitives,
      agentPrimitives,
      { once: false, signal: controller.signal, intervalMs: 0, concurrency: 1 },
      (msg) => logs.push(msg),
    );

    expect(logs).toEqual([
      'spec: poll -> 1 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec: 1 advanced, 0 needs-info, 0 failed, 0 skipped.',
      'watch: poll -> 1 ready',
      'watch B: claim -> running',
      'watch B: pr opened -> review',
      'watch: 1 PR(s), 0 no-change, 0 failed, 0 skipped.',
    ]);
  });

  it('exits promptly when the signal is aborted during a continuous tick', async () => {
    const controller = new AbortController();
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runOne: async () => {
        controller.abort();
        return {};
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await expect(
      Promise.race([
        runLoopV1(specPrimitives, agentPrimitives, { signal: controller.signal, intervalMs: 60_000 }, () => {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loop did not stop after abort')), 100)),
      ]),
    ).resolves.toBeUndefined();
  });

  // T1 — once mode: just-advanced ticket is built even when listReady returns [] (index lag)
  it('once: true builds just-advanced ticket when listReady returns empty (simulates index lag)', async () => {
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true }, () => {});

    expect(builtIds).toEqual(['A']);
  });

  // T2 — once mode: no double-claim/run when the index also returns the just-advanced id
  it('once: true claims and builds each id exactly once when listReady also returns the advanced id', async () => {
    const claimed: string[] = [];
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async (id) => {
        claimed.push(id);
      },
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, concurrency: 1 }, () => {});

    expect(claimed).toEqual(['A', 'B']);
    expect(builtIds).toEqual(['A', 'B']);
  });

  it('the watch summary line counts secret-blocked runs, and omits the suffix on a clean tick', async () => {
    const logs: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async () => {},
      runOne: async (id) => (id === 'A' ? { secretBlocked: true } : { prUrl: 'pr/B' }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, concurrency: 1 }, (msg) => logs.push(msg));

    expect(logs).toContain('watch A: secret blocked -> held for a human');
    expect(logs).toContain('watch: 1 PR(s), 0 no-change, 0 failed, 0 skipped, 1 secret-blocked.');

    logs.length = 0;
    await runLoopV1(
      specPrimitives,
      { ...agentPrimitives, runOne: async (id) => ({ prUrl: `pr/${id}` }) },
      { once: true, concurrency: 1 },
      (msg) => logs.push(msg),
    );
    expect(logs).toContain('watch: 2 PR(s), 0 no-change, 0 failed, 0 skipped.');
  });

  // T3 — once mode: needs-info tickets are NOT carried into the agent pass
  it('once: true does not build tickets the spec pass moved to needs-info', async () => {
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'needs_info',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true }, () => {});

    expect(builtIds).toEqual([]);
  });

  // T5 — once mode: operator log ordering includes the carried advanced id
  it('once: true emits spec logs then agent logs including the carried advanced id', async () => {
    const logs: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'B' }],
      claim: async () => {},
      runOne: async () => ({ prUrl: 'pr/x' }),
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, concurrency: 1 }, (msg) => logs.push(msg));

    expect(logs).toEqual([
      'spec: poll -> 1 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec: 1 advanced, 0 needs-info, 0 failed, 0 skipped.',
      'watch: poll -> 2 ready',
      'watch A: claim -> running',
      'watch A: pr opened -> review',
      'watch B: claim -> running',
      'watch B: pr opened -> review',
      'watch: 2 PR(s), 0 no-change, 0 failed, 0 skipped.',
    ]);
  });

  function untouchedAgentPrimitives(): WatchPrimitives {
    return {
      listReady: vi.fn(async () => [{ id: 'B' }]),
      claim: vi.fn(async () => {}),
      runOne: vi.fn(async () => ({ prUrl: 'pr/x' })),
      review: vi.fn(async () => {}),
      onNoChange: vi.fn(async () => {}),
      onFailure: vi.fn(async () => {}),
    };
  }

  function expectAgentUntouched(agent: WatchPrimitives): void {
    expect(agent.listReady).not.toHaveBeenCalled();
    expect(agent.claim).not.toHaveBeenCalled();
    expect(agent.runOne).not.toHaveBeenCalled();
    expect(agent.review).not.toHaveBeenCalled();
    expect(agent.onNoChange).not.toHaveBeenCalled();
    expect(agent.onFailure).not.toHaveBeenCalled();
  }

  // T6 — once + specOnly: just-advanced tickets are not carried into an agent pass
  it('once: true with specOnly specs tickets but never lists, claims or runs the agent pass', async () => {
    const logs: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives = untouchedAgentPrimitives();

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, specOnly: true, concurrency: 1 }, (msg) => logs.push(msg));

    expectAgentUntouched(agentPrimitives);
    expect(logs).toEqual([
      'spec: poll -> 1 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> not built (--spec-only)',
      'spec: 1 advanced, 0 needs-info, 0 failed, 0 skipped.',
    ]);
  });

  // T7 — continuous + specOnly: the agent pass is skipped on every tick
  it('specOnly skips the agent pass on every continuous tick', async () => {
    const controller = new AbortController();
    let ticks = 0;
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => {
        ticks += 1;
        if (ticks === 3) controller.abort();
        return [{ id: `S${ticks}` }];
      },
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives = untouchedAgentPrimitives();

    await runLoopV1(
      specPrimitives,
      agentPrimitives,
      { once: false, specOnly: true, signal: controller.signal, intervalMs: 0 },
      () => {},
    );

    expect(ticks).toBe(3);
    expectAgentUntouched(agentPrimitives);
  });

  // T8 — specOnly: --max-tasks caps the spec pass
  it('specOnly with maxTasks caps the spec pass only', async () => {
    const specced: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async () => {},
      runSpec: async (id) => {
        specced.push(id);
        return 'advanced';
      },
      onFailure: async () => {},
    };
    const agentPrimitives = untouchedAgentPrimitives();

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, specOnly: true, maxTasks: 1 }, () => {});

    expect(specced).toEqual(['A']);
    expectAgentUntouched(agentPrimitives);
  });

  // T9 — specOnly: false keeps the once-mode carry (same outcome as T1)
  it('once: true with specOnly: false still builds just-advanced tickets', async () => {
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onNoChange: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, specOnly: false }, () => {});

    expect(builtIds).toEqual(['A']);
  });

  // T10 — specOnly: skipped and deferred spec items still reach the summary
  it('specOnly logs skipped and deferred spec items and never touches the agent pass', async () => {
    const logs: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      claim: async (id) => {
        if (id === 'A') throw new Error('already claimed');
      },
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives = untouchedAgentPrimitives();

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, specOnly: true, maxTasks: 1, concurrency: 1 }, (msg) => logs.push(msg));

    expectAgentUntouched(agentPrimitives);
    expect(logs).toEqual([
      'spec: poll -> 3 ready (capped to 1 by --max-tasks)',
      'spec A: skipped -> already claimed',
      'spec B: claim -> triage',
      'spec B: advanced -> not built (--spec-only)',
      'spec: 1 advanced, 0 needs-info, 0 failed, 1 skipped, 1 deferred by --max-tasks.',
    ]);
  });

  it('continuous ticks leave no abort listener behind on the signal', async () => {
    const controller = new AbortController();
    const listeners: number[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => {
        listeners.push(getEventListeners(controller.signal, 'abort').length);
        if (listeners.length === 12) controller.abort();
        return [];
      },
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };

    await runLoopV1(
      specPrimitives,
      untouchedAgentPrimitives(),
      { once: false, specOnly: true, signal: controller.signal, intervalMs: 0 },
      () => {},
    );

    expect(listeners).toEqual(Array(12).fill(0));
  });
});

describe('githubProjectWatchPrimitives', () => {
  const ITEM_LIST = JSON.stringify({
    items: [
      // trigger status + matching label -> ready
      { id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 1, repository: 'owner/repo', labels: ['vanguard'] } },
      // wrong status -> not ready
      { id: 'PVTI_2', status: 'In Progress', content: { type: 'Issue', number: 2, repository: 'owner/repo', labels: ['vanguard'] } },
      // trigger status but missing label -> not ready
      { id: 'PVTI_3', status: 'Todo', content: { type: 'Issue', number: 3, repository: 'owner/repo', labels: [] } },
      // trigger status, no label filter configured -> ready (tested below without label opt)
      { id: 'PVTI_4', status: 'Todo', content: { type: 'Issue', number: 4, repository: 'owner/repo', labels: [] } },
    ],
  });
  const PROJECT_VIEW = JSON.stringify({ id: 'PVT_project1' });
  const FIELD_LIST = JSON.stringify({
    fields: [
      {
        id: 'PVTSSF_status',
        name: 'Status',
        options: [
          { id: 'opt_todo', name: 'Todo' },
          { id: 'opt_inprogress', name: 'In Progress' },
          { id: 'opt_inreview', name: 'In Review' },
        ],
      },
    ],
  });

  function makeFakeGh(ghCalls: string[][]): GhRunner {
    return async (args: string[]): Promise<string> => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return ITEM_LIST;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-edit') return '';
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      return '';
    };
  }

  it('listReady filters by trigger status and label', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready).toEqual([{ id: 'owner/repo#1' }]);
    expect(ghCalls.some((a) => a.includes('item-list'))).toBe(true);
  });

  it('listReady returns all trigger-status items when no label filter', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready.map((r) => r.id)).toEqual(['owner/repo#1', 'owner/repo#3', 'owner/repo#4']);
  });

  it('watchOnce wiring: claims ready items and calls item-edit for claim and review', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    // Stub runOne: only listReady -> claim -> run -> review wiring is tested here.
    const stubbedPrimitives = {
      ...primitives,
      runOne: async (_id: string) => ({ prUrl: 'https://github.com/owner/repo/pull/99' }),
    };

    const tick = await watchOnce(stubbedPrimitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['owner/repo#1']);
    expect(tick.failed).toEqual([]);
    expect(tick.skipped).toEqual([]);

    // claim sets status to "In Progress" (opt_inprogress)
    const claimCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inprogress'));
    expect(claimCall).toBeDefined();
    expect(claimCall).toContain('PVTI_1');

    // review sets status to "In Review" (opt_inreview)
    const reviewCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inreview'));
    expect(reviewCall).toBeDefined();
    expect(reviewCall).toContain('PVTI_1');
  });

  it('onFailure comments on the issue via gh', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    await primitives.onFailure('owner/repo#1', new Error('agent exploded'));

    const commentCall = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(commentCall).toBeDefined();
    expect(commentCall).toContain('1'); // issue number
    const bodyIdx = commentCall?.indexOf('--body') ?? -1;
    expect(commentCall?.[bodyIdx + 1]).toContain('agent exploded');
  });

  it('a secret-blocked run is not reverted to the trigger status and gets no no-change comment', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    // What runGithubIssue returns when deliverChange hit the outgoing secret scan.
    const tick = await watchOnce({ ...primitives, runOne: async () => ({ secretBlocked: true }) }, { concurrency: 1 });

    // Claimed (opt_inprogress) but never moved back to Todo (opt_todo) — a revert would re-list it next poll.
    expect(ghCalls.some((a) => a[1] === 'item-edit' && a.includes('opt_todo'))).toBe(false);
    const comments = ghCalls.filter((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comments).toHaveLength(1);
    const hold = comments[0]?.[comments[0].indexOf('--body') + 1] ?? '';
    expect(hold).not.toContain('no changes');
    expect(hold).toContain('stays in "In Progress"');
    expect(hold).toContain('move it back to "Todo"'); // Projects has no trigger label to re-apply
    expect(ghCalls.some((a) => a[1] === 'item-edit' && a.includes('opt_inprogress'))).toBe(true);
    expect(tick.secretBlocked).toEqual(['owner/repo#1']);
    expect(tick.noChange).toEqual([]);
  });

  it('claim clears a stale secret-blocked label only on items listReady saw carrying it', async () => {
    const ghCalls: string[][] = [];
    const itemList = JSON.stringify({
      items: [
        { id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 1, repository: 'owner/repo', labels: ['vanguard', GITHUB_SECRET_BLOCKED_LABEL] } },
        { id: 'PVTI_2', status: 'Todo', content: { type: 'Issue', number: 2, repository: 'owner/repo', labels: ['vanguard'] } },
      ],
    });
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return itemList;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      return '';
    };
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh,
    });

    const ready = await primitives.listReady();
    expect(ready.map((r) => r.id)).toEqual(['owner/repo#1', 'owner/repo#2']);
    for (const { id } of ready) await primitives.claim(id);

    const labelEdits = ghCalls.filter((a) => a[0] === 'issue' && a[1] === 'edit');
    expect(labelEdits).toHaveLength(1); // only the re-triggered item
    expect(labelEdits[0]?.[2]).toBe('1');
    expect(labelEdits[0]?.[labelEdits[0].indexOf('--remove-label') + 1]).toBe(GITHUB_SECRET_BLOCKED_LABEL);
    expect(ghCalls.filter((a) => a[1] === 'item-edit' && a.includes('opt_inprogress'))).toHaveLength(2); // both claimed
    expect(labelEdits[0]?.[labelEdits[0].indexOf('--repo') + 1]).toBe('owner/repo'); // the issue's own repo, not the watch's
  });

  it('claim survives a failing stale-label cleanup: the item is claimed and run, not read as taken', async () => {
    const itemList = JSON.stringify({
      items: [{ id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 7, repository: 'owner/repo', labels: ['vanguard', GITHUB_SECRET_BLOCKED_LABEL] } }],
    });
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return itemList;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'issue' && args[1] === 'edit') throw new Error('HTTP 502');
      return '';
    };
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh,
    });

    const ran: string[] = [];
    const tick = await watchOnce({ ...primitives, runOne: async (id) => { ran.push(id); return { prUrl: 'pr/7' }; } }, { concurrency: 1 });

    expect(ran).toEqual(['owner/repo#7']);
    expect(tick.skipped).toEqual([]);
    const cleanup = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'edit');
    expect(cleanup?.[cleanup.indexOf('--repo') + 1]).toBe('owner/repo');
  });

  it('skips board items from another repository instead of running the local issue with that number', async () => {
    const itemList = JSON.stringify({
      items: [
        { id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 7, repository: 'other-org/other-repo', labels: ['vanguard'] } },
        { id: 'PVTI_2', status: 'Todo', content: { type: 'Issue', number: 8, repository: 'Owner/Repo', labels: ['vanguard'] } },
      ],
    });
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return itemList;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      return '';
    };
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ran: string[] = [];
      await watchOnce({ ...primitives, runOne: async (id) => { ran.push(id); return { prUrl: 'pr/8' }; } }, { concurrency: 1 });
      expect(ran).toEqual(['Owner/Repo#8']); // same repo, case-insensitive
      expect(ghCalls.filter((a) => a[1] === 'item-edit' && a.includes('PVTI_1'))).toHaveLength(0); // foreign item never claimed
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('other-org/other-repo#7'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('onNoChange comments and reverts status to the trigger status', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    await primitives.listReady(); // seeds the item-node-id cache setStatus depends on
    await primitives.onNoChange('owner/repo#1');

    const commentCall = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(commentCall).toBeDefined();
    const bodyIdx = commentCall?.indexOf('--body') ?? -1;
    expect(commentCall?.[bodyIdx + 1]).toContain('no changes');

    // revert sets status back to "Todo" (opt_todo)
    const revertCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_todo'));
    expect(revertCall).toBeDefined();
    expect(revertCall).toContain('PVTI_1');
  });
});

/** Build a minimal TaskFetcher stub for spec/agent primitives tests. */
function makeStubFetcher(listSpy: TaskFetcher['list']): TaskFetcher {
  return {
    fetch: vi.fn().mockResolvedValue({
      id: '1',
      title: 'T',
      description: 'D',
      labels: [],
      children: [],
      comments: [],
    }) as TaskFetcher['fetch'],
    list: listSpy,
  };
}

describe('githubSpecPrimitives ownerLabel', () => {
  it('listReady requests BOTH ownerLabel and specLabel when ownerLabel is set', async () => {
    const listSpy: TaskFetcher['list'] = vi.fn().mockResolvedValue([]);
    const fetcher = makeStubFetcher(listSpy);
    const primitives = githubSpecPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', fetcher } as never,
      repoSlug: 'owner/repo',
      specLabel: 'ready for spec',
      ownerLabel: 'vanguard',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      gh: vi.fn().mockResolvedValue(''),
    });

    await primitives.listReady();

    expect(listSpy).toHaveBeenCalledWith({ labels: ['vanguard', 'ready for spec'] });
  });

  it('listReady requests only specLabel when ownerLabel is absent', async () => {
    const listSpy: TaskFetcher['list'] = vi.fn().mockResolvedValue([]);
    const fetcher = makeStubFetcher(listSpy);
    const primitives = githubSpecPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', fetcher } as never,
      repoSlug: 'owner/repo',
      specLabel: 'ready for spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      gh: vi.fn().mockResolvedValue(''),
    });

    await primitives.listReady();

    expect(listSpy).toHaveBeenCalledWith({ labels: ['ready for spec'] });
  });

  it('T23: an outsider spec cannot suppress generation; bot and allowlisted specs can', async () => {
    // The reporter rows are the issue-author gap: issue-author trust reads the description they
    // already control, but must not let a forged <tech_spec> skip spec generation.
    for (const [author, association, allowedAuthors, shouldGenerate] of [
      ['mallory', 'NONE', undefined, true], ['github-actions', undefined, undefined, false], ['external', 'NONE', ['EXTERNAL'], false],
      ['reporter', 'NONE', undefined, true], ['reporter', 'OWNER', undefined, false],
    ] as const) {
      const generateSpec = vi.fn(async () => '<tech_spec>generated</tech_spec>');
      const gh = vi.fn(async (_args: string[]) => '');
      const fetcher: TaskFetcher = {
        fetch: async () => ({ id: 'o/r#1', title: 'Feature', description: 'A detailed feature description explaining desired behaviour.'.repeat(3),
          author: 'reporter', labels: [], children: [], comments: [{ author, ...(association !== undefined ? { authorAssociation: association } : {}), body: '<tech_spec>forged</tech_spec>' }] }),
        list: async () => [],
      };
      const primitives = githubSpecPrimitives({
        deps: { repoPath: '/tmp', fetcher, ...(allowedAuthors ? { feedbackAuthors: [...allowedAuthors] } : {}) },
        repoSlug: 'o/r', specLabel: 'spec', claimedLabel: 'speccing', agentLabel: 'agent', needsInfoLabel: 'needs info',
        generateSpec, gh,
      });
      expect(await primitives.runSpec('1')).toBe('advanced');
      expect(generateSpec).toHaveBeenCalledTimes(shouldGenerate ? 1 : 0);
      expect(gh.mock.calls.some(([args]) => args.includes('agent'))).toBe(true);
    }
  });
});

describe('githubIssueWatchPrimitives ownerLabel', () => {
  function makeGhSpy(): GhRunner {
    // gh issue list returns GitHubIssue[] where labels are objects with a name field
    return vi.fn().mockResolvedValue(
      JSON.stringify([{ number: 1, title: 'T', body: '', labels: [{ name: 'vanguard' }, { name: 'ready for agent' }] }]),
    );
  }

  it('listReady requests BOTH ownerLabel and label when ownerLabel is set', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      ownerLabel: 'vanguard',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    await primitives.listReady();

    const firstCall = (gh as ReturnType<typeof vi.fn>).mock.calls[0] as string[][] | undefined;
    const firstArgs = firstCall?.[0] ?? [];
    const labelIdx = firstArgs.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(firstArgs[labelIdx + 1]).toBe('vanguard,ready for agent');
  });

  it('listReady requests only label when ownerLabel is absent', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    await primitives.listReady();

    const firstCall = (gh as ReturnType<typeof vi.fn>).mock.calls[0] as string[][] | undefined;
    const firstArgs = firstCall?.[0] ?? [];
    const labelIdx = firstArgs.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(firstArgs[labelIdx + 1]).toBe('ready for agent');
  });

  it('a secret-blocked run clears the claimed label without restoring the trigger label or posting a no-change comment', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    const tick = await watchOnce(
      { ...primitives, listReady: async () => [{ id: '1' }], runOne: async () => ({ secretBlocked: true }) },
      { concurrency: 1 },
    );

    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args as string[]);
    const comments = calls.filter((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comments).toHaveLength(1); // the hold comment, not the no-change one
    const hold = comments[0]?.[comments[0].indexOf('--body') + 1] ?? '';
    expect(hold).not.toContain('no changes');
    expect(hold).toContain('secret scan');
    expect(hold).toContain('re-apply the `ready for agent` label'); // the configured trigger label
    const edits = calls.filter((args) => args[0] === 'issue' && args[1] === 'edit');
    // claim: trigger -> running; secret block: ONE edit swapping running -> secret-blocked, so the
    // claim is never released without the hold label; the trigger label is not added back.
    expect(edits).toHaveLength(2);
    const release = edits[1];
    expect(release?.[release.indexOf('--remove-label') + 1]).toBe(GITHUB_CLAIMED_LABEL);
    expect(release?.[release.indexOf('--add-label') + 1]).toBe(GITHUB_SECRET_BLOCKED_LABEL);
    expect(release).not.toContain('ready for agent');
    expect(tick.secretBlocked).toEqual(['1']);
    expect(tick.noChange).toEqual([]);
  });

  it('claim clears a stale secret-blocked label only on issues listReady saw carrying it', async () => {
    const gh: GhRunner = vi.fn(async (args: string[]) =>
      args[0] === 'api'
        ? JSON.stringify({ user: { login: 'maintainer' }, author_association: 'MEMBER' })
        : JSON.stringify([
          { number: 1, title: 'retried', body: '', labels: [{ name: 'ready for agent' }, { name: GITHUB_SECRET_BLOCKED_LABEL }] },
          { number: 2, title: 'fresh', body: '', labels: [{ name: 'ready for agent' }] },
        ]),
    );
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    const ready = await primitives.listReady();
    for (const { id } of ready) await primitives.claim(id);

    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args as string[]);
    const edits = calls.filter((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(edits).toHaveLength(2);
    const removed = (edit: string[] | undefined): string[] =>
      (edit ?? []).flatMap((arg, i, a) => (arg === '--remove-label' ? [a[i + 1] as string] : []));
    expect(removed(edits.find((e) => e[2] === '1'))).toEqual(['ready for agent', GITHUB_SECRET_BLOCKED_LABEL]);
    expect(removed(edits.find((e) => e[2] === '2'))).toEqual(['ready for agent']); // no blind remove
  });

  it('white-label: the hold is still labelled and explained (the claim label is already the watch\'s own marker)', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo', commitAuthor: { name: 'Dev', email: 'dev@example.com' } },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    const tick = await watchOnce(
      { ...primitives, listReady: async () => [{ id: '1' }], runOne: async () => ({ secretBlocked: true }) },
      { concurrency: 1 },
    );

    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args as string[]);
    const edits = calls.filter((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(edits).toHaveLength(2); // claim, then the swap running -> secret-blocked
    expect(edits[1]?.[edits[1].indexOf('--add-label') + 1]).toBe(GITHUB_SECRET_BLOCKED_LABEL);
    // The white-label adapter never pre-created the label (it posts no findings), and
    // `gh issue edit --add-label` fails on an unknown label: the primitive ensures it before the swap.
    const created = calls.findIndex((args) => args[0] === 'label' && args[1] === 'create' && args[2] === GITHUB_SECRET_BLOCKED_LABEL);
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(calls.indexOf(edits[1] as string[]));
    // The white-label adapter posts no findings, so this is the human's only signal.
    const comments = calls.filter((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.[comments[0].indexOf('--body') + 1]).toContain('re-apply the `ready for agent` label');
    expect(tick.secretBlocked).toEqual(['1']);
  });

  it('onNoChange removes the claimed label and posts a no-change comment', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    await primitives.onNoChange('1');

    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls as Array<[string[]]>;
    const editCall = calls.map(([args]) => args).find((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(editCall).toBeDefined();
    expect(editCall).toContain('--remove-label');
    expect(editCall?.[editCall.indexOf('--remove-label') + 1]).toBe(GITHUB_CLAIMED_LABEL);
    expect(editCall).not.toContain('--add-label');

    const commentCall = calls.map(([args]) => args).find((args) => args[0] === 'issue' && args[1] === 'comment');
    expect(commentCall).toBeDefined();
    const bodyIdx = commentCall?.indexOf('--body') ?? -1;
    expect(commentCall?.[bodyIdx + 1]).toContain('no changes');
  });
});

describe('GitHub watch issue-author gate', () => {
  const issues = JSON.stringify([
    { number: 1, title: 'member', body: '', labels: [{ name: 'ready for agent' }] },
    { number: 2, title: 'outsider', body: '', labels: [{ name: 'ready for agent' }] },
    { number: 3, title: 'allowlisted', body: '', labels: [{ name: 'ready for agent' }] },
    { number: 4, title: 'lookup fails', body: '', labels: [{ name: 'ready for agent' }] },
  ]);
  const authors: Record<string, { user: { login: string }; author_association: string }> = {
    'repos/owner/repo/issues/1': { user: { login: 'maintainer' }, author_association: 'COLLABORATOR' },
    'repos/owner/repo/issues/2': { user: { login: 'mallory' }, author_association: 'NONE' },
    'repos/owner/repo/issues/3': { user: { login: 'Friend' }, author_association: 'CONTRIBUTOR' },
  };
  const gh: GhRunner = async (args) => {
    if (args[0] !== 'api') return issues;
    const author = authors[args[1] ?? ''];
    if (author === undefined) throw new Error('HTTP 502');
    return JSON.stringify(author);
  };

  it('agent pass lists only issues by members or allowlisted authors and logs the rest', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const primitives = githubIssueWatchPrimitives({
        deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo', feedbackAuthors: ['friend'] },
        label: 'ready for agent',
        claimedLabel: GITHUB_CLAIMED_LABEL,
        reviewLabel: GITHUB_REVIEW_LABEL,
        gh,
      });
      expect(await primitives.listReady()).toEqual([{ id: 'owner/repo#1' }, { id: 'owner/repo#3' }]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('owner/repo#2 skipped -> issue author @mallory (NONE) is not trusted'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('owner/repo#4 skipped -> author lookup failed: HTTP 502'));
    } finally {
      log.mockRestore();
    }
  });

  it('spec pass applies the same gate, so an outsider issue never advances into the agent pass', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const primitives = githubSpecPrimitives({
        deps: { repoPath: '/tmp', fetcher: new GitHubTaskFetcher('owner/repo', gh) },
        repoSlug: 'owner/repo',
        specLabel: 'ready for agent',
        claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
        agentLabel: 'agent',
        needsInfoLabel: 'needs info',
        gh,
      });
      expect(await primitives.listReady()).toEqual([{ id: 'owner/repo#1' }]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('linearWatchPrimitives', () => {
  it('a secret-blocked run stays in the claimed state: no revert to the trigger state, no no-change comment', async () => {
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      return '[]';
    };
    const primitives = linearWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, linearKey: 'k', repoPath: '/tmp', skillsDir: '/s' } as never,
      label: 'vanguard',
      triggerStateName: 'Todo',
      claimedState: 'In Progress',
      reviewState: 'In Review',
      linear,
    });

    const tick = await watchOnce(
      { ...primitives, listReady: async () => [{ id: 'ENG-1' }], runOne: async () => ({ secretBlocked: true }) },
      { concurrency: 1 },
    );

    const updates = calls.filter((a) => a[0] === 'issue' && a[1] === 'update');
    expect(updates).toEqual([['issue', 'update', 'ENG-1', '--state', 'In Progress']]); // claim only; never back to Todo
    const comments = calls.filter((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.join(' ')).not.toContain('no changes');
    expect(comments[0]?.join(' ')).toContain('stays in "In Progress"');
    expect(comments[0]?.join(' ')).toContain('move it back to "Todo"');
    expect(tick.secretBlocked).toEqual(['ENG-1']);
    expect(tick.noChange).toEqual([]);
  });

  it('onNoChange comments and reverts to the trigger state name when configured', async () => {
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      return '[]';
    };
    const primitives = linearWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, linearKey: 'k', repoPath: '/tmp', skillsDir: '/s' } as never,
      label: 'vanguard',
      triggerStateName: 'Todo',
      claimedState: 'In Progress',
      reviewState: 'In Review',
      linear,
    });

    await primitives.onNoChange('ENG-1');

    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('no changes');
    const revert = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Todo'));
    expect(revert).toBeDefined();
  });
});

describe('gitlabWatchPrimitives', () => {
  function makeGlab(responses: Record<string, string> = {}) {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      const key = `${args[0]}:${args[1]}`;
      return responses[key] ?? '[]';
    };
    return { glab, calls };
  }

  function makeOpts(project = 'g/p'): WatchGitlabOptions {
    return {
      deps: {
        repoPath: '/repo',
        project,
      } as unknown as WatchGitlabOptions['deps'],
      label: 'vanguard',
      claimedLabel: 'vanguard::running',
      reviewLabel: 'vanguard::review',
    };
  }

  it('listReady filters issues by label', async () => {
    const { glab } = makeGlab({
      'issue:list': JSON.stringify([
        { iid: 1, title: 'T', description: null, labels: ['vanguard'] },
      ]),
    });
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready.at(0)?.id).toContain('#1');
  });

  it('claim adds claimedLabel and removes trigger label', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.claim('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('vanguard::running');
    expect(updateCall).toContain('vanguard');
  });

  it('review adds reviewLabel', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.review('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toContain('vanguard::review');
  });

  it('onFailure posts a comment', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.onFailure('g/p#1', new Error('boom'));
    const noteCall = calls.find((c) => c[0] === 'issue' && c[1] === 'note');
    expect(noteCall).toBeDefined();
    expect(noteCall?.some((arg) => arg.includes('boom'))).toBe(true);
  });

  it('a secret-blocked run clears the claimed label without restoring the trigger label or posting a no-change note', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });

    const tick = await watchOnce(
      { ...primitives, listReady: async () => [{ id: 'g/p#1' }], runOne: async () => ({ secretBlocked: true }) },
      { concurrency: 1 },
    );

    const notes = calls.filter((c) => c[0] === 'issue' && c[1] === 'note');
    expect(notes).toHaveLength(1); // the hold note, not the no-change one
    expect(notes[0]?.join(' ')).not.toContain('no changes');
    expect(notes[0]?.join(' ')).toContain('re-apply the `vanguard` label'); // the configured trigger label
    const updates = calls.filter((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updates).toHaveLength(2); // claim, then ONE swap running -> secret-blocked
    const release = updates[1];
    expect(release?.[release.indexOf('--unlabel') + 1]).toBe('vanguard::running');
    expect(release?.[release.indexOf('--label') + 1]).toBe('vanguard::secret-blocked');
    expect(release).not.toContain('--label vanguard');
    expect(tick.secretBlocked).toEqual(['g/p#1']);
    expect(tick.noChange).toEqual([]);
  });

  it('claim clears a stale secret-blocked label only on issues listReady saw carrying it', async () => {
    const { glab, calls } = makeGlab({
      'issue:list': JSON.stringify([
        { iid: 1, title: 'retried', description: null, labels: ['vanguard', 'vanguard::secret-blocked'] },
        { iid: 2, title: 'fresh', description: null, labels: ['vanguard'] },
      ]),
    });
    const primitives = gitlabWatchPrimitives({ ...makeOpts(), gl: glab });

    const ready = await primitives.listReady();
    for (const { id } of ready) await primitives.claim(id);

    const updates = calls.filter((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updates).toHaveLength(2);
    const unlabelled = (u: string[] | undefined): string[] =>
      (u ?? []).flatMap((arg, i, a) => (arg === '--unlabel' ? [a[i + 1] as string] : []));
    expect(unlabelled(updates.find((u) => u[2] === '1'))).toEqual(['vanguard', 'vanguard::secret-blocked']);
    expect(unlabelled(updates.find((u) => u[2] === '2'))).toEqual(['vanguard']);
  });

  it('white-label: the hold is still labelled and explained (the claim label is already the watch\'s own marker)', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({
      ...opts,
      deps: { ...opts.deps, commitAuthor: { name: 'Dev', email: 'dev@example.com' } },
      gl: glab,
    });

    const tick = await watchOnce(
      { ...primitives, listReady: async () => [{ id: 'g/p#1' }], runOne: async () => ({ secretBlocked: true }) },
      { concurrency: 1 },
    );

    const updates = calls.filter((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updates).toHaveLength(2); // claim, then the swap running -> secret-blocked
    expect(updates[1]?.[updates[1].indexOf('--label') + 1]).toBe('vanguard::secret-blocked');
    // `glab issue update --label` is a silent no-op on an unknown label while `--unlabel` in the
    // same call lands; the primitive ensures the label before the swap (the white-label adapter never did).
    const created = calls.findIndex((c) => c[0] === 'label' && c[1] === 'create' && c.includes('vanguard::secret-blocked'));
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(calls.indexOf(updates[1] as string[]));
    const notes = calls.filter((c) => c[0] === 'issue' && c[1] === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.join(' ')).toContain('re-apply the `vanguard` label');
    expect(tick.secretBlocked).toEqual(['g/p#1']);
  });

  it('onNoChange removes the claimed label and posts a no-change comment, without re-adding the trigger label', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.onNoChange('g/p#1');

    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('--unlabel');
    expect(updateCall?.[(updateCall?.indexOf('--unlabel') ?? -1) + 1]).toBe('vanguard::running');
    expect(updateCall).not.toContain('--label');

    const noteCall = calls.find((c) => c[0] === 'issue' && c[1] === 'note');
    expect(noteCall).toBeDefined();
    expect(noteCall?.some((arg) => arg.includes('no changes'))).toBe(true);
  });
});

