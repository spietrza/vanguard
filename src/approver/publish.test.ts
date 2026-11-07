import { describe, it, expect } from 'vitest';
import { assertShadowSafeGhArgs, commentDecision, publishCheckRun } from './publish.js';
import type { Decision, DecisionRecord } from './types.js';

const SHA = 'a'.repeat(40);

describe('assertShadowSafeGhArgs (allowlist)', () => {
  it.each([
    ['pr merge', ['pr', 'merge', '1']],
    ['pr review --approve', ['pr', 'review', '1', '--approve']],
    ['pr edit --add-label', ['pr', 'edit', '1', '--add-label', 'x']],
    ['pr ready', ['pr', 'ready', '1']],
    ['pr comment with an extra flag', ['pr', 'comment', '1', '--repo', 'o/r', '--body', 'x', '--edit-last']],
    ['pr view without --repo', ['pr', 'view', '1', '--json', 'number']],
    ['label create', ['label', 'create', 'x']],
    ['issue edit', ['issue', 'edit', '1', '--add-label', 'x']],
    ['graphql mergePullRequest', ['api', 'graphql', '-f', 'query=mutation { mergePullRequest(input: {}) { clientMutationId } }']],
    ['branch merge API', ['api', '--method', 'POST', 'repos/o/r/merges', '-f', 'base=main', '-f', 'head=x']],
    ['ref update', ['api', '--method', 'PATCH', 'repos/o/r/git/refs/heads/main', '-f', `sha=${SHA}`]],
    ['PUT pull merge', ['api', '-X', 'PUT', 'repos/o/r/pulls/1/merge']],
    ['-XPOST attached', ['api', '-XPOST', 'repos/o/r/merges']],
    ['--method= form', ['api', '--method=DELETE', 'repos/o/r/check-runs/1']],
    ['labels path', ['api', 'repos/o/r/issues/1/labels']],
    ['GET-shaped check-runs path with a body turns into POST', ['api', `repos/o/r/commits/${SHA}/check-runs`, '-f', 'name=x']],
    ['the old (list) endpoint as a create', ['api', '--method', 'POST', `repos/o/r/commits/${SHA}/check-runs`]],
    ['two endpoints', ['api', 'repos/o/r/check-runs', 'repos/o/r/merges']],
  ])('refuses %s', (_label, args) => {
    expect(() => assertShadowSafeGhArgs(args)).toThrow(/refusing gh call/);
  });

  it.each([
    ['pr view --json', ['pr', 'view', '1', '--repo', 'o/r', '--json', 'number,reviews']],
    ['pr comment --body', ['pr', 'comment', '1', '--repo', 'o/r', '--body', 'x']],
    ['list check runs (paginated)', ['api', `repos/o/r/commits/${SHA}/check-runs?per_page=100`, '--paginate']],
    ['look up our check run', ['api', `repos/o/r/commits/${SHA}/check-runs?check_name=vanguard%2Fapprover`]],
    ['create a check run', ['api', '--method', 'POST', 'repos/o/r/check-runs', '-f', 'name=vanguard/approver']],
    ['update a check run', ['api', '--method', 'PATCH', 'repos/o/r/check-runs/42', '-f', 'conclusion=neutral']],
  ])('permits %s', (_label, args) => {
    expect(() => assertShadowSafeGhArgs(args)).not.toThrow();
  });
});

describe('publishCheckRun', () => {
  const decision: Decision = { verdict: 'ESCALATE', rulesFired: ['size-lines'], auditSample: { p: 0.1, seed: 's', hit: false }, reviewValid: true };
  const record = {
    headSha: SHA, policyHash: 'sha256:x',
    signals: { files: 1, lines: 200, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: ['a.ts'] },
  } as unknown as DecisionRecord;

  it('creates the run with POST /repos/{o}/{r}/check-runs, not the per-commit list endpoint', async () => {
    const calls: string[][] = [];
    await publishCheckRun(async (args) => {
      calls.push(args);
      return args.includes('--method') ? '{}' : JSON.stringify({ check_runs: [] });
    }, 'o/r', SHA, 7, decision, record);
    const create = calls.find((a) => a.includes('POST'));
    expect(create?.[3]).toBe('repos/o/r/check-runs');
    expect(create).toContain(`head_sha=${SHA}`);
    expect(create).toContain('conclusion=neutral');
    expect(create).toContain(`external_id=7:${SHA}`);
  });

  it('PATCHes the existing run for the same (PR, head SHA)', async () => {
    const calls: string[][] = [];
    await publishCheckRun(async (args) => {
      calls.push(args);
      return args.includes('--method') ? '{}' : JSON.stringify({ check_runs: [{ id: 42, external_id: `7:${SHA}` }] });
    }, 'o/r', SHA, 7, decision, record);
    expect(calls.find((a) => a.includes('PATCH'))?.[3]).toBe('repos/o/r/check-runs/42');
    expect(calls.some((a) => a.includes('POST'))).toBe(false);
  });

  it('throws when GitHub refuses the create instead of swallowing it', async () => {
    const gh = async (args: string[]): Promise<string> => {
      if (args.includes('POST')) throw new Error('HTTP 403: Resource not accessible by integration');
      return JSON.stringify({ check_runs: [] });
    };
    await expect(publishCheckRun(gh, 'o/r', SHA, 7, decision, record)).rejects.toThrow(/403/);
  });
});

describe('commentDecision', () => {
  const decision: Decision = { verdict: 'ESCALATE', rulesFired: [], auditSample: { p: 0, seed: 's', hit: false }, reviewValid: false };
  const record = {
    headSha: SHA,
    signals: { files: 1, lines: 1, testFilesDeleted: 0, testCasesDelta: 0, exportsRemoved: 0, newDependency: false, paths: [] },
  } as unknown as DecisionRecord;
  const marker = `<!-- vanguard-approver: ${SHA} -->`;
  const posted = async (comments: unknown[]): Promise<boolean> => {
    let comment = false;
    await commentDecision(async (args) => {
      if (args[1] === 'comment') comment = true;
      return args[1] === 'view' ? JSON.stringify({ comments }) : '';
    }, 'o/r', 7, decision, record);
    return comment;
  };

  it('dedupes on its own marker from the bot', async () => {
    expect(await posted([{ author: { login: 'github-actions' }, authorAssociation: 'CONTRIBUTOR', body: marker }])).toBe(false);
  });

  it('ignores the marker when an untrusted commenter posted it', async () => {
    expect(await posted([{ author: { login: 'mallory' }, authorAssociation: 'NONE', body: marker }])).toBe(true);
    expect(await posted([{ body: marker }])).toBe(true);
  });
});
