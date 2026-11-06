import { describe, it, expect, assert, afterEach } from 'vitest';
import { parseCli, USAGE } from './args.js';
import type { SharedRunOptions } from './args.js';

describe('parseCli', () => {
  it('defaults gc to cwd, 6h, no remote, not dry-run', () => {
    expect(parseCli(['gc'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/work',
      maxAgeMs: 6 * 60 * 60 * 1000,
      dryRun: false,
      abandoned: false,
    });
  });

  it('parses gc options', () => {
    expect(
      parseCli(['gc', '--repo', '/r', '--max-age-hours', '2', '--remote', 'o/r', '--dry-run', '--abandoned'], '/work'),
    ).toEqual({
      kind: 'gc',
      repoPath: '/r',
      maxAgeMs: 2 * 60 * 60 * 1000,
      remoteRepo: 'o/r',
      dryRun: true,
      abandoned: true,
    });
  });

  it('falls back to the default age on a non-numeric value', () => {
    const cmd = parseCli(['gc', '--max-age-hours', 'soon'], '/work');
    expect(cmd.kind === 'gc' && cmd.maxAgeMs).toBe(6 * 60 * 60 * 1000);
  });

  it('returns help for no command, an unknown command, or --help', () => {
    expect(parseCli([], '/work').kind).toBe('help');
    expect(parseCli(['frobnicate'], '/work').kind).toBe('help');
    expect(parseCli(['gc', '--help'], '/work').kind).toBe('help');
    expect(parseCli(['gc', '--bogus-flag'], '/work').kind).toBe('help');
  });

  it('parses the hidden __sidecar entrypoint (no flags)', () => {
    expect(parseCli(['__sidecar'], '/work')).toEqual({ kind: 'sidecar' });
  });

  it('parses the hidden __complete entrypoint (no flags)', () => {
    expect(parseCli(['__complete'], '/work')).toEqual({ kind: 'complete' });
  });

  it('parses a linear run with parent fan-out', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--parent', '--skills', '/s', '--concurrency', '3'], '/work')).toEqual({
      kind: 'run',
      source: 'linear',
      id: 'TES-1',
      parent: true,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 3,
      skillsDir: '/s',
    });
  });

  it('parses a github run with an explicit repo slug and defaults', () => {
    expect(parseCli(['run', '--github', 'o/r#5', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'run',
      source: 'github',
      id: 'o/r#5',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
    });
  });

  it('parses a project run with a label filter', () => {
    expect(parseCli(['run', '--project', '7', '--github-repo', 'o/r', '--label', 'todo'], '/work')).toEqual({
      kind: 'run',
      source: 'project',
      id: '7',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
      label: 'todo',
    });
  });

  it('parses --gc-before', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--gc-before'], '/work');
    expect(cmd.kind === 'run' && cmd.gcBefore).toBe(true);
  });

  it('parses --reuse', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--reuse'], '/work');
    expect(cmd.kind === 'run' && cmd.reuse).toBe(true);
  });

  it('omits reuse when --reuse is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'reuse' in cmd).toBe(false);
  });

  it('parses --llm-proxy into llmProxy', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--llm-proxy'], '/work');
    expect(cmd.kind === 'run' && cmd.llmProxy).toBe(true);
  });

  it('omits llmProxy when --llm-proxy is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'llmProxy' in cmd).toBe(false);
  });

  it('parses --provider and --review-provider (cross-provider review)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'codex'], '/work');
    expect(cmd.kind === 'run' && cmd.provider).toBe('claude');
    expect(cmd.kind === 'run' && cmd.reviewProvider).toBe('codex');
  });

  it('parses --fallback-provider / --fallback-model on run and watch, and rejects an unknown one or a model without a provider', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--fallback-provider', 'codex', '--fallback-model', 'gpt-5.6-sol'], '/work');
    expect(run.kind === 'run' && run.fallbackProvider).toBe('codex');
    expect(run.kind === 'run' && run.fallbackModel).toBe('gpt-5.6-sol');
    const watch = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--fallback-provider', 'codex'], '/work');
    expect(watch.kind === 'watch' && watch.fallbackProvider).toBe('codex');
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'bogus'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown fallback-provider "bogus"') });
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-model', 'x'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('--fallback-model needs --fallback-provider') });
    expect(parseCli(['run', '--linear', 'TES-1', '--fallback-provider', 'codex', '--fork', '3'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('does not apply to --fork') });
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--fallback-provider', 'openrouter'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('Implementer fallback cannot mix') });
  });

  it('parses provider flags on watch too', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider', 'codex'], '/work');
    expect(cmd.kind === 'watch' && cmd.provider).toBe('codex');
  });

  it('omits provider fields when the flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'provider' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewProvider' in cmd).toBe(false);
  });

  it('parses --fork into forkN (>=2)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--fork', '3'], '/work');
    expect(cmd.kind === 'run' && cmd.forkN).toBe(3);
  });

  it('ignores --fork below 2 or non-numeric', () => {
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', '1'], '/work')).toBe(false);
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', 'x'], '/work')).toBe(false);
  });

  // S6 churn: run/watch/doctor --provider relaxes to the name grammar (repo customs are legal and
  // only dispatch can read app.json). A grammar-VALID unknown name now parses through and fails at
  // dispatch listing built-ins + customs; grammar-invalid names and every other command still fail
  // right here. --review-provider stays closed-set everywhere.
  it('parses a grammar-valid non-built-in provider through for run/watch/doctor (resolved at dispatch)', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'gpt'], '/work')).toMatchObject({
      kind: 'run',
      provider: 'gpt',
    });
    expect(parseCli(['watch', '--source', 'github', '--label', 'x', '--provider', 'my-proxy'], '/work')).toMatchObject({
      kind: 'watch',
      provider: 'my-proxy',
    });
  });

  it('still rejects grammar-invalid providers, custom names on other commands, and unknown review-providers at parse', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'GPT'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown provider "GPT"'),
    });
    expect(parseCli(['review-pr', '1', '--provider', 'my-proxy'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown provider "my-proxy"'),
    });
    expect(parseCli(['run', '--linear', 'TES-1', '--review-provider', 'bard'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown review-provider "bard"'),
    });
  });

  it('returns an error when implement and review providers share a transport', () => {
    expect(
      parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'zai'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('transport'),
    });
  });

  it('parses --escalate-model on run and watch', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--escalate-model', 'claude-fable-5'], '/work');
    expect(run.kind === 'run' && run.escalateModel).toBe('claude-fable-5');
    const watch = parseCli(['watch', '--label', 'vanguard', '--escalate-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.escalateModel).toBe('opus');
    const bare = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(bare.kind === 'run' && 'escalateModel' in bare).toBe(false);
  });

  it('parses stats --branch and metrics push, and rejects an unknown metrics subcommand', () => {
    expect(parseCli(['stats', '--branch', 'vanguard-metrics'], '/work')).toMatchObject({ kind: 'stats', branch: 'vanguard-metrics' });
    expect(parseCli(['stats'], '/work')).not.toHaveProperty('branch');
    expect(parseCli(['metrics', 'push'], '/work')).toEqual({ kind: 'metrics', action: 'push', repoPath: '/work' });
    expect(parseCli(['metrics', 'push', '--repo', '/r', '--branch', 'b'], '/work')).toMatchObject({ kind: 'metrics', repoPath: '/r', branch: 'b' });
    const bad = parseCli(['metrics', 'pull'], '/work');
    expect(bad.kind === 'error' && bad.message).toMatch(/metrics expects a subcommand/);
  });

  it('parses approve --pr with --github-repo and an optional --mode, and rejects a non-numeric --pr', () => {
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'approve', prNumber: 7, repoSlug: 'o/r', repoPath: '/work', mode: 'shadow', json: false, dryRun: false,
    });
    expect(parseCli(['approve', '7', '--github-repo', 'o/r', '--mode', 'shadow'], '/work')).toMatchObject({ prNumber: 7, mode: 'shadow' });
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--repo', '/r', '--branch', 'b', '--json', '--dry-run'], '/work')).toMatchObject({
      repoPath: '/r', branch: 'b', json: true, dryRun: true,
    });
    expect(parseCli(['approve', '--pr', '7', '--github-repo', 'o/r'], '/work')).not.toHaveProperty('branch');

    for (const pr of ['abc', '0', '1.5', '']) {
      const bad = parseCli(['approve', '--pr', pr, '--github-repo', 'o/r'], '/work');
      expect(bad.kind === 'error' && bad.message).toMatch(/approve requires a positive --pr/);
    }
    const noPr = parseCli(['approve', '--github-repo', 'o/r'], '/work');
    expect(noPr.kind === 'error' && noPr.message).toMatch(/approve requires a positive --pr/);
    const noRepo = parseCli(['approve', '--pr', '7'], '/work');
    expect(noRepo.kind === 'error' && noRepo.message).toMatch(/approve requires --github-repo/);
    const live = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--mode', 'live'], '/work');
    expect(live.kind === 'error' && live.message).toMatch(/live mode is not implemented/);
    const unknownMode = parseCli(['approve', '--pr', '7', '--github-repo', 'o/r', '--mode', 'loud'], '/work');
    expect(unknownMode.kind === 'error' && unknownMode.message).toMatch(/unknown --mode "loud"/);
  });

  it('parses --fork-scorer on run, rejects it on watch and rejects unknown values', () => {
    const run = parseCli(['run', '--linear', 'TES-1', '--fork', '3', '--fork-scorer', 'decision'], '/work');
    expect(run.kind === 'run' && run.forkScorer).toBe('decision');
    const watch = parseCli(['watch', '--label', 'vanguard', '--fork-scorer', 'llm'], '/work');
    expect(watch.kind === 'error' && watch.message).toMatch(/watch does not fork/);
    const bare = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(bare.kind === 'run' && 'forkScorer' in bare).toBe(false);
    const bad = parseCli(['run', '--linear', 'TES-1', '--fork-scorer', 'coin'], '/work');
    expect(bad.kind === 'error' && bad.message).toMatch(/--fork-scorer expects llm or decision/);
    const noFork = parseCli(['run', '--linear', 'TES-1', '--fork-scorer', 'decision'], '/work');
    expect(noFork.kind === 'error' && noFork.message).toMatch(/only applies with --fork/);
  });

  it('parses the shared RunOptions flags identically on run and watch (one parseRunOptions)', () => {
    const shared = [
      '--provider', 'codex', '--review-provider', 'claude', '--fallback-provider', 'cursor', '--fallback-model', 'cursor-fast',
      '--provider-model', 'gpt-5', '--review-model', 'claude-opus', '--escalate-model', 'claude-fable-5',
      '--no-simplify', '--verify', 'pnpm test', '--visual-proof', 'pnpm shot', '--conformance', '--conformance-model', 'opus',
      '--commit-author', 'Seba <seba@example.com>', '--flow', 'flow-b', '--base', 'dev', '--max-turns', '80', '--max-repair-iterations', '5',
      '--skills', '/skills', '--feedback-authors', 'maintainer',
    ];
    // Required<>: a RunOptions field added without an entry here fails to compile, as it does in parseRunOptions.
    // --plan is asserted separately because it excludes --flow.
    const expected: Required<Omit<SharedRunOptions, 'plan'>> = {
      provider: 'codex',
      reviewProvider: 'claude',
      fallbackProvider: 'cursor',
      fallbackModel: 'cursor-fast',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      escalateModel: 'claude-fable-5',
      noSimplify: true,
      verifyCmd: 'pnpm test',
      visualProofCmd: 'pnpm shot',
      conformance: true,
      conformanceModel: 'opus',
      commitAuthor: { name: 'Seba', email: 'seba@example.com' },
      flow: 'flow-b',
      baseBranch: 'dev',
      maxTurns: 80,
      maxRepairIterations: 5,
      skillsDir: '/skills',
      feedbackAuthors: ['maintainer'],
    };
    const run = parseCli(['run', '--github', 'o/r#1', ...shared], '/work');
    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', ...shared], '/work');
    expect(run).toMatchObject({ kind: 'run', ...expected });
    expect(watch).toMatchObject({ kind: 'watch', ...expected });
    for (const key of Object.keys(expected)) {
      expect(watch[key as keyof typeof watch]).toEqual(run[key as keyof typeof run]);
    }
    expect(parseCli(['run', '--github', 'o/r#1', '--plan'], '/work')).toMatchObject({ kind: 'run', plan: true });
    expect(parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--plan'], '/work')).toMatchObject({ kind: 'watch', plan: true });
    // Absent flags leave no key on either command.
    const bareRun = parseCli(['run', '--github', 'o/r#1'], '/work');
    const bareWatch = parseCli(['watch', '--source', 'github', '--label', 'vanguard'], '/work');
    expect(bareRun.kind).toBe('run');
    expect(bareWatch.kind).toBe('watch');
    for (const key of [...Object.keys(expected), 'plan']) {
      expect(key in bareRun).toBe(false);
      expect(key in bareWatch).toBe(false);
    }
  });

  it('carries every shared flag onto doctor except the stage-only three', () => {
    const argv = [
      'doctor', '--source', 'github', '--label', 'vanguard',
      '--provider', 'codex', '--review-provider', 'claude', '--fallback-provider', 'cursor', '--fallback-model', 'cursor-fast',
      '--provider-model', 'gpt-5', '--review-model', 'claude-opus', '--escalate-model', 'claude-fable-5',
      '--no-simplify', '--verify', 'pnpm test', '--visual-proof', 'pnpm shot', '--conformance', '--conformance-model', 'opus',
      '--commit-author', 'Seba <seba@example.com>', '--flow', 'flow-b', '--base', 'dev', '--max-turns', '80', '--max-repair-iterations', '5',
    ];
    const doctor = parseCli(argv, '/work');
    expect(doctor).toMatchObject({
      kind: 'doctor',
      provider: 'codex',
      reviewProvider: 'claude',
      fallbackProvider: 'cursor',
      fallbackModel: 'cursor-fast',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      escalateModel: 'claude-fable-5',
      noSimplify: true,
      verifyCmd: 'pnpm test',
      commitAuthor: { name: 'Seba', email: 'seba@example.com' },
      flow: 'flow-b',
      baseBranch: 'dev',
      maxTurns: 80,
      maxRepairIterations: 5,
    });
    for (const key of ['visualProofCmd', 'conformance', 'conformanceModel']) expect(key in doctor).toBe(false);
  });

  it('rejects the run-only flags on watch and doctor instead of ignoring them', () => {
    for (const command of ['watch', 'doctor']) {
      const base = [command, '--source', 'linear', '--label', 'vanguard'];
      expect(parseCli([...base, '--spec-file', 's.md'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining('--spec-file applies to a single-issue run only') });
      expect(parseCli([...base, '--fork', '3'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining(`--fork applies to run only; ${command} does not fork`) });
      expect(parseCli([...base, '--fork-scorer', 'llm'], '/work')).toMatchObject({ kind: 'error', message: expect.stringContaining(`${command} does not fork`) });
    }
    // The same flags are fine on run.
    expect(parseCli(['run', '--github', 'o/r#1', '--spec-file', 's.md', '--fork', '3', '--fork-scorer', 'llm'], '/work')).toMatchObject({ kind: 'run', specFile: 's.md', forkN: 3, forkScorer: 'llm' });
  });

  it('documents the shared flags under both run and watch, and the run-only ones under run only', () => {
    const watchStart = USAGE.indexOf('watch options (trigger');
    const runStart = USAGE.indexOf('run options (exactly one source)');
    const runEnd = USAGE.indexOf('review-pr options:');
    expect(watchStart).toBeGreaterThan(-1);
    expect(runStart).toBeGreaterThan(watchStart);
    expect(runEnd).toBeGreaterThan(runStart);
    const watchBlock = USAGE.slice(watchStart, runStart);
    const runBlock = USAGE.slice(runStart, runEnd);
    for (const flag of ['--fallback-provider <name>', '--conformance-model <m>', '--max-repair-iterations <n>', '--base <branch>', '--max-turns <n>']) {
      expect(runBlock).toContain(flag);
      expect(watchBlock).toContain(flag);
    }
    for (const flag of ['--fork <n>', '--fork-scorer <llm|decision>', '--spec-file <file>']) {
      expect(runBlock).toContain(flag);
      expect(watchBlock).not.toContain(flag);
    }
  });

  it('parses --provider-model and --review-model on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider-model', 'opus', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'run' && cmd.providerModel).toBe('opus');
    expect(cmd.kind === 'run' && cmd.reviewModel).toBe('haiku');
  });

  it('parses --no-simplify on run and watch (absent => undefined)', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work').kind === 'run' && parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect(parseCli(['watch', '--label', 'vanguard', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect('noSimplify' in parseCli(['run', '--linear', 'TES-1'], '/work')).toBe(false);
  });

  it('parses --max-turns and --max-repair-iterations on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--max-turns', '80'], '/work');
    expect(cmd.kind === 'run' && cmd.maxTurns).toBe(80);
    const cmd2 = parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '5'], '/work');
    expect(cmd2.kind === 'run' && cmd2.maxRepairIterations).toBe(5);
  });

  it('parses --max-turns and --max-repair-iterations on watch', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--github-repo', 'o/r', '--max-turns', '80', '--max-repair-iterations', '5'],
      '/work',
    );
    expect(cmd.kind === 'watch' && cmd.maxTurns).toBe(80);
    expect(cmd.kind === 'watch' && cmd.maxRepairIterations).toBe(5);
  });

  it('parses --max-turns on review-mr and review-pr, and omits it when absent', () => {
    const mr = parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p', '--max-turns', '48'], '/work');
    expect(mr.kind === 'review-mr' && mr.maxTurns).toBe(48);
    const pr = parseCli(['review-pr', 'o/r#7', '--max-turns', '48'], '/work');
    expect(pr.kind === 'review-pr' && pr.maxTurns).toBe(48);
    expect('maxTurns' in parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['review-pr', 'o/r#7'], '/work')).toBe(false);
    const wm = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'l', '--max-turns', '48'], '/work');
    expect(wm.kind === 'watch-mrs' && wm.maxTurns).toBe(48);
    const wp = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'l', '--max-turns', '48'], '/work');
    expect(wp.kind === 'watch-prs' && wp.maxTurns).toBe(48);
  });

  it('parses --skills on the spec, revise and review commands (each runs an agent outside runSourcedIssue)', () => {
    const argvs = [
      ['spec', 'o/r#1'],
      ['revise-pr', 'o/r#7'],
      ['review-pr', 'o/r#7'],
      ['watch-prs', '--github-repo', 'o/r', '--label', 'l'],
      ['review-mr', '--mr', '5', '--gitlab-project', 'g/p'],
      ['watch-mrs', '--gitlab-project', 'g/p', '--label', 'l'],
    ];
    for (const argv of argvs) {
      expect(parseCli([...argv, '--skills', '/skills'], '/work')).toMatchObject({ kind: argv[0], skillsDir: '/skills' });
      expect('skillsDir' in parseCli(argv, '/work')).toBe(false);
    }
  });

  it('clamps a huge --max-turns or --max-rounds to Number.MAX_SAFE_INTEGER', () => {
    const huge = parseCli(['review-mr', '--mr', '5', '--gitlab-project', 'g/p', '--max-turns', '1e308'], '/work');
    expect(huge.kind === 'review-mr' && huge.maxTurns).toBe(Number.MAX_SAFE_INTEGER);
    const rounds = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--max-rounds', '1e308'], '/work');
    expect(rounds.kind === 'revise-pr' && rounds.maxRounds).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects --max-turns 0, negative, or non-numeric (no override set)', () => {
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '0'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '-3'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', 'x'], '/work')).toBe(false);
  });

  it('rejects --max-repair-iterations 0, negative, or non-numeric (no override set)', () => {
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '0'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '-3'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', 'x'], '/work')).toBe(false);
  });

  it('omits maxTurns and maxRepairIterations when neither flag is passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect('maxTurns' in cmd).toBe(false);
    expect('maxRepairIterations' in cmd).toBe(false);
  });

  it('parses review-pr with a GitHub PR URL', () => {
    expect(
      parseCli(['review-pr', 'https://github.com/o/r/pull/12', '--repo', '/work', '--provider', 'codex', '--review-model', 'gpt-5'], '/cwd'),
    ).toEqual({
      kind: 'review-pr',
      prRef: 'https://github.com/o/r/pull/12',
      repoPath: '/work',
      provider: 'codex',
      reviewModel: 'gpt-5',
      egress: false,
    });
  });

  it('parses review-pr with --github-pr and --github-repo', () => {
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r', '--llm-proxy'], '/work')).toEqual({
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
      llmProxy: true,
    });
  });

  it('parses watch-prs with label routing defaults', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'ready for vanguard review',
          '--provider', 'codex',
          '--review-model', 'gpt-5',
          '--interval', '15',
          '--concurrency', '1',
          '--once',
          '--egress',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      concurrency: 1,
      intervalMs: 15000,
      once: true,
      egress: true,
      provider: 'codex',
      reviewModel: 'gpt-5',
    });
  });

  it('parses custom watch-prs state labels', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'needs review',
          '--reviewing-label', 'robot:reviewing',
          '--reviewed-label', 'robot:reviewed',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'needs review',
      reviewingLabel: 'robot:reviewing',
      reviewedLabel: 'robot:reviewed',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses watch-prs with an author filter', () => {
    const cmd = parseCli(
      [
        'watch-prs',
        '--github-repo', 'o/r',
        '--label', 'ready for vanguard review',
        '--author', 'SebaBoler',
      ],
      '/work',
    );
    expect(cmd).toMatchObject({ kind: 'watch-prs', author: 'SebaBoler' });
  });

  it('omits the author filter when --author is not given', () => {
    const cmd = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x'], '/work');
    expect(cmd.kind).toBe('watch-prs');
    expect((cmd as Extract<typeof cmd, { kind: 'watch-prs' }>).author).toBeUndefined();
  });

  it('requires watch-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['watch-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['watch-prs', '--label', 'ready for vanguard review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses watch-prs --pr as a pinned PR number', () => {
    const cmd = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', '316'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch-prs', pr: 316 });
  });

  it('rejects a watch-prs --pr that is not a positive PR number', () => {
    expect(parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', 'abc'], '/work')).toMatchObject({
      kind: 'error',
    });
    expect(parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x', '--pr', '0'], '/work')).toMatchObject({
      kind: 'error',
    });
  });

  it('parses doctor-prs with PR review label defaults', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for vanguard review'], '/work')).toEqual({
      kind: 'doctor-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
    });
  });

  it('requires doctor-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['doctor-prs', '--label', 'ready for vanguard review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses doctor with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor', '--source', 'github', '--github-repo', 'o/r', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor');
    if (cmd.kind === 'doctor') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });

  it('parses doctor-prs with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for vanguard review', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor-prs');
    if (cmd.kind === 'doctor-prs') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });

  it('does not set llmProxy or provider on doctor without those flags (regression)', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('llmProxy' in cmd).toBe(false);
    expect((cmd as Extract<typeof cmd, { kind: 'doctor' }>).provider).toBeUndefined();
  });

  it('omits providerModel and reviewModel when flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'providerModel' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewModel' in cmd).toBe(false);
  });

  it('parses --provider-model and --review-model on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider-model', 'sonnet', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'watch' && cmd.providerModel).toBe('sonnet');
    expect(cmd.kind === 'watch' && cmd.reviewModel).toBe('haiku');
  });

  it('parses a linear watch with defaults and a required label', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses a valid --max-tasks on watch', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--max-tasks', '3'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      maxTasks: 3,
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('rejects a --max-tasks that is not a positive integer instead of processing everything', () => {
    for (const raw of ['soon', '0', '-2']) {
      const cmd = parseCli(['watch', '--label', 'vanguard', `--max-tasks=${raw}`], '/work');
      expect(cmd).toEqual({ kind: 'error', message: `--max-tasks needs a positive integer, got "${raw}".` });
    }
  });

  it('leaves maxTasks unset when --max-tasks is absent', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && cmd.maxTasks === undefined).toBe(true);
  });

  it('parses a github watch with markers and interval', () => {
    expect(
      parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--claimed-state', 'wip', '--interval', '30', '--once'], '/work'),
    ).toEqual({
      kind: 'watch',
      source: 'github',
      label: 'vanguard',
      claimedState: 'wip',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 30000,
      once: true,
      egress: false,
    });
  });

  it('infers github source when --github-repo is supplied on watch', () => {
    const cmd = parseCli(['watch', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.source).toBe('github');
      expect(cmd.repoSlug).toBe('o/r');
    }
  });

  it('uses safe github loop-v1 defaults for a repo-only watch command', () => {
    expect(parseCli(['watch', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses safe github loop-v1 defaults for a repo-only doctor command', () => {
    expect(parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'doctor',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses loop-v1 defaults with an explicit github ownership label', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--loop-v1', '--label', 'ai', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('ai');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('uses safe linear loop-v1 defaults when --loop-v1 is supplied', () => {
    expect(parseCli(['watch', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('uses safe linear loop-v1 defaults for doctor when --loop-v1 is supplied', () => {
    expect(parseCli(['doctor', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'doctor',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('watch requires --label', () => {
    expect(parseCli(['watch'], '/work')).toMatchObject({
      kind: 'error',
      message: 'watch --source linear requires --label <name>.',
    });
  });

  it('parses stats with defaults and flags', () => {
    expect(parseCli(['stats'], '/work')).toEqual({ kind: 'stats', repoPath: '/work', json: false });
    expect(parseCli(['stats', '--repo', '/r', '--json'], '/work')).toEqual({ kind: 'stats', repoPath: '/r', json: true });
  });

  it('parses memory with defaults (no limit field)', () => {
    expect(parseCli(['memory'], '/work')).toEqual({ kind: 'memory', repoPath: '/work', json: false });
  });

  it('parses memory with --repo, --limit, and --json', () => {
    expect(parseCli(['memory', '--repo', '/r', '--limit', '5', '--json'], '/work')).toEqual({
      kind: 'memory',
      repoPath: '/r',
      limit: 5,
      json: true,
    });
  });

  it('falls back to no limit field on invalid --limit for memory', () => {
    const cmd = parseCli(['memory', '--limit', 'soon'], '/work');
    expect(cmd.kind === 'memory' && cmd.limit === undefined).toBe(true);
  });

  it('returns an error when run has no source or more than one source', () => {
    expect(parseCli(['run'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--linear', 'A', '--github', 'B'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--github', 'A', '--project', '3'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('returns an error when run --parent is used without --linear', () => {
    expect(parseCli(['run', '--github', 'o/r#1', '--parent'], '/work')).toMatchObject({
      kind: 'error',
      message: '--parent is only supported with --linear.',
    });
  });

  it('returns an error when run --project is not a positive integer', () => {
    expect(parseCli(['run', '--project', 'x'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--project expects a board number'),
    });
    expect(parseCli(['run', '--project', '0'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses --verify into verifyCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--verify', 'pnpm test'], '/work');
    expect(cmd.kind === 'run' && cmd.verifyCmd).toBe('pnpm test');
  });

  it('omits verifyCmd when --verify is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --verify into verifyCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--verify', 'npm test'], '/work');
    expect(cmd.kind === 'watch' && cmd.verifyCmd).toBe('npm test');
  });

  it('omits verifyCmd when --verify is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind === 'run' && cmd.visualProofCmd).toBe('pnpm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--visual-proof', 'npm shot'], '/work');
    expect(cmd.kind === 'watch' && cmd.visualProofCmd).toBe('npm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('does not leak visualProofCmd onto doctor', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('visualProofCmd' in cmd).toBe(false);
  });

  it('parses --conformance flags on run', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(cmd.kind === 'run' && cmd.conformance).toBe(true);
    expect(cmd.kind === 'run' && cmd.conformanceModel).toBe('opus');
  });

  it('parses --conformance flags on watch but not doctor', () => {
    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.conformance).toBe(true);
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');

    const doctor = parseCli(['doctor', '--source', 'github', '--label', 'vanguard', '--conformance'], '/work');
    expect(doctor.kind).toBe('doctor');
    expect('conformance' in doctor).toBe(false);
    expect('conformanceModel' in doctor).toBe(false);
  });

  it('parses --conformance flags for gitlab runs and watches', () => {
    const run = parseCli(['run', '--gitlab', '7', '--conformance'], '/work');
    expect(run.kind === 'run' && run.source).toBe('gitlab');
    expect(run.kind === 'run' && run.conformance).toBe(true);

    const watch = parseCli(['watch', '--source', 'gitlab', '--label', 'vanguard', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.source).toBe('gitlab');
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');
  });

  it('parses --commit-author "Name <email>" on run and watch', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <spietrza@gmail.com>'], '/work');
    expect(run.kind === 'run' && run.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 'spietrza@gmail.com' });

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--commit-author', 'A B <a@b.co>'], '/work');
    expect(watch.kind === 'watch' && watch.commitAuthor).toEqual({ name: 'A B', email: 'a@b.co' });
  });

  it('rejects a malformed --commit-author', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'no-email-here'], '/work');
    expect(cmd.kind).toBe('error');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/Invalid --commit-author/);
  });

  it('parses --plan on run and watch (off by default)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--plan'], '/work');
    expect(run.kind === 'run' && run.plan).toBe(true);

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--plan'], '/work');
    expect(watch.kind === 'watch' && watch.plan).toBe(true);

    const noPlan = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noPlan.kind === 'run' && 'plan' in noPlan).toBe(false);
  });

  it('parses --flow on run and watch (a FLOWS key)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--flow', 'flow-b'], '/work');
    expect(run.kind === 'run' && run.flow).toBe('flow-b');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--flow', 'flow-b'], '/work');
    expect(watch.kind === 'watch' && watch.flow).toBe('flow-b');

    const noFlow = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noFlow.kind === 'run' && 'flow' in noFlow).toBe(false);
  });

  it('lets an unknown --flow through as a string — repo .vanguard/flows flows resolve in the async dispatch (S5)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--flow', 'my-custom'], '/work');
    expect(run.kind === 'run' && run.flow).toBe('my-custom');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--flow', 'my-custom'], '/work');
    expect(watch.kind === 'watch' && watch.flow).toBe('my-custom');
  });

  it('rejects --plan and --flow together', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--plan', '--flow', 'flow-b'], '/work');
    expect(cmd.kind).toBe('error');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/not both/);
  });

  it('parses --base on run and watch (defaults to undefined)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--base', 'dev'], '/work');
    expect(run.kind === 'run' && run.baseBranch).toBe('dev');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base', 'dev'], '/work');
    expect(watch.kind === 'watch' && watch.baseBranch).toBe('dev');

    const noBase = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noBase.kind === 'run' && 'baseBranch' in noBase).toBe(false);
  });

  it('rejects an unsafe or empty watch --base before any polling starts', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base=-dev'], '/work');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/Invalid base branch "-dev"/);
    const empty = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base='], '/work');
    expect(empty.kind === 'error' && empty.message).toMatch(/cannot be empty/);
  });

  it('parses review-pr --out (write-to-file, no PR comment)', () => {
    const cmd = parseCli(['review-pr', 'o/r#12', '--review-model', 'claude-fable-5', '--out', '.vanguard/reviews/12.md'], '/work');
    expect(cmd.kind).toBe('review-pr');
    expect(cmd.kind === 'review-pr' && cmd.out).toBe('.vanguard/reviews/12.md');
    expect(cmd.kind === 'review-pr' && cmd.reviewModel).toBe('claude-fable-5');
    const without = parseCli(['review-pr', 'o/r#12'], '/work');
    expect(without.kind === 'review-pr' && 'out' in without).toBe(false);
  });

  it('accepts the PR ref via positional, --github-pr, or --github (parity with spec/run)', () => {
    expect(parseCli(['review-pr', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'review-pr', prRef: '12' });
    expect(parseCli(['review-pr', '--github', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr'], '/work').kind).toBe('error');
  });

  it('parses revise-pr with --commit-author (white-label) and the --github alias', () => {
    const cmd = parseCli(
      ['revise-pr', '--github', 'o/r#12', '--review-model', 'claude-fable-5', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('revise-pr');
    expect(cmd.kind === 'revise-pr' && cmd.prRef).toBe('o/r#12');
    expect(cmd.kind === 'revise-pr' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'commitAuthor' in without).toBe(false);
  });

  it('parses revise-pr --out (dry-run to a file)', () => {
    const cmd = parseCli(['revise-pr', 'o/r#12', '--out', '.vanguard/revisions/12.md'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.out).toBe('.vanguard/revisions/12.md');
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'out' in without).toBe(false);
  });

  it('parses --commit-author on research (white-label toggle)', () => {
    const cmd = parseCli(['research', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <s@p.co>'], '/work');
    expect(cmd.kind).toBe('research');
    expect(cmd.kind === 'research' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });

  it('parses spec with --spec-model, --base, and --commit-author (white-label toggle)', () => {
    const cmd = parseCli(
      ['spec', 'o/r#1', '--spec-model', 'claude-fable-5', '--base', 'feat/allocation', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('spec');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('o/r#1');
    expect(cmd.kind === 'spec' && cmd.specModel).toBe('claude-fable-5');
    expect(cmd.kind === 'spec' && cmd.baseBranch).toBe('feat/allocation');
    expect(cmd.kind === 'spec' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });

  it('omits spec baseBranch when --base is absent (defaults to main downstream)', () => {
    const cmd = parseCli(['spec', 'o/r#1'], '/work');
    expect(cmd.kind === 'spec' && cmd.baseBranch).toBeUndefined();
  });

  it('parses spec with a bare number and --github-repo, and returns help without a ref', () => {
    const cmd = parseCli(['spec', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'spec' && cmd.repoSlug).toBe('o/r');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('7');
    expect(parseCli(['spec'], '/work').kind).toBe('help');
  });

  it('parses spec --out and run --spec-file (local-file spec flow)', () => {
    const spec = parseCli(['spec', 'o/r#1', '--out', '.vanguard/specs/1.md'], '/work');
    expect(spec.kind === 'spec' && spec.out).toBe('.vanguard/specs/1.md');

    const run = parseCli(['run', '--github', 'o/r#1', '--spec-file', '.vanguard/specs/1.md'], '/work');
    expect(run.kind === 'run' && run.specFile).toBe('.vanguard/specs/1.md');
    const without = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(without.kind === 'run' && 'specFile' in without).toBe(false);

    // One spec file cannot describe N fan-out tasks.
    expect(parseCli(['run', '--project', '7', '--spec-file', 's.md'], '/work').kind).toBe('error');
    expect(parseCli(['run', '--linear', 'ABC-1', '--parent', '--spec-file', 's.md'], '/work').kind).toBe('error');
  });

  // --- Loop v1 flag tests ---

  it('parses a github loop-v1 watch with spec/agent/needs-info labels and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-model', 'haiku',
        '--github-repo', 'o/r',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      specModel: 'haiku',
      repoSlug: 'o/r',
    });
  });

  it('parses a linear loop-v1 watch with spec-state/spec-state-name/needs-info-state and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-model', 'haiku',
        '--trigger-state', 'unstarted',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
      specModel: 'haiku',
      triggerState: 'unstarted',
    });
  });

  it('omits all loop-v1 fields when their flags are absent (existing watch parse unchanged)', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specLabel' in cmd).toBe(false);
      expect('agentLabel' in cmd).toBe(false);
      expect('needsInfoLabel' in cmd).toBe(false);
      expect('specState' in cmd).toBe(false);
      expect('specStateName' in cmd).toBe(false);
      expect('agentState' in cmd).toBe(false);
      expect('needsInfoState' in cmd).toBe(false);
      expect('specModel' in cmd).toBe(false);
    }
  });

  it('parses --agent-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--agent-state', 'Ready',
      ],
      '/work',
    );
    if (cmd.kind !== 'watch') throw new Error('expected watch');
    expect(cmd.agentState).toBe('Ready');
  });

  it('returns an error when a github loop-v1 flag is supplied on --source linear', () => {
    expect(
      parseCli(['watch', '--source', 'linear', '--spec-label', 'ready for spec'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('GitHub loop-v1 flags'),
    });
  });

  it('defaults github loop-v1 agent label when --agent-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--needs-info-label', 'needs info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('defaults github loop-v1 needs-info label when --needs-info-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--agent-label', 'ready for agent'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('defaults linear loop-v1 spec state name when --spec-state-name is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specStateName).toBe('Spec');
    }
  });

  it('defaults linear loop-v1 needs-info state when --needs-info-state is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--spec-state-name', 'Spec'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.needsInfoState).toBe('Needs Info');
    }
  });

  it('defaults linear loop-v1 ownership label when --label is missing', () => {
    const cmd = parseCli(
      ['watch', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
    }
  });

  it('returns an error when loop-v1 is attempted on project source', () => {
    expect(
      parseCli(
        ['watch', '--source', 'project', '--project', '7', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
        '/work',
      ),
    ).toMatchObject({
      kind: 'error',
      message: 'loop-v1 is not supported with --source project.',
    });
  });

  // --- FIX 1: --label as ownership filter for github loop-v1 ---

  it('parses --label into github loop-v1 when supplied alongside spec/agent/needs-info flags', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--label', 'vanguard',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('omits github loop-v1 ownership label when --label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
    }
  });

  // --- FIX 2: --spec-claimed-state and --spec-claimed-label flags ---

  it('parses --spec-claimed-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-claimed-state', 'Analyzing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedState).toBe('Analyzing');
    }
  });

  it('omits specClaimedState when --spec-claimed-state is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedState' in cmd).toBe(false);
    }
  });

  it('parses --spec-claimed-label on github loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-claimed-label', 'wip:speccing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedLabel).toBe('wip:speccing');
    }
  });

  it('omits specClaimedLabel when --spec-claimed-label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedLabel' in cmd).toBe(false);
    }
  });

  // --- --spec-only: spec pass without the agent pass ---

  it('parses --spec-only with --once on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'ready-for-agent',
        '--team', 'DEV',
        '--once',
        '--spec-only',
        '--spec-state', 'triage',
        '--spec-state-name', 'Triage',
        '--agent-state', 'Spec Review',
        '--needs-info-state', 'Needs Info',
      ],
      '/work',
    );
    expect(cmd).toMatchObject({ kind: 'watch', source: 'linear', once: true, specOnly: true, agentState: 'Spec Review' });
  });

  it('parses --spec-only on github loop-v1 defaults with a review label', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--github-repo', 'o/r', '--agent-label', 'spec review', '--spec-only'], '/work');
    expect(cmd).toMatchObject({ kind: 'watch', source: 'github', specLabel: 'ready for spec', agentLabel: 'spec review', specOnly: true, once: false });
  });

  it('parses --spec-only on doctor so preflight matches the spec-only watch', () => {
    const cmd = parseCli(['doctor', '--loop-v1', '--label', 'vanguard', '--agent-state', 'Spec Review', '--spec-only'], '/work');
    expect(cmd).toMatchObject({ kind: 'doctor', specOnly: true });
  });

  const linearTargetError =
    'watch --spec-only requires --agent-state <review state> other than "Todo"; that default is the build trigger, so specced issues would get no review window.';
  const labelTargetError =
    'watch --spec-only requires --agent-label <review label> other than "ready for agent"; that default is the build trigger, so specced issues would get no review window.';

  it.each([
    ['linear', ['--loop-v1', '--label', 'vanguard'], linearTargetError],
    ['github', ['--source', 'github', '--github-repo', 'o/r'], labelTargetError],
    ['gitlab', ['--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1'], labelTargetError],
  ])('rejects --spec-only on %s without an explicit review target', (_name, args, message) => {
    expect(parseCli(['watch', ...args, '--once', '--spec-only'], '/work')).toEqual({ kind: 'error', message });
  });

  it.each([
    ['linear', ['--loop-v1', '--label', 'vanguard', '--agent-state', ' todo'], linearTargetError],
    ['github', ['--source', 'github', '--github-repo', 'o/r', '--agent-label', 'Ready for agent'], labelTargetError],
  ])('rejects --spec-only on %s when the review target is the default build trigger given explicitly', (_name, args, message) => {
    expect(parseCli(['watch', ...args, '--once', '--spec-only'], '/work')).toEqual({ kind: 'error', message });
  });

  it('omits specOnly when --spec-only is absent', () => {
    const cmd = parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--once'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specOnly' in cmd).toBe(false);
    }
  });

  it('returns an error when --spec-only is used without loop-v1', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--once', '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --spec-only requires loop-v1, which any loop-v1 flag turns on (for example --loop-v1, --spec-state or --spec-label); single-pass watch has no spec pass.',
    });
  });

  it('returns an error when --spec-only advances to the spec trigger state, ignoring case', () => {
    expect(
      parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--spec-state-name', 'Spec', '--agent-state', 'spec', '--spec-only'], '/work'),
    ).toEqual({
      kind: 'error',
      message: 'watch --spec-only cannot advance specced issues into the spec trigger state "Spec"; set --agent-state to another state, or the spec pass specs the same issues again on every poll.',
    });
  });

  it('rejects --spec-only with an --agent-state matching the default spec state name in another case', () => {
    expect(parseCli(['watch', '--loop-v1', '--label', 'vanguard', '--agent-state', ' SPEC ', '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only cannot advance specced issues into the spec trigger state "Spec"'),
    });
  });

  it.each([
    ['github', ['--source', 'github', '--github-repo', 'o/r']],
    ['gitlab', ['--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard']],
  ])('rejects --spec-only on %s when --agent-label is the spec trigger label, ignoring case', (_name, sourceArgs) => {
    expect(parseCli(['watch', ...sourceArgs, '--spec-label', 'Ready', '--agent-label', 'ready', '--once', '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: 'watch --spec-only cannot advance specced issues into the spec trigger label "Ready"; set --agent-label to another label, or the spec pass specs the same issues again on every poll.',
    });
  });

  it.each(['watch', 'doctor'])('applies the spec trigger guard to %s only with --spec-only', (kind) => {
    const args = [kind, '--loop-v1', '--label', 'vanguard', '--agent-state', 'Spec'];
    expect(parseCli(args, '/work')).toMatchObject({ kind, agentState: 'Spec' });
    expect(parseCli([...args, '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining(`${kind} --spec-only cannot advance specced issues into the spec trigger state "Spec"`),
    });
  });

  it('returns an error when --spec-only is used on the project source', () => {
    expect(parseCli(['watch', '--source', 'project', '--project', '7', '--spec-only'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only requires loop-v1'),
    });
  });

  it.each([
    ['run', '--linear', 'TES-1'],
    ['watch-prs', '--github-repo', 'o/r', '--label', 'x'],
    ['watch-mrs', '--gitlab-project', 'g/p', '--label', 'x'],
  ])('rejects --spec-only on %s, which would otherwise ignore it', (...argv) => {
    expect(parseCli([...argv, '--spec-only'], '/work')).toEqual({
      kind: 'error',
      message: '--spec-only is only supported with watch and doctor.',
    });
  });

  it('T26: parses feedback authors consistently and preserves first spelling', () => {
    for (const argv of [['revise-pr', 'o/r#1'], ['run', '--github', 'o/r#1'], ['watch', '--source', 'github', '--label', 'vanguard']]) {
      expect(parseCli([...argv, '--feedback-authors', 'a, b ,A,,'], '/work')).toMatchObject({ feedbackAuthors: ['a', 'b'] });
      expect(parseCli(argv, '/work')).not.toHaveProperty('feedbackAuthors');
      // An empty/separator-only value (the workflow passing through an empty allowed-actors) is the
      // same as not passing the flag — never an empty allowlist.
      for (const empty of ['', ' , ']) expect(parseCli([...argv, '--feedback-authors', empty], '/work')).not.toHaveProperty('feedbackAuthors');
    }
  });
});

describe('parseCli revise-pr', () => {
  it('parses a bare PR number with --github-repo', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd).toEqual({
      kind: 'revise-pr',
      prRef: '7',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
    });
  });

  it('parses --github-pr as an alternative to positional', () => {
    const cmd = parseCli(['revise-pr', '--github-pr', '42', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') expect(cmd.prRef).toBe('42');
  });

  it('returns help when the PR ref is missing', () => {
    expect(parseCli(['revise-pr'], '/work').kind).toBe('help');
  });

  it('parses --max-rounds', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--max-rounds', '3'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.maxRounds).toBe(3);
  });

  it('omits maxRounds when --max-rounds is not passed', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'revise-pr' && 'maxRounds' in cmd).toBe(false);
  });

  it('parses --llm-proxy', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--llm-proxy'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.llmProxy).toBe(true);
  });

  it('parses --review-model', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--review-model', 'sonnet'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.reviewModel).toBe('sonnet');
  });

  it('parses a GitHub PR URL', () => {
    const cmd = parseCli(['revise-pr', 'https://github.com/o/r/pull/99'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') {
      expect(cmd.prRef).toBe('https://github.com/o/r/pull/99');
    }
  });
});

