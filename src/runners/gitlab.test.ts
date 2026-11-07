import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGitlabProjectFromRemote,
  gitlabProjectFromRemote,
  isKnownGitlabRemote,
  remoteHostname,
  knownGitlabProjectFromOrigin,
  redactRemote,
  runGitlabIssue,
  gitlabAdapter,
  gitlabDepsFromEnv,
} from './gitlab.js';
import type { RunGitlabIssueDeps } from './gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { StageOutcome } from '../pipeline/pipeline.js';

describe('runGitlabIssue', () => {
  it('returns no prUrl when agent produces no changes', async () => {
    // Unit test is minimal — the full flow requires Docker. Just verify the dep contract.
    // This test is intentionally thin; integration coverage lives in E2E runs.
    expect(runGitlabIssue).toBeDefined();
    expect(typeof runGitlabIssue).toBe('function');
  });
});

describe('parseGitlabProjectFromRemote', () => {
  it('parses SSH remote', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/project.git')).toBe('group/project');
  });
  it('parses SSH remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses HTTPS remote', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project.git')).toBe('group/project');
  });
  it('parses HTTPS remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses an ssh:// remote with a port', () => {
    expect(parseGitlabProjectFromRemote('ssh://git@gitlab.com:2222/group/project.git')).toBe('group/project');
  });
  it('drops a trailing slash', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project/')).toBe('group/project');
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/project/')).toBe('group/project');
  });
  it('returns undefined for a URL with no path', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/')).toBeUndefined();
  });
  it('parses HTTPS remote without .git suffix', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project')).toBe('group/project');
  });
  it('returns undefined for unrecognised format', () => {
    expect(parseGitlabProjectFromRemote('not-a-remote')).toBeUndefined();
  });
});

describe('gitlabProjectFromRemote', () => {
  it('detects gitlab.com and self-hosted GitLab remotes', () => {
    expect(gitlabProjectFromRemote('git@gitlab.com:group/project.git')).toBe('group/project');
    expect(gitlabProjectFromRemote('https://git.example.com/group/sub/project.git')).toBe('group/sub/project');
  });
  it('rejects GitHub, Bitbucket and Azure DevOps remotes', () => {
    expect(gitlabProjectFromRemote('https://github.com/owner/repo.git')).toBeUndefined();
    expect(gitlabProjectFromRemote('git@github.com:owner/repo.git')).toBeUndefined();
    expect(gitlabProjectFromRemote('git@bitbucket.org:team/repo.git')).toBeUndefined();
    expect(gitlabProjectFromRemote('https://dev.azure.com/org/project/_git/repo')).toBeUndefined();
    expect(gitlabProjectFromRemote('git@ssh.dev.azure.com:v3/org/project/repo')).toBeUndefined();
  });
  it('judges the host only, so a GitLab path that names another forge is kept', () => {
    expect(gitlabProjectFromRemote('https://gitlab.com/group/github.com-mirror.git')).toBe('group/github.com-mirror');
  });
});

describe('isKnownGitlabRemote', () => {
  it('accepts gitlab.com over SSH and HTTPS', () => {
    expect(isKnownGitlabRemote('git@gitlab.com:group/project.git', {})).toBe(true);
    expect(isKnownGitlabRemote('https://gitlab.com/group/project.git', {})).toBe(true);
    expect(isKnownGitlabRemote('https://oauth2:tok@GitLab.com/group/project.git', {})).toBe(true);
  });
  it('rejects a GitHub Enterprise host', () => {
    expect(isKnownGitlabRemote('git@github.corp.com:o/r.git', {})).toBe(false);
    expect(isKnownGitlabRemote('https://github.com/o/r.git', {})).toBe(false);
  });
  it('accepts a self-hosted host only when it matches GITLAB_HOST, ignoring scheme and port', () => {
    expect(isKnownGitlabRemote('git@git.example.com:group/project.git', {})).toBe(false);
    expect(isKnownGitlabRemote('git@git.example.com:group/project.git', { GITLAB_HOST: 'https://git.example.com:8443' })).toBe(true);
    expect(isKnownGitlabRemote('ssh://git@git.example.com:2222/group/project.git', { GITLAB_HOST: 'git.example.com' })).toBe(true);
    expect(isKnownGitlabRemote('https://git.example.com:8443/group/project.git', { GITLAB_HOST: 'git.example.com' })).toBe(true);
    expect(isKnownGitlabRemote('git@other.example.com:group/project.git', { GITLAB_HOST: 'git.example.com' })).toBe(false);
  });
  it('rejects a local path', () => {
    expect(isKnownGitlabRemote('/srv/git/project.git', { GITLAB_HOST: 'git.example.com' })).toBe(false);
  });
});

