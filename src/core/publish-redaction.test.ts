import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentError, failureReason, formatFailureComment } from './errors.js';
import { redactForPublish } from './secret-scan.js';
import { commentGithubIssue } from '../tasks/github.js';
import { commentGitlabIssue } from '../tasks/gitlab.js';
import { commentLinearIssue } from '../tasks/linear-cli.js';
import { commentPullRequest, postPullRequestReview } from '../runners/pr-review.js';
import { postMergeRequestNote } from '../runners/mr-review.js';
import { replyAndResolveThread } from '../runners/pr-feedback.js';
import { renderStepSummary } from './step-summary.js';
import { selectAgents } from '../agents/registry.js';

// Opaque like a Codex refresh_token: no SECRET_PATTERNS entry matches it, only the exact-value pass can.
const refresh = 'rt_DUMMY8kQ2wZx7Pm4Nv1Lc9Hb3Jt6Ry0Ed5Sa';
const ghToken = `ghp_${'A'.repeat(36)}`;
const agentText = `Review: looks fine. Debug: refresh_token=${refresh} and ${JSON.stringify(refresh)} and ${ghToken}`;

beforeEach(() => {
  vi.stubEnv('CODEX_AUTH_JSON', JSON.stringify({ tokens: { refresh_token: refresh } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A CLI runner that records every argv it is handed and answers ''. */
function recorder(): { calls: string[][]; run: (args: string[]) => Promise<string> } {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]): Promise<string> => { calls.push(args); return ''; } };
}

describe('redactForPublish', () => {
  it('removes injected values first, then token shapes; ordinary text is kept', () => {
    const out = redactForPublish(agentText);
    expect(out).not.toContain(refresh);
    expect(out).not.toContain(ghToken);
    expect(out).toContain('Review: looks fine.');
  });

  it('leaves text without credentials unchanged (control)', () => {
    expect(redactForPublish('No blocking findings. See `src/a.ts:12`.')).toBe('No blocking findings. See `src/a.ts:12`.');
  });
});

describe('failure comments', () => {
  it('formatFailureComment masks the headline and the stack of an agent error carrying raw CLI output', () => {
    const body = formatFailureComment('Vanguard run failed', new AgentError(`Agent exited without a result (exit 1): ${agentText}`));
    expect(body).toContain('Vanguard run failed: AgentError: Agent exited without a result');
    expect(body).toContain('<summary>stack</summary>');
    expect(body).not.toContain(refresh);
    expect(body).not.toContain(ghToken);
  });

  it('formatFailureComment masks a non-Error throw', () => {
    expect(formatFailureComment('Vanguard spec failed', agentText)).not.toContain(refresh);
  });

  it('failureReason masks the operator log line', () => {
    expect(failureReason(new Error(agentText))).not.toContain(refresh);
  });
});

describe('every transport that posts agent text', () => {
  const pr = { repoSlug: 'o/r', number: 7 };
  const cases: Array<[string, (run: (args: string[]) => Promise<string>) => Promise<void>]> = [
    ['GitHub issue comment', (run) => commentGithubIssue('o/r', '#3', agentText, run)],
    ['GitLab issue note', (run) => commentGitlabIssue('g/p', '#3', agentText, run)],
    ['Linear issue comment', (run) => commentLinearIssue('ENG-3', agentText, run)],
    ['PR comment', (run) => commentPullRequest(pr, agentText, run)],
    ['PR review', (run) => postPullRequestReview(pr, agentText, 'request-changes', run)],
    ['MR note', (run) => postMergeRequestNote({ project: 'g/p', iid: 4 }, agentText, run)],
    ['PR thread reply', (run) => replyAndResolveThread('T_1', agentText, run)],
  ];

  it.each(cases)('%s', async (_name, post) => {
    const { calls, run } = recorder();
    await post(run);
    expect(calls.length).toBeGreaterThan(0);
    const argv = JSON.stringify(calls);
    expect(argv).not.toContain(refresh);
    expect(argv).not.toContain(ghToken);
    expect(argv).toContain('Review: looks fine.');
  });
});

describe('the job step summary', () => {
  it('masks the error and note lines', () => {
    const out = renderStepSummary({
      taskId: 'gh-1', flow: 'default', provider: 'codex', outcomes: [], exit: 'error',
      error: `AgentError: Agent exited without a result: ${agentText}`, notes: [`echo ${refresh}`],
    });
    expect(out).toContain('- Error: AgentError: Agent exited without a result');
    expect(out).not.toContain(refresh);
    expect(out).not.toContain(ghToken);
  });
});

describe('a custom provider keyEnv resolved at run start', () => {
  const customKey = 'acme-opaque-key-5532719';

  it('is redacted from a posted comment once selectAgents has run (no run config at the transport)', async () => {
    vi.stubEnv('ACME_PUBLISH_KEY', customKey);
    const { calls, run } = recorder();
    await commentGithubIssue('o/r', '#3', `key ${customKey}`, run);
    expect(JSON.stringify(calls)).toContain(customKey); // control: unknown before the run selects its agents

    const spec = { name: 'acme', baseUrl: 'https://llm.example.com/api', keyEnv: 'ACME_PUBLISH_KEY' };
    selectAgents({ provider: 'acme', customProviders: [{ index: 0, name: 'acme', spec }] }, { ACME_PUBLISH_KEY: customKey });
    const after = recorder();
    await commentGithubIssue('o/r', '#3', `key ${customKey}`, after.run);
    expect(JSON.stringify(after.calls)).not.toContain(customKey);
    expect(formatFailureComment('Vanguard run failed', new Error(customKey))).not.toContain(customKey);
  });
});
