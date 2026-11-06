import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStatePath, ensureStateDir } from './state-path.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface RetrospectiveEntry {
  kind: 'failed_run' | 'failed_proof' | 'reviewer_note';
  taskId: string;
  timestamp: string;
  /** Already redacted + truncated, human-readable one-liner or short block. */
  detail: string;
}

export interface RetrospectiveReport {
  entries: RetrospectiveEntry[];
}

export interface BuildOptions {
  /** Max number of entries to keep (most recent first). Default 10. */
  limit?: number;
}

export interface LoadOptions {
  /** Cap the returned markdown to this many bytes. Default 4096. */
  maxBytes?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_BYTES = 4096;
const DETAIL_MAX_CHARS = 300;
const EMPTY_MARKDOWN_BODY = '_No failures or review notes recorded yet._';

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * Mask obvious secrets before they enter memory. Deterministic, no LLM.
 * - Replace long hex/base64-ish tokens (runs of [A-Za-z0-9_\-]{32,}) with ***.
 * - Mask key=value / token: value / Bearer xxx patterns.
 */
export function redact(text: string): string {
  // Mask Bearer tokens
  let result = text.replace(/Bearer\s+[A-Za-z0-9_.~+\-/=]{8,}/g, 'Bearer ***');
  // Mask token/key/secret/password in assignment forms (key=VALUE or key: VALUE)
  result = result.replace(/((?:token|key|secret|password|auth|api[_-]?key)\s*[=:]\s*)([A-Za-z0-9_.~+\-/=]{8,})/gi, '$1***');
  // Mask remaining long hex/base64-ish tokens (32+ chars)
  result = result.replace(/[A-Za-z0-9_\-]{32,}/g, '***');
  return result;
}

function truncate(text: string, maxChars: number = DETAIL_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

// ─── Metrics parsing ─────────────────────────────────────────────────────────

interface FailedRunEvent {
  kind: 'failed_run';
  ts: string;
  taskId: string;
  exitReason: string;
  stage?: string;
  /** Set when the stage was repaired/resumed after the failure (the final exitReason is 'completed'). */
  repairedAfterAttempts?: number;
}

interface FailedVerifyEvent {
  kind: 'failed_proof';
  ts: string;
  taskId: string;
  exitCode: number;
  sha256: string;
}

type MetricEvent = FailedRunEvent | FailedVerifyEvent;

function parseRelevantMetrics(text: string): MetricEvent[] {
  const events: MetricEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.evt === 'run_complete' && typeof parsed.taskId === 'string' && typeof parsed.ts === 'string') {
      const exitReason = typeof parsed.exitReason === 'string' ? parsed.exitReason : '';
      // A multi-attempt stage carries its FIRST exit reason: a truncated-then-repaired implementer is
      // still a failure signal worth remembering, even though the stage ended 'completed'.
      const firstExitReason = typeof parsed.firstExitReason === 'string' ? parsed.firstExitReason : exitReason;
      const attempts = typeof parsed.attempts === 'number' ? parsed.attempts : 1;
      if (firstExitReason !== 'completed') {
        events.push({
          kind: 'failed_run',
          ts: parsed.ts,
          taskId: parsed.taskId,
          exitReason: firstExitReason,
          ...(typeof parsed.stage === 'string' ? { stage: parsed.stage } : {}),
          ...(exitReason === 'completed' && attempts > 1 ? { repairedAfterAttempts: attempts } : {}),
        });
      }
      continue;
    }

    if (parsed.evt === 'verify' && typeof parsed.taskId === 'string' && typeof parsed.ts === 'string') {
      if (parsed.passed === false) {
        events.push({
          kind: 'failed_proof',
          ts: parsed.ts,
          taskId: parsed.taskId,
          exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : -1,
          sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
        });
      }
      continue;
    }
  }
  return events;
}

// ─── Proof loading ────────────────────────────────────────────────────────────

interface ProofFile {
  command?: string;
  exitCode?: number;
  passed?: boolean;
  sha256?: string;
  outputTail?: string;
}

async function loadProof(runsDir: string, taskId: string, ts: string): Promise<ProofFile | null> {
  const sanitized = ts.replace(/[^0-9A-Za-z]/g, '-');
  const proofPath = join(runsDir, taskId, `${sanitized}.proof.json`);
  try {
    const text = await readFile(proofPath, 'utf8');
    return JSON.parse(text) as ProofFile;
  } catch {
    return null;
  }
}

// ─── Reviewer note loading ───────────────────────────────────────────────────

interface ReviewerRecord {
  taskId?: string;
  stage?: string;
  finalText?: string;
  timestamp?: string;
}

/**
 * Strip <promise>...</promise> tags and surrounding whitespace.
 * If what remains is empty or equals 'COMPLETE' (case-insensitive), return null.
 */
function extractReviewerNote(finalText: string): string | null {
  const stripped = finalText.replace(/<promise>[\s\S]*?<\/promise>/gi, '').trim();
  if (stripped === '' || stripped.toLowerCase() === 'complete') return null;
  return stripped;
}

