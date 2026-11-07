import { describe, expect, it } from 'vitest';
import { taskRefKey } from './taskref';

describe('taskRefKey', () => {
  it('folds a slug-embedded run-record id onto the board id', () => {
    // board mints gh-904; the runner minted gh-owner-repo-904 — both must match.
    expect(taskRefKey('gh-904')).toBe(taskRefKey('gh-owner-repo-904'));
    expect(taskRefKey('gl-5')).toBe(taskRefKey('gl-group-proj-5'));
  });

  it('keeps the trailing issue number, not a digit inside the slug', () => {
    expect(taskRefKey('gh-repo2-904')).toBe('gh-904');
  });

  it('matches linear identifiers exactly (already unique)', () => {
    expect(taskRefKey('linear-dev-639')).toBe('linear-dev-639');
    expect(taskRefKey('LINEAR-DEV-639')).toBe('linear-dev-639');
  });

  it('returns an unrecognized id lowercased', () => {
    expect(taskRefKey('owner/repo#weird')).toBe('owner/repo#weird');
  });
});

it.each([
  ['gh-904', 'gh-904'], ['gh-owner-repo-904', 'gh-904'],
  ['gl-42', 'gl-42'], ['gl-group-proj-42', 'gl-42'],
  ['linear-dev-639', 'linear-dev-639'], ['LINEAR-DEV-639', 'linear-dev-639'], ['Unknown', 'unknown'],
])('core parity: taskRefKey(%s) = %s', (id, expected) => {
  expect(taskRefKey(id)).toBe(expected);
});
