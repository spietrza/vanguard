import { createHash } from 'node:crypto';
import type { StageMetric } from './run-metric.js';

/**
 * Opt-in OTLP/HTTP JSON trace export: one trace per run, one span per stage, so Langfuse (or any OTLP
 * collector) becomes the cross-run ledger without Vanguard growing a UI of its own. Hand-rolled on
 * purpose — the payload is the protobuf-JSON form of ExportTraceServiceRequest, a few object literals;
 * the OpenTelemetry SDK would add a dependency tree for nothing.
 *
 * Off unless BOTH an endpoint and an auth header resolve from the env (otlpSinkConfig): then no payload
 * is built and nothing is sent, so a run is byte-identical to before. A failed export is reported once
 * per process on stderr and never fails the run — metrics.jsonl stays the record of truth.
 */

export interface OtlpSinkConfig {
  /** Full traces URL: `<endpoint>/v1/traces`. */
  url: string;
  headers: Record<string, string>;
}

/** One run as handed to the sink: the stage metric records `beginRun().writeStages()` just wrote. */
export interface RunTrace {
  taskId: string;
  /** ISO persist timestamp shared by every stage record of the run; the trace ends here. */
  timestamp: string;
  stages: ReadonlyArray<StageMetric>;
  flow?: string;
  provider?: string;
  prUrl?: string;
}