async function loadReviewerNotes(runsDir: string): Promise<RetrospectiveEntry[]> {
  const entries: RetrospectiveEntry[] = [];

  let taskIds: string[];
  try {
    const dirents = await readdir(runsDir, { withFileTypes: true });
    taskIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return entries;
  }

  for (const taskId of taskIds) {
    const taskDir = join(runsDir, taskId);
    let files: string[];
    try {
      files = await readdir(taskDir);
    } catch {
      continue;
    }

    // Only process *-reviewer.json files; ignore .diff and .transcript.log
    const reviewerFiles = files.filter((f) => f.endsWith('-reviewer.json'));

    for (const filename of reviewerFiles) {
      try {
        const text = await readFile(join(taskDir, filename), 'utf8');
        const record = JSON.parse(text) as ReviewerRecord;
        const finalText = record.finalText ?? '';
        const note = extractReviewerNote(finalText);
        if (note === null) continue;

        // The persisted record always carries its own ISO timestamp; '' only as a defensive fallback.
        const timestamp = record.timestamp ?? '';
        entries.push({
          kind: 'reviewer_note',
          taskId: record.taskId ?? taskId,
          timestamp,
          detail: truncate(redact(note)),
        });
      } catch {
        continue;
      }
    }
  }

  return entries;
}

// ─── Core builder ─────────────────────────────────────────────────────────────

/** Read .vanguard/runs artifacts and return a capped, newest-first report. */
export async function buildRetrospectiveMemory(repoPath: string, opts?: BuildOptions): Promise<RetrospectiveReport> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const runsDir = join(repoPath, '.vanguard', 'runs');

  // Read metrics.jsonl
  let metricsText = '';
  try {
    metricsText = await readFile(join(runsDir, 'metrics.jsonl'), 'utf8');
  } catch {
    // File or directory doesn't exist — return empty
  }

  const metricEvents = parseRelevantMetrics(metricsText);

  // Build entries from metric events
  const entries: RetrospectiveEntry[] = [];

  for (const evt of metricEvents) {
    if (evt.kind === 'failed_run') {
      const stagePart = evt.stage !== undefined ? ` [${evt.stage}]` : '';
      entries.push({
        kind: 'failed_run',
        taskId: evt.taskId,
        timestamp: evt.ts,
        detail: `exitReason: ${evt.exitReason}${stagePart}${
          evt.repairedAfterAttempts !== undefined ? ` (completed after ${evt.repairedAfterAttempts} attempts)` : ''
        }`,
      });
    } else if (evt.kind === 'failed_proof') {
      const proof = await loadProof(runsDir, evt.taskId, evt.ts);
      if (proof !== null) {
        const command = redact(proof.command ?? '(unknown command)');
        const exitCode = proof.exitCode ?? evt.exitCode;
        const output = redact(proof.outputTail ?? '');
        const detail = truncate(`command: ${command} | exitCode: ${exitCode} | output: ${output}`);
        entries.push({
          kind: 'failed_proof',
          taskId: evt.taskId,
          timestamp: evt.ts,
          detail,
        });
      } else {
        entries.push({
          kind: 'failed_proof',
          taskId: evt.taskId,
          timestamp: evt.ts,
          detail: `exitCode: ${evt.exitCode} (proof file missing)`,
        });
      }
    }
  }

  // Add reviewer notes
  const reviewerEntries = await loadReviewerNotes(runsDir);
  entries.push(...reviewerEntries);

  // Sort newest-first
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Apply limit
  const limited = entries.slice(0, limit);

  return { entries: limited };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** Section heading label for an entry kind. Exhaustive: a new kind is a compile error here. */
function renderKindLabel(kind: RetrospectiveEntry['kind']): string {
  switch (kind) {
    case 'failed_run':
      return 'FAILED RUN';
    case 'failed_proof':
      return 'FAILED PROOF';
    case 'reviewer_note':
      return 'REVIEWER NOTE';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Render a report to deterministic markdown (pure function of the report — no wall-clock timestamp). */
export function renderRetrospectiveMarkdown(report: RetrospectiveReport): string {
  const lines: string[] = ['# Retrospective Memory', ''];

  if (report.entries.length === 0) {
    lines.push(EMPTY_MARKDOWN_BODY);
    return lines.join('\n');
  }

  for (const entry of report.entries) {
    const kindLabel = renderKindLabel(entry.kind);
    lines.push(`## [${kindLabel}] ${entry.taskId} @ ${entry.timestamp}`);
    lines.push('');
    lines.push(entry.detail);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Refresh + Load ───────────────────────────────────────────────────────────

/** Write pre-rendered markdown to `.vanguard/memory/retrospective.md`. Returns the written path. */
export async function writeRetrospectiveMarkdown(repoPath: string, markdown: string): Promise<string> {
  // Runs on every issue run's `finally`: a repo-committed symlink under `.vanguard` must not
  // redirect this overwrite out of the checkout.
  const memDir = await ensureStateDir(repoPath, join(repoPath, '.vanguard', 'memory'));
  const filePath = join(memDir, 'retrospective.md');
  await assertStatePath(repoPath, filePath);
  await writeFile(filePath, markdown, 'utf8');
  return filePath;
}

/** Build + render + write `.vanguard/memory/retrospective.md`. Returns the written path. */
export async function refreshRetrospectiveMemory(repoPath: string, opts?: BuildOptions): Promise<string> {
  const report = await buildRetrospectiveMemory(repoPath, opts);
  const markdown = renderRetrospectiveMarkdown(report);
  return writeRetrospectiveMarkdown(repoPath, markdown);
}

/** Read `.vanguard/memory/retrospective.md` capped to maxBytes; returns fallback message when absent/empty. */
export async function loadRetrospectiveMemory(repoPath: string, opts?: LoadOptions): Promise<string> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const filePath = join(repoPath, '.vanguard', 'memory', 'retrospective.md');
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return 'No retrospective memory yet.';
  }

  if (content.trim() === '') return 'No retrospective memory yet.';

  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= maxBytes) return content;
  // Walk back to the last valid UTF-8 start byte so we never split a multibyte char.
  let end = maxBytes;
  for (;;) {
    const byte = buf[end];
    if (end <= 0 || byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return buf.slice(0, end).toString('utf8');
}