describe('parseCli gitlab run', () => {
  it('parses --gitlab flag as gitlab source', () => {
    const cmd = parseCli(['run', '--gitlab', 'owner/project#42'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('owner/project#42');
  });

  it('parses --gitlab with --gitlab-project', () => {
    const cmd = parseCli(['run', '--gitlab', '42', '--gitlab-project', 'group/project'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('42');
    expect(cmd.project).toBe('group/project');
  });
});

describe('parseCli watch gitlab', () => {
  it('parses --spec-only on gitlab loop-v1', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1', '--agent-label', 'spec review', '--once', '--spec-only'], '/repo');
    expect(cmd).toMatchObject({ kind: 'watch', source: 'gitlab', specLabel: 'ready for spec', once: true, specOnly: true });
  });

  it('rejects --spec-only on single-pass gitlab watch', () => {
    expect(parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--spec-only'], '/repo')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--spec-only requires loop-v1'),
    });
  });

  it('parses --source gitlab with --gitlab-project', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'owner/project', '--label', 'vanguard'], '/repo');
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.project).toBe('owner/project');
    expect(cmd.label).toBe('vanguard');
  });

  it('parses --source gitlab with loop-v1 flags', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard',
       '--spec-label', 'ready for spec', '--agent-label', 'ready for agent', '--needs-info-label', 'needs info'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });

  it('parses --source gitlab --loop-v1 with defaults', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });
});