const LANGFUSE_INGESTION_VERSION = '4';
const EXPORT_TIMEOUT_MS = 10_000;
const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Parse the OTel `k=v,k2=v2` header list (values may be URL-encoded, per the exporter spec). */
function parseHeaderList(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    headers[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return headers;
}

/** True when the URL's path is Langfuse's OTLP endpoint (base or traces URL) — a path check, not a substring one. */
function langfusePath(endpoint: string): boolean {
  try {
    return /\/api\/public\/otel(\/v1\/traces)?$/.test(new URL(endpoint).pathname);
  } catch {
    return false;
  }
}

/**
 * Resolve the exporter from the host env; undefined = disabled (the default).
 *
 * Endpoint: VANGUARD_OTLP_ENDPOINT, else OTEL_EXPORTER_OTLP_ENDPOINT only with VANGUARD_OTEL=1 — the OTLP base
 * (`https://<langfuse>/api/public/otel` for Langfuse); `/v1/traces` is appended unless already there.
 * Auth, one of:
 * - LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY → `Authorization: Basic base64(pk:sk)` plus the
 *   `x-langfuse-ingestion-version: 4` header Langfuse v4 needs for real-time ingestion — attached only
 *   to a Langfuse-shaped endpoint (VANGUARD_OTLP_ENDPOINT, or a path containing `/api/public/otel`),
 *   so a generic OTEL_EXPORTER_OTLP_ENDPOINT on the host never receives Langfuse keys, and never over
 *   an Authorization the header list already carries;
 * - VANGUARD_OTLP_HEADERS, else OTEL_EXPORTER_OTLP_HEADERS — the OTel `k=v,k2=v2` list, which must
 *   carry an `Authorization` entry.
 * An endpoint without auth stays off: OTEL_EXPORTER_OTLP_* are generic names other tooling on the host
 * (Claude Code's own telemetry) may export, and that must not silently start shipping run data.
 */
export function otlpSinkConfig(env: NodeJS.ProcessEnv = process.env): OtlpSinkConfig | undefined {
  const own = env['VANGUARD_OTLP_ENDPOINT'];
  // Explicit opt-in: VANGUARD_OTLP_ENDPOINT, or VANGUARD_OTEL=1 to reuse the generic OTEL_* vars. An
  // inherited OTEL_EXPORTER_OTLP_* pair (endpoint + Authorization header) alone never starts an export.
  if (own === undefined && env['VANGUARD_OTEL'] !== '1') return undefined;
  const endpoint = (own ?? env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '').trim().replace(/\/+$/, '');
  if (endpoint === '') return undefined;
  const headers = parseHeaderList(env['VANGUARD_OTLP_HEADERS'] ?? env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '');
  const pk = env['LANGFUSE_PUBLIC_KEY'];
  const sk = env['LANGFUSE_SECRET_KEY'];
  const langfuseShaped = own !== undefined || langfusePath(endpoint);
  if (langfuseShaped && pk !== undefined && pk !== '' && sk !== undefined && sk !== '') {
    headers['Authorization'] ??= `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`;
    headers['x-langfuse-ingestion-version'] ??= LANGFUSE_INGESTION_VERSION;
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) return undefined;
  return { url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint}/v1/traces`, headers };
}

type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };
const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(Math.round(v)) } });
const dbl = (key: string, v: number): Attr => ({ key, value: { doubleValue: v } });
/** Deterministic id from a seed: the same run exported twice lands on the same trace, never a duplicate. */
const id = (seed: string, bytes: number): string => createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2);
/** Epoch ms → the decimal-string uint64 nanos proto-JSON wants; string concat keeps it exact past 2^53. */
const nanos = (ms: number): string => `${Math.round(ms)}000000`;

/** The protobuf-JSON `ExportTraceServiceRequest` for one run. Exported for tests. */
export function buildTracePayload(run: RunTrace): Record<string, unknown> {
  const traceId = id(`${run.taskId}\n${run.timestamp}`, 16);
  const rootSpanId = id(`${traceId}\nroot`, 8);
  const failed = run.stages.find((s) => !s.completed);
  // Trace-level attributes ride on EVERY span: Langfuse filters/aggregates per observation, so a value
  // only on the root would not be queryable. `langfuse.session.id` = taskId groups the spec run, the
  // implement run and each revise round of one issue into one session.
  const traceAttrs: Attr[] = [
    str('langfuse.session.id', run.taskId),
    str('langfuse.trace.metadata.exit_reason', failed?.exitReason ?? 'completed'),
    ...(run.flow !== undefined ? [str('langfuse.trace.metadata.flow', run.flow)] : []),
    ...(run.provider !== undefined ? [str('langfuse.trace.metadata.provider', run.provider)] : []),
    ...(run.prUrl !== undefined ? [str('langfuse.trace.metadata.pr_url', run.prUrl)] : []),
  ];
  const end = Date.parse(run.timestamp);
  // ponytail: stages carry a duration but no start time — laid end-to-end backwards from the persist
  // timestamp, so gaps between stages (sandbox boot, gates) fold into the stage before them. Record a
  // start time in RunResult if the waterfall ever needs them.
  let cursor = end - run.stages.reduce((sum, s) => sum + s.durationMs, 0);
  const rootStart = cursor;
  const spans = run.stages.map((s, index) => {
    const start = cursor;
    cursor += s.durationMs;
    const name = s.stage ?? 'run';
    const requested = s.requestedModel ?? s.model;
    const served = s.model ?? s.requestedModel;
    return {
      traceId,
      spanId: id(`${traceId}\n${index}\n${name}`, 8),
      parentSpanId: rootSpanId,
      name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(cursor),
      attributes: [
        ...traceAttrs,
        str('langfuse.observation.type', 'generation'),
        ...(requested !== undefined ? [str('gen_ai.request.model', requested)] : []),
        ...(served !== undefined ? [str('gen_ai.response.model', served), str('langfuse.observation.model.name', served)] : []),
        int('gen_ai.usage.input_tokens', s.inputTokens),
        int('gen_ai.usage.output_tokens', s.outputTokens),
        int('gen_ai.usage.cache_read_input_tokens', s.cacheReadInputTokens),
        dbl('gen_ai.usage.cost', s.costUsd),
        dbl('vanguard.cost_usd', s.costUsd),
        int('vanguard.turns', s.turns),
        str('vanguard.exit_reason', s.exitReason),
      ],
      status: s.completed ? { code: STATUS_OK } : { code: STATUS_ERROR, message: s.exitReason },
    };
  });
  const root = {
    traceId,
    spanId: rootSpanId,
    name: run.taskId,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(rootStart),
    endTimeUnixNano: nanos(end),
    attributes: traceAttrs,
    status: failed === undefined ? { code: STATUS_OK } : { code: STATUS_ERROR, message: `${failed.stage ?? 'run'}: ${failed.exitReason}` },
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'vanguard')] },
        scopeSpans: [{ scope: { name: 'vanguard' }, spans: [root, ...spans] }],
      },
    ],
  };
}

let warned = false;

/** Origin + path only: an operator may have put credentials or a token in the URL's userinfo/query. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/**
 * POST one run's trace to the configured sink; no-op when none is configured. Best-effort: a failure
 * (network, non-2xx, 10s timeout) is reported once per process on stderr and never thrown.
 */
export async function exportRunTrace(
  run: RunTrace,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const config = otlpSinkConfig(opts.env);
  if (config === undefined) return;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...config.headers },
      body: JSON.stringify(buildTracePayload(run)),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err: unknown) {
    if (warned) return;
    warned = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`otlp trace export to ${redactUrl(config.url)} failed (non-fatal, reported once): ${message}`);
  }
}
