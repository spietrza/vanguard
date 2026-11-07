import { describe, it, expect, vi, afterEach } from 'vitest';
import { otlpSinkConfig, buildTracePayload, exportRunTrace, type RunTrace } from './otlp-sink.js';
import type { StageMetric } from './run-metric.js';

const stage = (over: Partial<StageMetric> = {}): StageMetric => ({
  taskId: 'TES-1',
  stage: 'implementer',
  exitReason: 'completed',
  completed: true,
  turns: 7,
  costUsd: 0.42,
  cacheEfficiency: 0.5,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadInputTokens: 800,
  durationMs: 60_000,
  model: 'claude-sonnet-5-5',
  ...over,
});

const run: RunTrace = {
  taskId: 'TES-1',
  timestamp: '2026-10-16T10:00:00.000Z',
  stages: [stage({ requestedModel: 'sonnet' }), stage({ stage: 'reviewer', completed: false, exitReason: 'maxTurns', durationMs: 30_000 })],
  flow: 'default',
  provider: 'claude',
  prUrl: 'https://github.com/o/r/pull/1',
};

const LANGFUSE = { VANGUARD_OTLP_ENDPOINT: 'https://lf.example/api/public/otel', LANGFUSE_PUBLIC_KEY: 'pk-lf-1', LANGFUSE_SECRET_KEY: 'sk-lf-2' };

function fakeFetch(status: number, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{}', { status });
  }) as typeof fetch;
}

const attr = (span: Record<string, unknown>, key: string): unknown =>
  (span['attributes'] as { key: string; value: Record<string, unknown> }[]).find((a) => a.key === key)?.value;

