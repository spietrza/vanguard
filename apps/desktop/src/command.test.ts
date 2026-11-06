import { describe, it, expect } from 'vitest';
import { runCommand, watchArgv, watchCommand, runPresets, DEFAULT_PROVIDER } from './command';

describe('config-derived tokens are validated (app.json is repo content)', () => {
  const opts = { source: 'github', concurrency: 3, loopV1: false };
  const payloads = [
    'claude; touch /tmp/x #',
    'claude && id',
    '$(id)',
    '`id`',
    'claude | sh',
    'claude\nid',
    'claude --flow evil',
    '--flow=evil',
    '-x',
    'Claude',
    '',
  ];

  it.each(payloads)('rejects provider %j in every builder', (provider) => {
    expect(() => watchArgv({ provider }, opts)).toThrow(/Invalid provider/);
    expect(() => watchCommand({ provider }, opts)).toThrow(/Invalid provider/);
    expect(() => runCommand({ provider })).toThrow(/Invalid provider/);
  });

  it('rejects a source outside the allowlist', () => {
    expect(() => watchArgv({}, { ...opts, source: 'github; id' })).toThrow(/Invalid Task Source/);
    expect(() => runCommand({ source: 'x;id' })).toThrow(/Invalid Task Source/);
  });

  it('accepts built-in and custom provider names', () => {
    for (const provider of ['claude', 'codex', 'openrouter', 'my-proxy', 'corp.gw_2']) {
      expect(watchArgv({ provider }, opts)).toContain(provider);
    }
  });

  it('builds an argv with one element per argument (no shell string)', () => {
    expect(watchArgv({ provider: 'zai' }, { source: 'gitlab', concurrency: 2.7, loopV1: true })).toEqual([
      'vanguard', 'watch', '--gitlab', '--concurrency', '2', '--loop-v1', '--provider', 'zai', '--max-turns', '30',
    ]);
    expect(watchArgv({}, { ...opts, concurrency: 0 })).toContain('1');
  });
});

describe('command builder', () => {
  it('defaults the provider to claude, never zai/--llm-proxy', () => {
    const cmd = runCommand({});
    expect(cmd).toContain('--provider claude');
    expect(DEFAULT_PROVIDER).toBe('claude');
    expect(cmd).not.toContain('--llm-proxy');
    expect(cmd).not.toContain('zai');
  });

  it('honors a configured provider', () => {
    expect(runCommand({ provider: 'codex' })).toContain('--provider codex');
    expect(watchCommand({ provider: 'zai' }, { source: 'github', concurrency: 3, loopV1: false })).toContain(
      '--provider zai',
    );
  });

  it('run uses the given source and lifts the turn cap', () => {
    expect(runCommand({}, 'gitlab')).toBe('vanguard run --gitlab <issue> --provider claude --max-turns 30');
  });

  it('run falls back to cfg.source, then github', () => {
    expect(runCommand({ source: 'linear' })).toContain('run --linear');
    expect(runCommand({})).toContain('run --github');
  });

  it('watch wires source/concurrency and only adds --loop-v1 when set', () => {
    expect(watchCommand({}, { source: 'github', concurrency: 5, loopV1: false })).toBe(
      'vanguard watch --github --concurrency 5 --provider claude --max-turns 30',
    );
    expect(watchCommand({}, { source: 'github', concurrency: 2, loopV1: true })).toContain('--loop-v1');
  });

  it('presets cover the three sources with the configured provider', () => {
    const presets = runPresets({ provider: 'codex' });
    // Pin label→source so a copy-paste swap (e.g. the GitLab preset emitting --github) fails.
    expect(presets).toEqual([
      { label: 'Run issue', cmd: 'vanguard run --github <issue> --provider codex --max-turns 30' },
      { label: 'Run (GitLab MR)', cmd: 'vanguard run --gitlab <issue> --provider codex --max-turns 30' },
      { label: 'Run (Linear)', cmd: 'vanguard run --linear <issue> --provider codex --max-turns 30' },
    ]);
  });
});