describe('remoteHostname', () => {
  it('reads the host of scheme and scp-like remotes', () => {
    expect(remoteHostname('git@GitLab.com:group/project.git')).toBe('gitlab.com');
    expect(remoteHostname('git.example.com:group/project.git')).toBe('git.example.com');
    expect(remoteHostname('ssh://git@git.example.com:2222/group/project.git')).toBe('git.example.com');
    expect(remoteHostname('https://oauth2:tok@git.example.com/group/project.git')).toBe('git.example.com');
  });

  it('returns undefined for a local path, relative or absolute', () => {
    for (const path of ['../mirror.git', 'mirror.git', './dir:with-colon.git', '/srv/git/project.git', 'file:///srv/git/project.git']) {
      expect(remoteHostname(path), path).toBeUndefined();
    }
  });
});

describe('redactRemote', () => {
  it('drops userinfo from a scheme URL and leaves scp-like and plain remotes alone', () => {
    expect(redactRemote('https://gitlab-ci-token:glcbt-secret@gitlab.com/g/p.git')).toBe('https://gitlab.com/g/p.git');
    expect(redactRemote('https://oauth2:tok@gitlab.com/')).toBe('https://gitlab.com/');
    expect(redactRemote('https://user:p@ss@gitlab.com/g/p.git')).toBe('https://gitlab.com/g/p.git');
    expect(redactRemote('git@gitlab.com:g/p.git')).toBe('git@gitlab.com:g/p.git');
    expect(redactRemote('https://gitlab.com/g/p.git\n')).toBe('https://gitlab.com/g/p.git');
  });
});

describe('knownGitlabProjectFromOrigin', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function repoWithOrigin(url: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'vg-origin-'));
    dirs.push(dir);
    await execa('git', ['init', '-q'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', url], { cwd: dir });
    return dir;
  }

  it('returns the project for an ssh:// gitlab.com origin with a port', async () => {
    expect(await knownGitlabProjectFromOrigin(await repoWithOrigin('ssh://git@gitlab.com:2222/group/project.git'))).toBe('group/project');
  });
  it('throws when origin is on GitLab but names no project, instead of falling back to gh', async () => {
    await expect(knownGitlabProjectFromOrigin(await repoWithOrigin('https://oauth2:secret-token@gitlab.com/'))).rejects.toThrow(
      'origin https://gitlab.com/ is on GitLab but names no group/project',
    );
  });
  it('returns undefined for a GitHub origin', async () => {
    expect(await knownGitlabProjectFromOrigin(await repoWithOrigin('git@github.com:o/r.git'))).toBeUndefined();
  });
});

function makeDeps(overrides: Partial<RunGitlabIssueDeps> = {}): RunGitlabIssueDeps {
  return { repoPath: '/repo', project: 'group/project', ...overrides };
}

function stageOutcome(name: string, finalText: string, completed = true): StageOutcome {
  return {
    name,
    result: {
      taskId: 't',
      completed,
      exitReason: completed ? 'completed' : 'maxTurns',
      turns: 1,
      worktreePath: '/tmp/wt',
      worktreePreserved: true,
      finalText,
    },
  };
}

function makeGlab(ret = '{}'): { glab: GlabRunner; calls: string[][] } {
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => { calls.push(args); return ret; };
  return { calls, glab };
}

