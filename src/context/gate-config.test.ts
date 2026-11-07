import { describe, expect, it } from 'vitest';
import { diffFilesWithPatches, gateConfigChangedBlock, gateConfigPaths } from './gate-config.js';

describe('gate config detection', () => {
  it.each([
    'vitest.config.ts',
    'packages/app/vitest.config.mjs',
    'jest.config.js',
    'eslint.config.js',
    '.eslintrc.json',
    'tsconfig.json',
    'tsconfig.base.json',
    '.prettierrc',
    '.prettierrc.yaml',
    'pyproject.toml',
    'setup.cfg',
    'pytest.ini',
    '.coveragerc',
  ])('matches the built-in glob for %s', (path) => {
    expect(gateConfigPaths([{ path }])).toEqual([path]);
  });

  it('does not match an unrelated source or doc file', () => {
    expect(gateConfigPaths([{ path: 'src/main.ts' }, { path: 'README.md' }])).toEqual([]);
  });

  it.each(['skills/review/SKILL.md', '.github/vanguard-skills/review/SKILL.md', 'skills.lock.json', 'vitest.config.ts'])('detects %s and renders its changes', (path) => {
    const files = diffFilesWithPatches(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`);
    expect(gateConfigPaths(files)).toEqual([path]);
    expect(gateConfigChangedBlock(files)).toContain(`- \`${path}\``);
    expect(gateConfigChangedBlock(files)).toContain('+new');
  });
  it('detects scripts in compact package.json', () => {
    expect(gateConfigPaths([{ path: 'package.json', patch: '+{"scripts":{"test":"true"}}' }])).toEqual(['package.json']);
  });
  it('applies extra globs to package.json too', () => {
    expect(gateConfigPaths([{ path: 'package.json' }], ['package.json'])).toEqual(['package.json']);
  });
  it('ignores ordinary source and dependency changes but detects gate scripts', () => {
    expect(gateConfigPaths([{ path: 'src/main.ts' }, { path: 'package.json', patch: '+  "execa": "10"' }])).toEqual([]);
    expect(gateConfigPaths([{ path: 'package.json', patch: '+  "test": "true"' }])).toEqual(['package.json']);
  });

  it.each(['verify', 'test', 'lint', 'typecheck'])('matches package.json only when scripts.%s changes', (key) => {
    expect(gateConfigPaths([{ path: 'package.json', patch: `+    "${key}": "new command"` }])).toEqual(['package.json']);
  });

  it('does not match package.json on a plain dependency bump', () => {
    const patch = ['-    "execa": "9.0.0",', '+    "execa": "9.1.0",'].join('\n');
    expect(gateConfigPaths([{ path: 'package.json', patch }])).toEqual([]);
  });
});
