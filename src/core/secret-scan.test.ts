import { describe, it, expect } from 'vitest';
import {
  injectedSecretValues,
  redactInjectedSecrets,
  redactTokens,
  scanForInjectedSecrets,
  scanForSecrets,
  renderSecretBlockComment,
} from './secret-scan.js';

const FAKE_JWT = 'eyJhbGciOiJSUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
const FAKE_SK_KEY = 'sk-FAKEtestkeyABCDEFGHIJ1234567890';
// 25 chars, mixes letters/digits/separators — long and varied enough to be credential-shaped.
const BEARER_CREDENTIAL = 'Ab1' + '.De_2-'.repeat(3) + 'xyz9';

function diffOf(files: { path: string; lines: string[] }[]): string {
  return files
    .map(
      (f) =>
        [`diff --git a/${f.path} b/${f.path}`, `--- a/${f.path}`, `+++ b/${f.path}`, '@@ -1,1 +1,2 @@', ...f.lines].join(
          '\n',
        ),
    )
    .join('\n');
}

describe('redactTokens', () => {
  it('leaves a long `://a:a:a…` run without `@` alone, in linear time (the old userinfo pattern backtracked quadratically)', () => {
    // 64k chars: the old `[^\s/@]+:[^\s/]*@` took ~2.8 s at 16k and quadruples per doubling; the fix stays under a millisecond.
    const pathological = `https://${'a:'.repeat(32000)}`;
    const started = performance.now();
    expect(redactTokens(pathological)).toBe(pathological);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('redacts JWTs, Bearer headers, and token JSON fields (unchanged from codex.ts)', () => {
    expect(redactTokens(`got ${FAKE_JWT} here`)).toBe('got [REDACTED-JWT] here');
    expect(redactTokens(`Authorization: Bearer ${BEARER_CREDENTIAL}`)).toBe('Authorization: Bearer [REDACTED]');
    expect(redactTokens('{"refresh_token":"rt_secret_value","x":1}')).toBe('{"refresh_token":"[REDACTED]","x":1}');
    expect(redactTokens('{"access_token": "at_secret"}')).toBe('{"access_token": "[REDACTED]"}');
  });

  it('leaves non-credential text untouched', () => {
    expect(redactTokens('account is not active')).toBe('account is not active');
  });

  it('masks a Bearer value under header shapes that carry no literal `Authorization:` prefix', () => {
    expect(redactTokens(`Authorization=Bearer ${BEARER_CREDENTIAL}`)).toBe('Authorization=Bearer [REDACTED]');
    expect(redactTokens(`{"authorization": "Bearer ${BEARER_CREDENTIAL}"}`)).toBe('{"authorization": "Bearer [REDACTED]"}');
  });

  it('redacts URL userinfo, bare GitHub/GitLab tokens and Basic auth — the shapes git and gh print into errors', () => {
    const glpat = `glpat-${'Ab1'.repeat(8)}`;
    const ghp = `ghp_${'A1b2c3d4e5'.repeat(4)}`;
    expect(redactTokens(`fatal: unable to access 'https://oauth2:${glpat}@gitlab.com/g/p.git/'`)).toBe(
      "fatal: unable to access 'https://[REDACTED]@gitlab.com/g/p.git/'",
    );
    expect(redactTokens(`https://x-access-token:${ghp}@github.com/o/r.git`)).toBe('https://[REDACTED]@github.com/o/r.git');
    expect(redactTokens(`token ${ghp} rejected`)).toBe('token [REDACTED-GH] rejected');
    expect(redactTokens(`${glpat} is expired`)).toBe('[REDACTED-GL] is expired');
    expect(redactTokens(`github_pat_${'Zy9'.repeat(10)}_x`)).toBe('[REDACTED-GH]');
    expect(redactTokens('Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==')).toBe('Authorization: Basic [REDACTED]');
    expect(redactTokens('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });

  it('redacts a bare Cursor API key', () => {
    expect(redactTokens(`agent: invalid key crsr_${'0a1b2c3d'.repeat(8)} for this team`)).toBe('agent: invalid key [REDACTED-CURSOR] for this team');
  });

  it('redacts a bare fake sk- key and a key=value assignment (new patterns)', () => {
    expect(redactTokens(`OPENAI_API_KEY=${FAKE_SK_KEY}`)).toContain('[REDACTED');
    expect(redactTokens(`export ${FAKE_SK_KEY}`)).toBe(`export [REDACTED-KEY]`);
    expect(redactTokens('token=abcdef0123456789abcdef')).toBe('token=[REDACTED]');
  });
});

describe('scanForSecrets', () => {
  it('detects a seeded FAKE JWT on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const token = "${FAKE_JWT}";`] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'jwt' }),
    );
  });

  it('does NOT flag a package-lock integrity hash that happens to contain "eyJ" (real JWTs have two dots, hashes have none)', () => {
    const diff = diffOf([
      {
        path: 'apps/backoffice/pnpm-lock.yaml',
        lines: ['+      integrity: sha512-eyJabcdEFGH1234567890ijklMNOPqrstUVWXyz0123456789abcdefABCDEFghijklmnopqrIJKLMNOPqRsTuVwXyZ+/w==}'],
      },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'jwt')).toBe(false);
  });

  it('detects a Bearer header on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const h = "Authorization: Bearer ${BEARER_CREDENTIAL}";`] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'bearer' }),
    );
  });

  it('detects a fake sk- key on an added line', () => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] }]);
    const findings = scanForSecrets(diff);
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'openai-key' }),
    );
  });

  it('does NOT flag an assignment whose value is a code reference (request.cookies), not a literal secret', () => {
    const diff = diffOf([
      {
        path: 'apps/backoffice/src/lib/e2e-bypass.ts',
        lines: ['+  const cookieToken = request.cookies?.get(E2E_BYPASS_COOKIE);'],
      },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'assignment')).toBe(false);
  });

  it('does NOT flag an unquoted bare camelCase identifier RHS (config read, not a literal) — live #744 false positive', () => {
    const diff = diffOf([
      { path: 'apps/api/src/env.ts', lines: ['+    WORKFLOW_CALLBACK_TOKEN: optionalNonEmptyEnvVar,'] },
      { path: 'apps/api/src/file/cloud-run-job.service.ts', lines: ['+    WORKFLOW_CALLBACK_TOKEN: callbackToken,'] },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'assignment')).toBe(false);
  });

  it('still flags a QUOTED camelCase-shaped value (a string literal, not an identifier)', () => {
    const diff = diffOf([{ path: 'src/config.ts', lines: ['+const token = "mySecretValueAbc";'] }]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'assignment')).toBe(true);
  });

  it('still flags an unquoted digit-bearing value (.env-style hex credential)', () => {
    const diff = diffOf([{ path: 'deploy/.env.production', lines: ['+WORKFLOW_CALLBACK_TOKEN=a3f9c2e847b1d605'] }]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'assignment')).toBe(true);
  });

  it('never leaks the raw secret value in the serialised findings', () => {
    const diff = diffOf([
      { path: 'src/foo.ts', lines: [`+const jwt = "${FAKE_JWT}";`, `+const key = "${FAKE_SK_KEY}";`] },
    ]);
    const findings = scanForSecrets(diff);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain(FAKE_JWT);
    expect(serialised).not.toContain(FAKE_SK_KEY);
    expect(serialised).toMatch(/\[REDACTED/);
  });

  it('returns no findings for a clean diff of ordinary code', () => {
    const diff = diffOf([
      {
        path: 'src/util.ts',
        lines: [
          '+export function skip(n: number): number {',
          '+  const identifier = "user-42";',
          '+  return n + 1;',
          '+}',
        ],
      },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('only flags added lines, not context/removed lines or the +++ header', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      `+++ b/src/foo.ts`,
      '@@ -1,2 +1,2 @@',
      ` const x = 1;`,
      `-const jwt = "${FAKE_JWT}";`,
      '+const jwt = "replaced";',
    ].join('\n');
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('attributes findings to the correct file across multiple files', () => {
    const diff = diffOf([
      { path: 'src/a.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
      { path: 'src/b.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] },
    ]);
    const findings = scanForSecrets(diff);
    expect(findings.find((f) => f.patternName === 'jwt')?.file).toBe('src/a.ts');
    expect(findings.find((f) => f.patternName === 'openai-key')?.file).toBe('src/b.ts');
  });

  it('skips test and fixture files (their fake secrets are not real leaks)', () => {
    const diff = diffOf([
      { path: 'src/core/secret-scan.test.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
      { path: 'src/cli/run-options.fixture.ts', lines: [`+const key = "${FAKE_SK_KEY}";`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips .spec.ts and .e2e-spec.ts files (NestJS/Jest/Vitest convention)', () => {
    const diff = diffOf([
      { path: 'apps/api/src/file/cloud-run-job.service.spec.ts', lines: [`+const CONFIGURED_CALLBACK_TOKEN = "${FAKE_SK_KEY}";`] },
      { path: 'apps/api/src/app.e2e-spec.ts', lines: [`+const jwt = "${FAKE_JWT}";`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags the same secret in a non-test source file', () => {
    const diff = diffOf([{ path: 'src/config.ts', lines: [`+const jwt = "${FAKE_JWT}";`] }]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'jwt' }),
    );
  });
});

describe('bearer: credential-shaped values only (#625)', () => {
  it.each([
    'plain bearer token',
    'bearer credentials',
    'the bearer credential',
    'Bearer tokens',
    'bearer internationalization',
  ])('does not treat %j as a bearer finding', (line) => {
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const note = "${line}";`] }]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'bearer')).toBe(false);
  });

  it.each(['abc.def.ghi', 'sk-abc.DEF_123-xyz', 'abcdefghijklmnopqrstuvwxyz'])('protects explicit headers with %s', (credential) => {
    const line = `Authorization: Bearer ${credential}`;
    expect(redactTokens(line)).toBe('Authorization: Bearer [REDACTED]');
    expect(scanForSecrets(diffOf([{ path: 'src/foo.ts', lines: [`+${line}`] }])))
      .toContainEqual(expect.objectContaining({ patternName: 'bearer' }));
  });

  it('redaction stays broad: short and letters-only values are masked even where the gate ignores them', () => {
    const short = ['ab', 'c'].join('');
    expect(redactTokens(`Bearer ${short}`)).toBe('Bearer [REDACTED]');
    expect(redactTokens(`Authorization=Bearer ${short}`)).toBe('Authorization=Bearer [REDACTED]');
    expect(redactTokens(`{"authorization": "Bearer ${short}"}`)).toBe('{"authorization": "Bearer [REDACTED]"}');
    expect(scanForSecrets(diffOf([{ path: 'src/foo.ts', lines: [`+const h = "Authorization=Bearer ${short}";`] }])))
      .toContainEqual(expect.objectContaining({ patternName: 'bearer' }));
  });

  it('a repeated scheme word is not taken as the value', () => {
    const tok = 'a1b2c3d4'.repeat(4);
    expect(redactTokens(`Bearer Bearer ${tok}`)).toBe('Bearer Bearer [REDACTED]');
    expect(redactTokens(`Authorization: Bearer Bearer ${tok}`)).toBe('Authorization: Bearer Bearer [REDACTED]');
    expect(scanForSecrets(diffOf([{ path: 'src/foo.ts', lines: [`+const h = "Bearer Bearer ${tok}";`] }])))
      .toContainEqual(expect.objectContaining({ patternName: 'bearer' }));
  });

  it('masks a standard-base64 token whole, padding and all (no `+/w==` tail left behind)', () => {
    const token = 'YWJjZGVmZ2hpamtsbW5vcHE+/w==';
    expect(redactTokens(`Authorization: Bearer ${token}`)).toBe('Authorization: Bearer [REDACTED]');
    expect(redactTokens(`Bearer ${token}`)).toBe('Bearer [REDACTED]');
  });

  it('protects bare credential values', () => {
    const line = `Bearer ${BEARER_CREDENTIAL}`;
    expect(redactTokens(line)).toBe('Bearer [REDACTED]');
    expect(scanForSecrets(diffOf([{ path: 'src/foo.ts', lines: [`+${line}`] }])))
      .toContainEqual(expect.objectContaining({ patternName: 'bearer' }));
  });

  it.each([
    ['32-char hex', 'a1b2c3d4'.repeat(4), 32],
    ['40-char base64url', 'A1b2-C3d4_E5f6'.repeat(3).slice(0, 40), 40],
  ] as const)('still redacts a %s token after Authorization: Bearer', (_name, token, length) => {
    expect(token).toHaveLength(length);
    const line = `Authorization: Bearer ${token}`;
    expect(redactTokens(line)).toBe('Authorization: Bearer [REDACTED]');
    const diff = diffOf([{ path: 'src/foo.ts', lines: [`+const h = "${line}";`] }]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/foo.ts', patternName: 'bearer' }),
    );
  });

  it('still redacts a JWT after Authorization: Bearer (caught unconditionally by the jwt pattern)', () => {
    const line = `Authorization: Bearer ${FAKE_JWT}`;
    expect(redactTokens(line)).toBe('Authorization: Bearer [REDACTED-JWT]');
  });
});

describe('python test-path exclusion', () => {
  it('skips a test_*.py file (pytest prefix convention)', () => {
    const diff = diffOf([
      {
        path: 'apps/prefect_flows/tests/test_export_exceptions.py',
        lines: [`+    assert posted["headers"]["Authorization"] == "Bearer ${FAKE_JWT}"`],
      },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips a *_test.py file (pytest suffix convention)', () => {
    const diff = diffOf([{ path: 'apps/svc/foo_test.py', lines: [`+key = "${FAKE_SK_KEY}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips conftest.py', () => {
    const diff = diffOf([{ path: 'apps/x/conftest.py', lines: [`+jwt = "${FAKE_JWT}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('skips non-test helper modules under a tests/ directory (language-agnostic dir rule)', () => {
    const diff = diffOf([{ path: 'apps/x/tests/helpers.py', lines: [`+key = "${FAKE_SK_KEY}"`] }]);
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags the same secret in a non-test .py source file', () => {
    const diff = diffOf([{ path: 'src/service.py', lines: [`+jwt = "${FAKE_JWT}"`] }]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/service.py', patternName: 'jwt' }),
    );
  });

  it('does NOT over-match files whose names merely contain "test"/"latest"', () => {
    const diff = diffOf([
      { path: 'contest.py', lines: [`+jwt = "${FAKE_JWT}"`] },
      { path: 'latest_data.py', lines: [`+key = "${FAKE_SK_KEY}"`] },
    ]);
    const findings = scanForSecrets(diff);
    expect(findings.some((f) => f.file === 'contest.py')).toBe(true);
    expect(findings.some((f) => f.file === 'latest_data.py')).toBe(true);
  });

  it('is case-insensitive for the new Python branches', () => {
    const diff = diffOf([
      { path: 'apps/x/TEST_FOO.PY', lines: [`+jwt = "${FAKE_JWT}"`] },
      { path: 'apps/x/Conftest.py', lines: [`+key = "${FAKE_SK_KEY}"`] },
    ]);
    expect(scanForSecrets(diff)).toEqual([]);
  });
});

describe('assignment refine: identifier chains', () => {
  it('does not flag a dotted code reference assigned to an auth-ish name', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,2 @@',
      '+const auth = opts.pushToken ? pushAuthConfigArgs(opts.pushToken, opts.host) : [];',
      '+const token = deps.auth.accessToken;',
    ].join('\n');
    expect(scanForSecrets(diff)).toEqual([]);
  });

  it('still flags a realistic secret-like value on the same shape of line', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,1 @@',
      '+const auth = "q7Rw2xZk9mP4vN8s";',
    ].join('\n');
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/x.ts', patternName: 'assignment' }),
    );
  });
});

describe('allowlist marker (global suppression)', () => {
  it.each([
    ['bearer', `+const h = "Authorization: Bearer ${BEARER_CREDENTIAL}"`, '// gitleaks:allow'],
    ['jwt', `+const token = "${FAKE_JWT}"`, '// pragma: allowlist secret'],
    ['openai-key', `+const key = "${FAKE_SK_KEY}"`, '// vanguard-allow-secret'],
    ['json-token-field', '+const payload = {"access_token":"rt_secret_value"}', '// gitleaks:allow'],
    ['assignment', '+const auth = "q7Rw2xZk9mP4vN8s"', '// gitleaks:allow'],
  ])('suppresses a %s finding when the marker is on the same line (control: flags without it)', (patternName, code, marker) => {
    const withMarker = diffOf([{ path: 'src/config.ts', lines: [`${code}; ${marker}`] }]);
    expect(scanForSecrets(withMarker).some((f) => f.patternName === patternName)).toBe(false);

    const withoutMarker = diffOf([{ path: 'src/config.ts', lines: [`${code};`] }]);
    expect(scanForSecrets(withoutMarker).some((f) => f.patternName === patternName)).toBe(true);
  });

  it('does not suppress a secret on the next added line (marker scope is per-line)', () => {
    const diff = diffOf([
      {
        path: 'src/config.ts',
        lines: ['+const note = "see docs"; // gitleaks:allow', `+const key = "${FAKE_SK_KEY}";`],
      },
    ]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'openai-key' }),
    );
  });

  it('does not suppress a secret on a different added line even when the marker is standalone', () => {
    const diff = diffOf([
      { path: 'src/config.ts', lines: [`+const key = "${FAKE_SK_KEY}";`, '+// gitleaks:allow'] },
    ]);
    expect(scanForSecrets(diff)).toContainEqual(
      expect.objectContaining({ file: 'src/config.ts', patternName: 'openai-key' }),
    );
  });

  it('is case-insensitive for the marker', () => {
    const diff = diffOf([
      { path: 'src/config.ts', lines: [`+const key = "${FAKE_SK_KEY}"; // GITLEAKS:ALLOW`] },
    ]);
    expect(scanForSecrets(diff).some((f) => f.patternName === 'openai-key')).toBe(false);

    const diff2 = diffOf([
      { path: 'src/config.ts', lines: [`+const token = "${FAKE_JWT}"; // Pragma: Allowlist Secret`] },
    ]);
    expect(scanForSecrets(diff2).some((f) => f.patternName === 'jwt')).toBe(false);
  });
});

// A credential shaped like the real ones (long, high entropy) but matching no SECRET_PATTERNS entry:
// only the exact-value check can catch it.
const INJECTED = 'opaque-credential-92837';
/** One-file diff whose single added line is `line`; the path is a test path by default (pattern-scan exempt). */
const injectedDiff = (line: string, path = 'tests/example.ts'): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n context\n-old\n+${line}\n+tail`;

describe('injectedSecretValues', () => {
  it('reads the watched env vars and dedupes a value present under two names', () => {
    const values = injectedSecretValues({ OPENAI_API_KEY: INJECTED, GH_TOKEN: INJECTED });
    expect(values).toEqual([INJECTED]);
  });

  it('skips a value too short to be a credential', () => {
    expect(injectedSecretValues({ GH_TOKEN: 'short' })).toEqual([]);
  });

  it('skips a placeholder or low-entropy value (an injected hit has no allowlist escape)', () => {
    expect(injectedSecretValues({ ANTHROPIC_API_KEY: 'placeholder-value' })).toEqual([]);
    expect(injectedSecretValues({ ANTHROPIC_API_KEY: 'aaaaaaaaaaaaaaaa' })).toEqual([]);
    expect(injectedSecretValues({ ANTHROPIC_API_KEY: '<your-key-here>' })).toEqual([]);
  });

  it('extracts the Codex credentials out of a pretty-printed auth.json', () => {
    const values = injectedSecretValues({
      CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: INJECTED, refresh_token: 'refresh-92837xyz' } }, null, 2),
    });
    expect(values).toContain(INJECTED);
    expect(values).toContain('refresh-92837xyz');
  });

  it('dedupes a value present both in auth.json and under its own env var', () => {
    const values = injectedSecretValues({
      CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: INJECTED } }),
      OPENAI_API_KEY: INJECTED,
    });
    expect(values.filter((v) => v === INJECTED)).toHaveLength(1);
  });

  it('keeps an unparseable auth.json as a raw value', () => {
    expect(injectedSecretValues({ CODEX_AUTH_JSON: 'invalid-json-xx' })).toEqual(['invalid-json-xx']);
  });

  it('reads caller-supplied extra env var names (a custom provider keyEnv the static list cannot know)', () => {
    expect(injectedSecretValues({ ACME_LLM_KEY: INJECTED })).toEqual([]);
    expect(injectedSecretValues({ ACME_LLM_KEY: INJECTED }, ['ACME_LLM_KEY'])).toEqual([INJECTED]);
  });
});

describe('scanForInjectedSecrets', () => {
  it('flags an added line in a test file carrying an allowlist marker (both exemptions ignored)', () => {
    expect(scanForInjectedSecrets(injectedDiff(`${INJECTED} // gitleaks:allow`), [INJECTED])).toEqual([
      { file: 'tests/example.ts', line: 2 },
    ]);
  });

  it.each([
    ['base64', (v: string): string => Buffer.from(v).toString('base64')],
    ['url-encoded', encodeURIComponent],
    ['json-escaped', (v: string): string => JSON.stringify(v).slice(1, -1)],
  ])('flags the %s encoding of the same credential', (_name, encode) => {
    const value = 'opaque"value\\92837';
    expect(scanForInjectedSecrets(injectedDiff(encode(value)), [value])).toHaveLength(1);
  });

  it('flags a credential that appears only in the file path once, with no line number, though two headers announce it', () => {
    expect(scanForInjectedSecrets(injectedDiff('safe', `${INJECTED}.txt`), [INJECTED])).toEqual([
      { file: '[REDACTED-INJECTED].txt' },
    ]);
  });

  it('flags a pure rename onto a credential-named path (no `+++ b/` header at all)', () => {
    const diff =
      `diff --git a/notes.md b/${INJECTED}.md\nsimilarity index 100%\nrename from notes.md\nrename to ${INJECTED}.md`;
    expect(scanForInjectedSecrets(diff, [INJECTED])).toEqual([{ file: '[REDACTED-INJECTED].md' }]);
  });

  it('ignores a rename away from a credential-named path (the old path is not new content)', () => {
    const diff =
      `diff --git a/${INJECTED}.md b/notes.md\nsimilarity index 100%\nrename from ${INJECTED}.md\nrename to notes.md`;
    expect(scanForInjectedSecrets(diff, [INJECTED])).toEqual([]);
  });

  it('flags a new binary file whose path carries the credential (content is unreachable in a diff)', () => {
    const diff =
      `diff --git a/${INJECTED}.png b/${INJECTED}.png\nnew file mode 100644\nindex 0000000..1a2b3c4\n` +
      `Binary files /dev/null and b/${INJECTED}.png differ`;
    expect(scanForInjectedSecrets(diff, [INJECTED])).toEqual([{ file: '[REDACTED-INJECTED].png' }]);
  });

  it('flags added content that resembles a file header', () => {
    expect(scanForInjectedSecrets(injectedDiff(`++ ${INJECTED}`), [INJECTED])).toHaveLength(1);
  });

  it('ignores context and removed lines', () => {
    expect(scanForInjectedSecrets(injectedDiff('safe').replace('-old', `-${INJECTED}`), [INJECTED])).toEqual([]);
    expect(scanForInjectedSecrets(injectedDiff('safe').replace(' context', ` ${INJECTED}`), [INJECTED])).toEqual([]);
  });

  it('counts the new-file line number past a no-newline marker', () => {
    const diff = injectedDiff('safe').replace('+safe\n+tail', `+safe\n\\ No newline at end of file\n+${INJECTED}`);
    expect(scanForInjectedSecrets(diff, [INJECTED])).toEqual([{ file: 'tests/example.ts', line: 3 }]);
  });

  it('counts a context line whose leading space was stripped', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n\n+${INJECTED}`;
    expect(scanForInjectedSecrets(diff, [INJECTED])).toEqual([{ file: 'src/a.ts', line: 2 }]);
  });

  it('ignores values below the plausibility floor', () => {
    expect(scanForInjectedSecrets(injectedDiff('short'), ['', 'short'])).toEqual([]);
  });
});

describe('redactInjectedSecrets', () => {
  it('replaces the longest variant first, so no fragment of a longer credential survives', () => {
    const shorter = 'abcdef-123456';
    const longer = `${shorter}-xyz789`;
    expect(redactInjectedSecrets(`key=${longer}`, [shorter, longer])).toBe('key=[REDACTED-INJECTED]');
  });

  it('leaves text without a known credential untouched', () => {
    expect(redactInjectedSecrets('plain code', [INJECTED])).toBe('plain code');
  });
});

describe('renderSecretBlockComment injected findings', () => {
  it('lists file and line with no excerpt, and omits the line for a path match', () => {
    const comment = renderSecretBlockComment({
      reason: 'findings',
      findings: [],
      injected: [{ file: 'tests/example.ts', line: 2 }, { file: '[REDACTED-INJECTED].txt' }],
    });
    expect(comment).toContain('- `tests/example.ts`:2 [injected-secret] (exact match — value withheld)');
    expect(comment).toContain('- `[REDACTED-INJECTED].txt` [injected-secret] (exact match — value withheld)');
  });
});

describe('renderSecretBlockComment stage wording', () => {
  it('names the outcome per stage: first delivery opened no PR, a revision pushed nothing', () => {
    const block = { reason: 'findings' as const, findings: [{ file: 'a.ts', patternName: 'github-token', masked: '[REDACTED-GH]' }] };
    expect(renderSecretBlockComment(block)).toContain('No PR was opened.');
    expect(renderSecretBlockComment(block, 'revision')).toContain('Nothing was pushed to this branch');
    expect(renderSecretBlockComment(block, 'revision')).not.toContain('No PR was opened');
    expect(renderSecretBlockComment({ reason: 'scan-error', message: 'boom' }, 'revision')).toContain('Nothing was pushed to this branch');
  });
});
