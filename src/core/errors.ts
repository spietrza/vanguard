import { redactForPublish } from './secret-scan.js';

export class VanguardError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class SandboxError extends VanguardError {}
export class WorktreeError extends VanguardError {}
export class AgentError extends VanguardError {}
export class NotImplementedError extends VanguardError {}
export class StructuredOutputError extends VanguardError {}
export class WorkflowGuardError extends VanguardError {}
/** A host write/delete under `.vanguard` refused because a path component is a symlink (or not a directory). */
export class StatePathError extends VanguardError {}

/** Cap on stack lines carried into an issue comment: enough to name the failing site, short enough to skim. */
const FAILURE_STACK_LINES = 25;

/**
 * Failure text for an issue comment. `String(error)` alone drops the stack, so a bare
 * `TypeError: Cannot read properties of undefined` reaches the reader with no throwing site — the
 * diagnosis then costs a manual hunt through the engine. Carry a trimmed stack in a collapsed
 * block instead. Non-Error throws (strings, rejected non-errors) keep the old one-line shape.
 * Both parts are masked: agent errors embed raw provider stdout/stderr, where a credential can ride along.
 */
export function formatFailureComment(prefix: string, error: unknown): string {
  const headline = redactForPublish(`${prefix}: ${String(error)}`);
  const stack = error instanceof Error ? error.stack : undefined;
  if (stack === undefined || stack.trim() === '') return headline;
  const trimmed = redactForPublish(stack.split('\n').slice(0, FAILURE_STACK_LINES).join('\n'));
  return `${headline}\n\n<details><summary>stack</summary>\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n</details>`;
}

/** Cap on the error excerpt carried in a one-line operator log entry. */
const FAILURE_REASON_MAX_CHARS = 200;

/**
 * One-line, redacted excerpt of an error for operator logs — those land in CI job output, which is
 * world-readable on a public repo, and agent errors embed raw provider stdout/stderr (codex, cursor)
 * where a key could ride along. Injected credentials and token shapes masked, then whitespace collapsed and capped.
 */
export function failureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = redactForPublish(raw).replace(/\s+/g, ' ').trim();
  return line.length > FAILURE_REASON_MAX_CHARS ? `${line.slice(0, FAILURE_REASON_MAX_CHARS)}…` : line;
}

/**
 * Normalise a raw thrown value into a user-visible VanguardError: an existing VanguardError passes
 * through untouched; anything else is wrapped with the first non-empty line of its message — where
 * CLIs like gh/glab/git put the actionable text. Shared by the board and repo-file read paths.
 */
export function visibleError(error: unknown): VanguardError {
  if (error instanceof VanguardError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new VanguardError(message.split('\n').find((l) => l.trim() !== '') ?? message);
}