describe('otlpSinkConfig', () => {
  it('is off without an endpoint, and off with an endpoint but no auth header', () => {
    expect(otlpSinkConfig({})).toBeUndefined();
    expect(otlpSinkConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://lf.example/api/public/otel' })).toBeUndefined();
    expect(otlpSinkConfig({ VANGUARD_OTLP_ENDPOINT: 'https://x', OTEL_EXPORTER_OTLP_HEADERS: 'x-foo=bar' })).toBeUndefined();
    expect(otlpSinkConfig({ VANGUARD_OTLP_ENDPOINT: 'https://x', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: '' })).toBeUndefined();
  });

  it('derives Basic auth and the ingestion-version header from Langfuse keys', () => {
    expect(otlpSinkConfig(LANGFUSE)).toEqual({
      url: 'https://lf.example/api/public/otel/v1/traces',
      headers: { Authorization: `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`, 'x-langfuse-ingestion-version': '4' },
    });
  });

  it('ignores an inherited generic OTEL endpoint + auth header unless VANGUARD_OTEL=1 opts in', () => {
    const inherited = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer corp' };
    expect(otlpSinkConfig(inherited)).toBeUndefined();
    expect(otlpSinkConfig({ ...inherited, VANGUARD_OTEL: 'true' })).toBeUndefined();
    expect(otlpSinkConfig({ ...inherited, VANGUARD_OTEL: '1' })).toEqual({ url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer corp' } });
  });

  it('never sends Langfuse keys to a generic OTEL endpoint, and never overrides an explicit Authorization', () => {
    const optIn = { VANGUARD_OTEL: '1', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    // A host-wide OTEL_EXPORTER_OTLP_ENDPOINT (e.g. Claude Code telemetry) must not receive the Langfuse pair.
    expect(otlpSinkConfig({ ...optIn, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' })).toBeUndefined();
    // ...unless the path is Langfuse's — the path itself, not a substring anywhere in the URL.
    expect(otlpSinkConfig({ ...optIn, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://lf.example/api/public/otel' })?.headers).toHaveProperty('Authorization');
    expect(otlpSinkConfig({ ...optIn, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://lf.example/api/public/otel/v1/traces' })?.headers).toHaveProperty('Authorization');
    expect(otlpSinkConfig({ ...optIn, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.example/?x=/api/public/otel' })).toBeUndefined();
    expect(otlpSinkConfig({ ...optIn, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.example/api/public/otel.attacker/x' })).toBeUndefined();
    expect(otlpSinkConfig({ ...LANGFUSE, VANGUARD_OTEL: '1', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer tok' })?.headers).toEqual({ Authorization: 'Bearer tok', 'x-langfuse-ingestion-version': '4' });
  });

  it('never sends an inherited OTEL_EXPORTER_OTLP_HEADERS to VANGUARD_OTLP_ENDPOINT without VANGUARD_OTEL=1', () => {
    expect(otlpSinkConfig({ VANGUARD_OTLP_ENDPOINT: 'https://x', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer corp' })).toBeUndefined();
    // With Langfuse keys the export runs on those, not on the inherited credential.
    expect(otlpSinkConfig({ ...LANGFUSE, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer corp' })?.headers['Authorization']).toMatch(/^Basic /);
    expect(otlpSinkConfig({ VANGUARD_OTLP_ENDPOINT: 'https://x', VANGUARD_OTLP_HEADERS: 'Authorization=Bearer own' })?.headers).toEqual({ Authorization: 'Bearer own' });
  });

  it('accepts the OTel k=v header list, prefers VANGUARD_* over OTEL_*, and keeps an explicit /v1/traces', () => {
    expect(
      otlpSinkConfig({
        VANGUARD_OTEL: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://other/',
        VANGUARD_OTLP_ENDPOINT: 'https://lf.example/api/public/otel/v1/traces',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20abc, x-langfuse-ingestion-version=4',
      }),
    ).toEqual({
      url: 'https://lf.example/api/public/otel/v1/traces',
      headers: { Authorization: 'Basic abc', 'x-langfuse-ingestion-version': '4' },
    });
  });
});

describe('buildTracePayload', () => {
  it('emits one root span named after the task and one child span per stage', () => {
    const payload = buildTracePayload(run) as { resourceSpans: { resource: unknown; scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s['name'])).toEqual(['TES-1', 'implementer', 'reviewer']);
    const [root, impl, review] = spans as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(root['traceId']).toMatch(/^[0-9a-f]{32}$/);
    expect(root['spanId']).toMatch(/^[0-9a-f]{16}$/);
    expect(impl['traceId']).toBe(root['traceId']);
    expect(impl['parentSpanId']).toBe(root['spanId']);
    expect(review['parentSpanId']).toBe(root['spanId']);
    expect(impl['spanId']).not.toBe(review['spanId']);
    // Deterministic ids: the same run always lands on the same trace.
    expect(buildTracePayload(run)).toEqual(payload);
  });

  it('carries model, tokens, cost, turns and exit reason on each stage span', () => {
    const payload = buildTracePayload(run) as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    const [, impl, review] = payload.resourceSpans[0]!.scopeSpans[0]!.spans as Record<string, unknown>[];
    expect(attr(impl!, 'gen_ai.request.model')).toEqual({ stringValue: 'sonnet' });
    expect(attr(impl!, 'gen_ai.response.model')).toEqual({ stringValue: 'claude-sonnet-5-5' });
    expect(attr(impl!, 'langfuse.observation.model.name')).toEqual({ stringValue: 'claude-sonnet-5-5' });
    expect(attr(impl!, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '1000' });
    expect(attr(impl!, 'gen_ai.usage.output_tokens')).toEqual({ intValue: '200' });
    expect(attr(impl!, 'gen_ai.usage.cache_read_input_tokens')).toEqual({ intValue: '800' });
    expect(attr(impl!, 'gen_ai.usage.cost')).toEqual({ doubleValue: 0.42 });
    expect(attr(impl!, 'vanguard.cost_usd')).toEqual({ doubleValue: 0.42 });
    expect(attr(impl!, 'vanguard.turns')).toEqual({ intValue: '7' });
    expect(attr(impl!, 'vanguard.exit_reason')).toEqual({ stringValue: 'completed' });
    expect(attr(impl!, 'langfuse.observation.type')).toEqual({ stringValue: 'generation' });
    expect(impl!['status']).toEqual({ code: 1 });
    // No requested model → request.model falls back to the served one.
    expect(attr(review!, 'gen_ai.request.model')).toEqual({ stringValue: 'claude-sonnet-5-5' });
    expect(review!['status']).toEqual({ code: 2, message: 'maxTurns' });
  });

  it('puts flow, provider, PR URL and exit reason on every span as Langfuse trace metadata; times lay stages end-to-end', () => {
    const payload = buildTracePayload(run) as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    for (const span of spans) {
      expect(attr(span, 'langfuse.session.id')).toEqual({ stringValue: 'TES-1' });
      expect(attr(span, 'langfuse.trace.metadata.flow')).toEqual({ stringValue: 'default' });
      expect(attr(span, 'langfuse.trace.metadata.provider')).toEqual({ stringValue: 'claude' });
      expect(attr(span, 'langfuse.trace.metadata.pr_url')).toEqual({ stringValue: 'https://github.com/o/r/pull/1' });
      expect(attr(span, 'langfuse.trace.metadata.exit_reason')).toEqual({ stringValue: 'maxTurns' });
    }
    const [root, impl, review] = spans as Record<string, unknown>[];
    const end = Date.parse(run.timestamp);
    const ns = (ms: number): string => `${ms}000000`;
    expect(root!['startTimeUnixNano']).toBe(ns(end - 90_000));
    expect(root!['endTimeUnixNano']).toBe(ns(end));
    expect(impl!['startTimeUnixNano']).toBe(ns(end - 90_000));
    expect(impl!['endTimeUnixNano']).toBe(ns(end - 30_000));
    expect(review!['startTimeUnixNano']).toBe(ns(end - 30_000));
    expect(review!['endTimeUnixNano']).toBe(ns(end));
    expect(root!['status']).toEqual({ code: 2, message: 'reviewer: maxTurns' });
  });
});

describe('exportRunTrace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op without configuration: fetch is never called', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await exportRunTrace(run, { env: {}, fetchImpl: fakeFetch(200, calls) });
    expect(calls).toEqual([]);
  });

  it('POSTs the OTLP JSON payload with the resolved headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await exportRunTrace(run, { env: LANGFUSE, fetchImpl: fakeFetch(200, calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://lf.example/api/public/otel/v1/traces');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/json', 'x-langfuse-ingestion-version': '4' });
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(buildTracePayload(run));
  });

  it('never throws on a failed export and reports it once per process', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const env = { ...LANGFUSE, VANGUARD_OTLP_ENDPOINT: 'https://user:secret@lf.example/api/public/otel' };
    await expect(exportRunTrace(run, { env, fetchImpl: boom })).resolves.toBeUndefined();
    await expect(exportRunTrace(run, { env, fetchImpl: fakeFetch(401) })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('otlp trace export to https://lf.example/api/public/otel/v1/traces failed (non-fatal, reported once): ECONNREFUSED');
  });
});
