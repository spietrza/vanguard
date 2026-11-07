import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { COMMAND_NAMES, HUB_ONLY, TAURI_ONLY, WIRE_PROVIDER_NAMES } from './wire.js';
import type { AppConfig, BoardChip, BoardTask, CompleteCallArgs, Finding, Project, ReviewVerdict, RunRecord } from './wire.js';
import { PROVIDER_NAMES } from './agents/registry.js';

// Mirrors scripts/gen-desktop-wire.ts (which cannot be imported from src/ — rootDir). The
// duplication is self-checking: if either side changes header or paths, the byte compare fails.
function assertByteIdenticalCopy(file: string): void {
  const header = `// GENERATED from src/${file} — do not edit; run pnpm gen:wire\n`;
  const core = join(__dirname, file);
  const desktop = join(__dirname, '..', 'apps', 'desktop', 'src', file);
  expect(readFileSync(desktop, 'utf8')).toBe(header + readFileSync(core, 'utf8'));
}

function assertZeroImports(file: string): void {
  const source = readFileSync(join(__dirname, file), 'utf8');
  expect(source).not.toMatch(/^\s*import\b/m);
  expect(source).not.toMatch(/\bfrom\s+['"]/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
}

describe('wire contract (S7)', () => {
  it('catalogue matches the registered Tauri commands', () => {
    const rust = readFileSync(join(__dirname, '../apps/desktop/src-tauri/src/lib.rs'), 'utf8');
    const registered = rust.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1];
    expect(registered).toBeDefined();
    const names = registered!.split(',').map((name) => name.trim().replace(/^sidecar::/, '')).filter(Boolean);
    expect(names.sort()).toEqual(COMMAND_NAMES.filter((name) => !(HUB_ONLY as readonly string[]).includes(name)).sort());
  });

  it('catalogue matches the implemented hub dispatch cases', () => {
    const rpc = readFileSync(join(__dirname, 'hub/rpc.ts'), 'utf8');
    const names = [...rpc.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
    expect(names.sort()).toEqual(COMMAND_NAMES.filter((name) => !(TAURI_ONLY as readonly string[]).includes(name)).sort());
  });

  it('models nullable Rust options and opaque config without widening completion permissions', () => {
    expectTypeOf<null>().toExtend<Project['lastRun']>();
    expectTypeOf<null>().toExtend<Project['color']>();
    expectTypeOf<null>().toExtend<AppConfig['source']>();
    expectTypeOf<null>().toExtend<AppConfig['concurrency']>();
    expectTypeOf<AppConfig['customProviders']>().toEqualTypeOf<unknown>();
    expectTypeOf<keyof CompleteCallArgs>().toEqualTypeOf<'system' | 'messages' | 'model' | 'attachments'>();
  });

  it('desktop copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    assertByteIdenticalCopy('wire.ts');
  });

  it('BoardTask.waiting is an optional boolean, present in both core and the regenerated desktop copy (T11)', () => {
    expectTypeOf<BoardTask['waiting']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<{ id: string; title: string; column: 'queued'; state: string }>().toExtend<BoardTask>();
    const desktop = readFileSync(join(__dirname, '..', 'apps', 'desktop', 'src', 'wire.ts'), 'utf8');
    expect(desktop).toMatch(/^\s*waiting\?: boolean;$/m);
  });

  it('RunRecord.verdict/findings and BoardTask.stage/chips are optional, present in the regenerated desktop copy (T23)', () => {
    expectTypeOf<RunRecord['verdict']>().toEqualTypeOf<ReviewVerdict | undefined>();
    expectTypeOf<RunRecord['findings']>().toEqualTypeOf<Finding[] | undefined>();
    expectTypeOf<BoardTask['stage']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<BoardTask['chips']>().toEqualTypeOf<BoardChip[] | undefined>();
    expectTypeOf<{ id: string; title: string; column: 'queued'; state: string }>().toExtend<BoardTask>();
    const desktop = readFileSync(join(__dirname, '..', 'apps', 'desktop', 'src', 'wire.ts'), 'utf8');
    expect(desktop).toMatch(/^\s*stage\?: string;$/m);
    expect(desktop).toMatch(/^\s*chips\?: BoardChip\[\];$/m);
    expect(desktop).toMatch(/^\s*verdict\?: ReviewVerdict;$/m);
  });

  it('wire.ts imports nothing — static, dynamic, or require (webview-safe by construction)', () => {
    assertZeroImports('wire.ts');
  });

  it('WIRE_PROVIDER_NAMES mirrors the registry, including order (the one underivable wire value)', () => {
    expect([...WIRE_PROVIDER_NAMES]).toEqual(PROVIDER_NAMES);
  });
});

describe('hub wire contract', () => {
  it('desktop copy is byte-identical to header + core source (codegen drift guard — run pnpm gen:wire)', () => {
    assertByteIdenticalCopy('hub-wire.ts');
  });

  it('hub-wire.ts imports nothing — static, dynamic, or require (browser-safe by construction)', () => {
    assertZeroImports('hub-wire.ts');
  });
});
