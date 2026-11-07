import { describe, expect, it } from 'vitest';
import { classifyAuthor, trustedComments, trustedSpecText, describeIgnoredAuthor } from './comment-trust.js';
import type { Task } from './fetcher.js';

describe('comment trust', () => {
  it('T1: fails closed and honours explicit author trust', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', ' owner ']) expect(classifyAuthor('alice', association)).toBe('association');
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) expect(classifyAuthor('mallory', association)).toBe('untrusted');
    // An absent association is "the provider models none" (GitLab), not "outsider".
    expect(classifyAuthor('mallory', undefined)).toBe('no-association');
    expect(classifyAuthor('Alice', 'NONE', { allowedAuthors: ['ALICE'] })).toBe('allowed');
    expect(classifyAuthor('Alice', undefined, { issueAuthor: 'ALICE' })).toBe('issue-author');
    for (const author of ['foo[bot]', 'github-actions', 'custom']) {
      expect(classifyAuthor(author, 'OWNER', { botLogins: ['CUSTOM'] })).toBe('bot');
    }
    expect(classifyAuthor('mallory-vanguard', 'NONE')).toBe('untrusted');
  });
  it('T2: derives issue author, preserves order and excludes outsider text', () => {
    const task: Task = { id: '1', title: '', description: '', labels: [], children: [], author: 'Alice', comments: [
      { author: 'alice', authorAssociation: 'NONE', body: 'first' }, { author: 'mallory', authorAssociation: 'NONE', body: 'attack' },
      { author: 'maintainer', authorAssociation: 'OWNER', body: 'last' },
    ] };
    expect(trustedComments(task)).toEqual([task.comments[0], task.comments[2]]);
    expect(trustedSpecText(task)).toBe('first\nlast');
  });
  it('T4: an absent association fails closed once an allowlist or bot login is configured', () => {
    expect(classifyAuthor('mallory', undefined, { allowedAuthors: ['maintainer'] })).toBe('untrusted');
    expect(classifyAuthor('mallory', undefined, { botLogins: ['vg-bot'] })).toBe('untrusted');
    expect(classifyAuthor('mallory', undefined, { allowedAuthors: [] })).toBe('no-association');
    expect(classifyAuthor('Maintainer', undefined, { allowedAuthors: ['maintainer'] })).toBe('allowed');
    expect(classifyAuthor('vg-bot', undefined, { botLogins: ['vg-bot'] })).toBe('bot');
    expect(classifyAuthor('reporter', undefined, { allowedAuthors: ['maintainer'], issueAuthor: 'reporter' })).toBe('issue-author');
    // Supplied associations behave as before (GitHub path).
    for (const association of ['', 'NONE']) expect(classifyAuthor('mallory', association, { allowedAuthors: ['maintainer'] })).toBe('untrusted');
    expect(classifyAuthor('alice', 'MEMBER', { allowedAuthors: ['maintainer'] })).toBe('association');
  });
  it('T5: built-in GitHub bot names grant nothing where the provider has no association (GitLab)', () => {
    // Anyone can register `vanguard` or `github-actions` on GitLab; only explicit botLogins count there.
    for (const author of ['vanguard', 'github-actions', 'Vanguard']) {
      expect(classifyAuthor(author, undefined, { allowedAuthors: ['maintainer'] })).toBe('untrusted');
    }
    expect(classifyAuthor('vg-bot', undefined, { botLogins: ['vg-bot'] })).toBe('bot');
    expect(classifyAuthor('github-actions', 'NONE')).toBe('bot'); // GitHub path keeps the built-in names
    expect(classifyAuthor('vanguard', 'NONE')).toBe('untrusted'); // an unclaimed login is no bot
  });
  it('T3: describes known and absent associations', () => {
    expect(describeIgnoredAuthor('mallory', 'NONE')).toBe('@mallory (NONE)');
    expect(describeIgnoredAuthor('mallory', '')).toBe('@mallory (none)');
  });
});