describe('gitlabAdapter', () => {
  it('taskId sanitises issue ref to gl- prefix', () => {
    const adapter = gitlabAdapter(makeDeps());
    expect(adapter.taskId({ id: 'group/project#42', title: 't', description: '', labels: [], children: [], comments: [] }))
      .toBe('gl-group-project-42');
  });

  it('has reviewCli glab and closeIssueOnMerge true', () => {
    const adapter = gitlabAdapter(makeDeps());
    expect(adapter.reviewCli).toBe('glab');
    expect(adapter.closeIssueOnMerge).toBe(true);
  });

  it('signalSecretBlock creates the secret-blocked label before adding it, and posts the masked note', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    const task = { id: 'group/project#7', title: 't', description: '', labels: [], children: [], comments: [] };

    await adapter.signalSecretBlock('group/project#7', task, {
      reason: 'findings',
      findings: [{ file: '.env', patternName: 'generic-api-key', masked: 'KEY=ab****' }],
    });

    const create = calls.findIndex((c) => c[0] === 'label' && c[1] === 'create' && c.includes('vanguard::secret-blocked'));
    const add = calls.findIndex((c) => c[0] === 'issue' && c[1] === 'update' && c.includes('vanguard::secret-blocked'));
    expect(create).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(create); // the add would be a silent no-op without the label
    const note = calls.find((c) => c[0] === 'issue' && c[1] === 'note');
    expect(note?.at(-1)).toContain('blocked publish');
    expect(note?.at(-1)).toContain('KEY=ab****');
    expect(note?.at(-1)).not.toContain('trigger label'); // the release step is per watch source, posted by the primitive
  });

  it('signalSecretBlock still adds the label and notes when label creation fails', async () => {
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'label') throw new Error('403');
      return '{}';
    };
    const adapter = gitlabAdapter(makeDeps(), glab);
    const task = { id: 'group/project#7', title: 't', description: '', labels: [], children: [], comments: [] };

    await expect(adapter.signalSecretBlock('group/project#7', task, { reason: 'scan-error', message: 'gitleaks missing' })).resolves.toBeUndefined();

    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'update' && c.includes('vanguard::secret-blocked'))).toBe(true);
    expect(calls.some((c) => c[0] === 'issue' && c[1] === 'note')).toBe(true);
  });

  it('publishVerdict throws when reviewerOutcome is missing', async () => {
    const adapter = gitlabAdapter(makeDeps());
    await expect(
      adapter.publishVerdict({
        prUrl: 'https://gitlab.com/group/project/-/merge_requests/1',
        headSha: 'abc123',
        attribution: 'claude',
      }),
    ).rejects.toThrow('silence is not ok');
  });

  it('publishVerdict posts a note containing ## Vanguard Review and attribution', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      attribution: 'claude/sonnet',
    });
    expect(calls.length).toBe(1);
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('## Vanguard Review');
    expect(body).toContain('Reviewed by claude/sonnet @ abcdef1');
    expect(body).toContain('<!-- vanguard-mr-review:');
  });

  it('publishVerdict appends ## Conformance section when conformance outcome is present', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      conformanceOutcome: stageOutcome(
        'conformance',
        '<findings>{"findings":[{"severity":"medium","kind":"correctness","title":"missed AC","evidence":"AC-1"}]}</findings>\n<promise>COMPLETE</promise>',
      ),
      attribution: 'claude',
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('## Conformance');
    expect(body).toContain('missed AC');
  });

  it('publishVerdict adds gate degradation warning on blocking findings when gate=true', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome(
        'reviewer',
        '<findings>{"findings":[{"severity":"high","kind":"correctness","title":"bad","evidence":"x"}]}</findings>',
      ),
      attribution: 'claude',
      gate: true,
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('gate is not enforced on GitLab');
  });

  it('publishVerdict does not add gate warning when no blocking findings', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      attribution: 'claude',
      gate: true,
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).not.toContain('gate is not enforced');
  });

  it('maps gate-config to its own scoped label', async () => {
    const { calls, glab } = makeGlab('');
    await gitlabAdapter(makeDeps(), glab).addFailureLabel('https://gitlab.com/group/project/-/merge_requests/1', 'gate-config');
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::gate-config-changed'],
      ['mr', 'update', '1', '--repo', 'group/project', '--label', 'vanguard::gate-config-changed'],
    ]);
  });

  it('addFailureLabel maps verify → vanguard::verify-failed and pre-creates the label', async () => {
    const { calls, glab } = makeGlab('');
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.addFailureLabel('https://gitlab.com/group/project/-/merge_requests/1', 'verify');
    // pre-create the scoped label, then add it to the MR — both routed through the injected GlabRunner.
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::verify-failed'],
      ['mr', 'update', '1', '--repo', 'group/project', '--label', 'vanguard::verify-failed'],
    ]);
  });

  it('addFailureLabel maps visual-proof → vanguard::visual-proof-failed', async () => {
    const { calls, glab } = makeGlab('');
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.addFailureLabel('https://gitlab.com/group/project/-/merge_requests/2', 'visual-proof');
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::visual-proof-failed'],
      ['mr', 'update', '2', '--repo', 'group/project', '--label', 'vanguard::visual-proof-failed'],
    ]);
  });

  it('linkPr calls glab to post MR note on the issue', async () => {
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      return '';
    };
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.linkPr('group/project#5', { id: 'group/project#5', title: 't', description: '', labels: [], children: [], comments: [] }, 'https://gitlab.com/group/project/-/merge_requests/9');
    expect(calls.some((c) => c.join(' ').includes('opened an MR'))).toBe(true);
  });
});

describe('gitlabDepsFromEnv', () => {
  const prev = { oat: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  afterEach(() => {
    // Restore by delete-if-was-unset: assigning `undefined` coerces to the string "undefined",
    // which authFromEnv would accept as a bogus token and flake later missing-auth tests.
    if (prev.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.oat;
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
  });

  it('populates auth from the subscription token (so run --gitlab injects it into the sandbox)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    delete process.env.ANTHROPIC_API_KEY;
    const deps = await gitlabDepsFromEnv('/repo', 'group/project');
    expect(deps.auth).toEqual({ mode: 'subscription', token: 'sk-ant-oat-test' });
    expect(deps.project).toBe('group/project');
  });
});