describe('parseCli review-mr', () => {
  it('parses review-mr with --mr and --gitlab-project', () => {
    const cmd = parseCli(['review-mr', '--mr', '42', '--gitlab-project', 'owner/project'], '/repo');
    assert(cmd.kind === 'review-mr');
    expect(cmd.iid).toBe(42);
    expect(cmd.project).toBe('owner/project');
  });
});

describe('parseCli watch-mrs', () => {
  it('parses watch-mrs with required flags', () => {
    const cmd = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'watch-mrs');
    expect(cmd.project).toBe('g/p');
    expect(cmd.label).toBe('ready for review');
    expect(cmd.reviewingLabel).toBe('vanguard::reviewing');
    expect(cmd.reviewedLabel).toBe('vanguard::reviewed');
  });
});

describe('parseCli doctor-mrs', () => {
  it('parses doctor-mrs with required flags', () => {
    const cmd = parseCli(['doctor-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'doctor-mrs');
  });
});

describe('parseCli hub', () => {
  it('preserves repeated allowed Hosts', () => {
    expect(parseCli(['hub', '--allowed-host', 'hub.example', '--allowed-host', 'other.example:8080'], '/repo'))
      .toMatchObject({ kind: 'hub', allowedHosts: ['hub.example', 'other.example:8080'] });
  });

  const originalHost = process.env.VANGUARD_HUB_HOST;
  const originalPort = process.env.VANGUARD_HUB_PORT;

  afterEach(() => {
    if (originalHost === undefined) delete process.env.VANGUARD_HUB_HOST;
    else process.env.VANGUARD_HUB_HOST = originalHost;
    if (originalPort === undefined) delete process.env.VANGUARD_HUB_PORT;
    else process.env.VANGUARD_HUB_PORT = originalPort;
  });

  it('T-86 parses --repo/--port/--host/--ui-dir/--no-open, defaulting host/port when absent', () => {
    delete process.env.VANGUARD_HUB_HOST;
    delete process.env.VANGUARD_HUB_PORT;
    expect(parseCli(['hub'], '/repo')).toEqual({
      kind: 'hub',
      repoPath: '/repo',
      host: '127.0.0.1',
      port: 7777,
      open: true,
    });
    expect(
      parseCli(['hub', '--repo', '/elsewhere', '--port', '9999', '--host', '0.0.0.0', '--ui-dir', '/ui', '--no-open'], '/repo'),
    ).toEqual({
      kind: 'hub',
      repoPath: '/elsewhere',
      host: '0.0.0.0',
      port: 9999,
      uiDir: '/ui',
      open: false,
    });
  });

  it('T-86 falls back to VANGUARD_HUB_HOST/VANGUARD_HUB_PORT when the flags are absent', () => {
    process.env.VANGUARD_HUB_HOST = '0.0.0.0';
    process.env.VANGUARD_HUB_PORT = '9000';
    const cmd = parseCli(['hub'], '/repo');
    assert(cmd.kind === 'hub');
    expect(cmd.host).toBe('0.0.0.0');
    expect(cmd.port).toBe(9000);
    // An explicit flag still wins over the env default.
    const flagged = parseCli(['hub', '--host', '127.0.0.1', '--port', '1234'], '/repo');
    assert(flagged.kind === 'hub');
    expect(flagged.host).toBe('127.0.0.1');
    expect(flagged.port).toBe(1234);
  });

  it('T-87 an invalid explicit --port is an actionable error, not help', () => {
    for (const bad of ['0', '65536', '1.5', 'NaN', 'abc']) {
      const cmd = parseCli(['hub', '--port', bad], '/repo');
      expect(cmd.kind).toBe('error');
      assert(cmd.kind === 'error');
      expect(cmd.message).toMatch(/--port/);
    }
  });

  it('T-88 adding hub does not change any other command\'s parse result', () => {
    expect(parseCli(['gc'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/work',
      maxAgeMs: 6 * 60 * 60 * 1000,
      dryRun: false,
      abandoned: false,
    });
    expect(parseCli(['run', '--linear', 'TES-1'], '/work')).toEqual({
      kind: 'run',
      source: 'linear',
      id: 'TES-1',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
    });
    expect(parseCli(['watch', '--source', 'linear', '--label', 'vanguard'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      repoPath: '/work',
      label: 'vanguard',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
    expect(parseCli([], '/work').kind).toBe('help');
    expect(parseCli(['frobnicate'], '/work').kind).toBe('help');
  });
});
