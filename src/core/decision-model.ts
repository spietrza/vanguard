/**
 * Minimal client for "decision models" speaking the System One API (Cloudflare Clef on Workers AI,
 * Typesafe Jev, or any self-hosted endpoint with the same contract): structured state + typed
 * questions in, a calibrated probability per allowed answer out, in ~100 ms, no text generation.
 * Used by the log-only difficulty probe, the eval judge and the fork scorer.
 */
import { isIP } from 'node:net';

/** clef over clef-flash: replaying 11 factory probes (2026-10-21) gave Brier 0.05 vs 0.16 — flash was overconfident. */
export const DECISION_MODEL_DEFAULT = 'clef';
/** Workers AI hosts exactly these two; any other name on that route is a typo that would 400 silently. */
const WORKERS_AI_MODELS = new Set(['clef', 'clef-flash']);
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DecisionModelConfig {
  url: string;
  token?: string;
  model: string;
}

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: readonly string[] };

export interface DecisionAnswer {
  type?: string;
  /** noul: probability the answer is yes. */
  noul?: number;
  /** choice: the highest-probability option. */
  choice?: string;
  /** score: probability-weighted level index, 0 = first criterion; can land between levels. */
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  inputTokens?: number;
}

/**
 * Credentials only — the caller decides whether a feature may use them (the probe adds its own
 * explicit switch because it runs unattended on issue text). `model` may be overridden per call site;
 * on the Workers AI route it must be one of the models Cloudflare hosts.
 */
export function decisionModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  model: string = env['VANGUARD_DECISION_MODEL'] ?? DECISION_MODEL_DEFAULT,
): DecisionModelConfig | undefined {
  const url = env['VANGUARD_DECISION_URL'];
  if (url !== undefined && url !== '') {
    const token = env['VANGUARD_DECISION_TOKEN'];
    // Refused, not warned: the state (issue text, diff) and any bearer token would cross the network
    // unencrypted. Loopback, private/Tailscale addresses and dotless LAN names stay allowed.
    if (isPlainHttpOffHost(url)) {
      console.warn(`vanguard: ${PLAIN_HTTP_REFUSED} — disabled`);
      return undefined;
    }
    return { url, model, ...(token !== undefined ? { token } : {}) };
  }
  const account = env['CLOUDFLARE_ACCOUNT_ID'];
  const token = env['CLOUDFLARE_AUTH_TOKEN'];
  if (account === undefined || account === '' || token === undefined || token === '') return undefined;
  if (!WORKERS_AI_MODELS.has(model)) {
    console.warn(`vanguard: decision model "${model}" is not a Workers AI decision model (clef, clef-flash) — disabled`);
    return undefined;
  }
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/cloudflare/${model}`,
    token,
    model,
  };
}

const PLAIN_HTTP_REFUSED = 'VANGUARD_DECISION_URL is plain http on a non-local host; use https (the state and token would travel unencrypted)';

/** http:// to anything but loopback, RFC-1918/Tailscale-style private space, or a dotless LAN name. */
function isPlainHttpOffHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '[::1]' || (!h.includes('.') && !h.startsWith('['))) return false;
    // Private ranges only for an IP literal: a name like `10.attacker.com` resolves wherever its owner wants.
    if (isIP(h) !== 4) return true;
    return !(/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h));
  } catch {
    return false;
  }
}

/** Why decisionModelConfig returned undefined for this model, worded for the operator. */
export function decisionModelMissing(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = env['VANGUARD_DECISION_URL'];
  if (url !== undefined && url !== '' && isPlainHttpOffHost(url)) return `${PLAIN_HTTP_REFUSED}.`;
  const hasCloudflare = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '') !== '' && (env['CLOUDFLARE_AUTH_TOKEN'] ?? '') !== '';
  if ((url === undefined || url === '') && hasCloudflare && !WORKERS_AI_MODELS.has(model)) {
    return `"${model}" is not hosted on Workers AI (clef, clef-flash are); point VANGUARD_DECISION_URL at an endpoint that serves it.`;
  }
  return 'set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AUTH_TOKEN (Workers AI) or VANGUARD_DECISION_URL.';
}

/** Names that select a decision model instead of an LLM wherever a model flag accepts one. */
export function isDecisionModelName(model: string): boolean {
  return model === 'clef' || model === 'clef-flash' || model === 'jev';
}

interface SystemOneBody {
  model?: string;
  answers?: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number };
}
interface SystemOneResponse extends SystemOneBody {
  /** Workers AI wraps the body in `result`; a bare System-One endpoint returns it directly. */
  result?: SystemOneBody | null;
}

/** A finite number, else undefined — answers are unvalidated JSON from an endpoint the operator chose. */
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A probability in [0, 1], else undefined: an endpoint answering on a 0–100 scale must not read as "always yes". */
export const probability = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
};

const RETRY_BACKOFF_MS = 1_000;

export interface DecideOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Names the caller in the one warning line a failed call emits (never the URL: it embeds the account id). */
  label?: string;
  /** Extra attempts on a timeout / network error / 5xx / 429, after a short backoff (not on other 4xx or a malformed body). Default 0. */
  retries?: number;
}

/**
 * Client data (a white-label run's issue text or diff) may reach the decision model only with
 * VANGUARD_DECISION_PROBE=all — one consent switch for every decision-model feature.
 */
export function decisionEgressAllowed(whiteLabel: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !whiteLabel || env['VANGUARD_DECISION_PROBE'] === 'all';
}

interface SystemOneError {
  errors?: Array<{ code?: number; message?: string }>;
}

/** The first error message a Workers AI envelope carries, shortened; never the URL. */
function errorDetail(body: unknown): string {
  const message = (body as SystemOneError | null)?.errors?.[0]?.message;
  return typeof message === 'string' && message !== '' ? `: ${message.slice(0, 160)}` : '';
}

/**
 * One System One call. Never throws: network, non-2xx, timeout, cancel or a malformed body all return
 * undefined after one stderr line (none on cancel), so each caller decides what "no answer" means —
 * the probe logs nothing, a judge fails the case.
 */
export async function decide(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  config: DecisionModelConfig,
  opts: DecideOptions = {},
): Promise<DecisionResult | undefined> {
  const label = opts.label ?? 'decision model';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({ model: config.model, state, questions });
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const retryable = attempt < (opts.retries ?? 0) && opts.signal?.aborted !== true;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token !== undefined ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body,
        signal,
      });
      if (!res.ok) {
        const detail = errorDetail(await res.json().catch(() => null));
        if ((res.status >= 500 || res.status === 429) && retryable) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        console.warn(`vanguard: ${label} failed (HTTP ${res.status}${detail}) — check the decision-model credentials/model`);
        return undefined;
      }
      // A malformed success body is not transient: no retry, just the "no answers" path.
      const parsed = ((await res.json().catch(() => ({}))) ?? {}) as SystemOneResponse & SystemOneError;
      const inner = parsed.result ?? parsed;
      const answers = inner.answers;
      // `typeof null === 'object'` — a `{answers: null}` envelope must not reach the callers' indexing.
      if (answers === undefined || answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
        console.warn(`vanguard: ${label} returned no answers${errorDetail(parsed)} — is the endpoint System-One compatible?`);
        return undefined;
      }
      const inputTokens = num(inner.usage?.input_tokens);
      return {
        model: inner.model ?? config.model,
        answers,
        latencyMs: Date.now() - started,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      };
    } catch (err) {
      if (opts.signal?.aborted === true) return undefined;
      if (retryable) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      console.warn(`vanguard: ${label} failed (${err instanceof Error ? err.name : 'error'})`);
      return undefined;
    }
  }
}
