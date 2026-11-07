import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';
import { CursorProvider } from './cursor.js';
import { ZaiProvider, ZAI_BASE_URL, ZAI_DEFAULT_MODEL } from './zai.js';
import { OpenRouterProvider, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL } from './openrouter.js';
import { MeridianProvider, MERIDIAN_PLACEHOLDER_TOKEN } from './meridian.js';
import { CustomProvider } from './custom.js';
import { AgentError } from '../core/errors.js';
import { registerInjectedSecretEnvVars } from '../core/secret-scan.js';
import type { AgentProvider } from './provider.js';
import type { CustomProviderEntry } from './custom.js';

/**
 * Real provider keys handed to SECONDARY sidecars (proxy mode) — never injected into the sandbox.
 * Only providers proxied by their own sidecar appear here (Codex → OpenAI sidecar). Providers that ride
 * the PRIMARY sidecar (Zai) are NOT here: their key reaches the sidecar via `auth`, and proxy mode just
 * keeps it out of the sandbox (see providerSecrets + ownsClaudeCliTransport).
 */
export interface ProviderProxySecrets {
  /** Real OpenAI/Codex key, owned by the OpenAI proxy sidecar instead of the sandbox. */
  codex?: string;
}

/**
 * The transport "slot" a provider drives inside the sandbox — the env namespace its CLI authenticates
 * through. Two DIFFERENT providers sharing one slot cannot run in the same sandbox: their env vars
 * collide (a sandbox env holds one ANTHROPIC_BASE_URL, one OPENAI_API_KEY, …). 'claude-cli' is every provider that
 * drives the `claude` CLI — claude itself, and zai/openrouter/meridian/customs, which point that CLI at
 * their own gateway through ANTHROPIC_BASE_URL (the CLI's endpoint variable, not a statement about the
 * vendor behind it). Two of them cannot share an env: the variable holds one URL.
 */
type Transport = 'claude-cli' | 'openai' | 'cursor';

/** How a provider's API key is read from the host and wired into a run. Absent for auth-token providers (Claude). */
interface ProviderKeySpec {
  /** Host env var names to read the key from, in priority order. */
  hostEnv: string[];
  /** The sandbox env secrets the key becomes (the CLI reads these inside the sandbox, normal mode). */
  toSandboxSecrets: (key: string) => Record<string, string>;
  /** When set, in proxy mode the real key is held by a sidecar under this name instead of injected into the sandbox. */
  proxyKey?: keyof ProviderProxySecrets;
  /**
   * Optional credential-file env var that substitutes for the API key (subscription mode). When this host
   * env var is set, its value is forwarded verbatim into the sandbox under the same name and the API-key
   * requirement is waived — Codex on a ChatGPT subscription supplies its auth.json via CODEX_AUTH_JSON,
   * which CodexProvider writes to ~/.codex/auth.json. The credential lives in the sandbox like Claude's
   * CLAUDE_CODE_OAUTH_TOKEN, so --llm-proxy does not apply (Codex talks to OpenAI directly with it).
   */
  subscriptionEnv?: string;
  /**
   * Host→sandbox env passthrough applied in NORMAL mode only (never under --llm-proxy, whose sidecar
   * owns the upstream): when the host env var (the map key) is set, its value is forwarded verbatim into
   * the sandbox under the mapped name. Used to point Codex at a custom OpenAI-compatible endpoint via
   * OPENAI_BASE_URL → VANGUARD_OPENAI_BASE_URL (CodexProvider then writes a config.toml provider for it).
   */
  passthroughEnv?: Record<string, string>;
}

/** Everything the runner needs to know about one provider, in one place. */
interface ProviderSpec {
  /** Construct the provider's AgentProvider (each runs on its own default model). */
  factory: () => AgentProvider;
  /** Sandbox transport slot; distinct providers sharing a slot collide (see Transport). */
  transport: Transport;
  /** API-key wiring; absent when auth is handled by authSecrets instead (Claude). */
  key?: ProviderKeySpec;
  /**
   * When true, the provider owns the Claude CLI transport with its OWN credentials, so the runner must
   * NOT also layer its Anthropic authSecrets (a competing ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
   * would make the Claude CLI prefer api.anthropic.com over this provider's endpoint).
   */
  ownsClaudeCliTransport?: boolean;
  /**
   * When true, the provider cannot run under --llm-proxy: it owns the Claude CLI transport but has no
   * upstream a trusted sidecar could target (it carries only a base URL and authenticates on its own
   * host, e.g. Meridian). Without this guard --llm-proxy would fall the sidecar back to api.anthropic.com.
   */
  directOnly?: boolean;
  /**
   * Which upstream the trusted LLM-proxy sidecar must target when this provider rides the primary
   * Claude CLI transport under --llm-proxy (absent = api.anthropic.com).
   */
  upstream?: 'zai' | 'openrouter';
  /**
   * Model the provider forces when the run doesn't pick one (zai's glm default; a custom entry's
   * `model`). Consumed by forcedProviderModel so callers like the spec generator don't hand a
   * Claude-only model (haiku) to an endpoint that doesn't serve it.
   */
  forcedModel?: string;
  /** Egress-enclave host for a configured endpoint (customs) — appended to the allowlist under --egress. */
  egressHost?: string;
  /** The configured base URL scheme is plain http (customs) — cannot traverse the CONNECT-only enclave. */
  plainHttp?: boolean;
}

/**
 * Single source of truth for every selectable provider. Add a provider here and the CLI surface
 * (PROVIDER_NAMES/isProviderName), construction (makeProvider), the API-key requirement (requiresApiKey),
 * secret routing (providerSecrets), the transport-collision check, and Anthropic-auth suppression all
 * follow from this table — no per-site `if (name === …)` branches.
 *
 * Notes:
 * - Claude has no `key`: it authenticates via authSecrets (subscription token or ANTHROPIC_API_KEY).
 * - Codex authenticates with OPENAI_API_KEY (read from the documented CODEX_API_KEY, or OPENAI_API_KEY).
 * - Zai reuses the Claude CLI against z.ai's Anthropic-compatible endpoint, so it owns the 'claude-cli'
 *   transport: in normal mode its key becomes ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN; in proxy mode
 *   the key is delivered to the primary sidecar via `auth` and withheld from the sandbox (not a secondary
 *   sidecar secret — see ownsClaudeCliTransport in providerSecrets).
 * - OpenRouter is the same pattern as Zai, against OpenRouter's Anthropic-Messages-compatible "skin"
 *   instead of z.ai's endpoint: it also owns the 'claude-cli' transport and rides the primary sidecar.
 */
const PROVIDERS = {
  claude: {
    factory: () => new ClaudeCodeProvider(),
    transport: 'claude-cli',
  },
  codex: {
    factory: () => new CodexProvider(),
    transport: 'openai',
    key: {
      hostEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
      toSandboxSecrets: (key) => ({ OPENAI_API_KEY: key }),
      proxyKey: 'codex',
      // Run Codex on a ChatGPT subscription instead of an API key: CODEX_AUTH_JSON carries auth.json content.
      subscriptionEnv: 'CODEX_AUTH_JSON',
      // Set OPENAI_BASE_URL to run Codex against any OpenAI-compatible endpoint (Responses API) — direct mode only.
      passthroughEnv: { OPENAI_BASE_URL: 'VANGUARD_OPENAI_BASE_URL' },
    },
  },
  cursor: {
    factory: () => new CursorProvider(),
    transport: 'cursor',
    key: {
      hostEnv: ['CURSOR_API_KEY'],
      toSandboxSecrets: (key) => ({ CURSOR_API_KEY: key }),
    },
  },
  zai: {
    factory: () => new ZaiProvider(),
    transport: 'claude-cli',
    ownsClaudeCliTransport: true,
    upstream: 'zai',
    forcedModel: ZAI_DEFAULT_MODEL,
    key: {
      hostEnv: ['ZAI_API_KEY'],
      toSandboxSecrets: (key) => ({ ANTHROPIC_BASE_URL: ZAI_BASE_URL, ANTHROPIC_AUTH_TOKEN: key }),
      // No proxyKey: zai rides the PRIMARY sidecar (key delivered via auth). In proxy mode its key is
      // simply withheld from the sandbox via ownsClaudeCliTransport — not handed to a secondary sidecar.
    },
  },
  openrouter: {
    factory: () => new OpenRouterProvider(),
    transport: 'claude-cli',
    ownsClaudeCliTransport: true,
    upstream: 'openrouter',
    // OpenRouter expects dotted slugs, so a Claude-only name like spec's `haiku` must not reach it.
    forcedModel: OPENROUTER_DEFAULT_MODEL,
    key: {
      hostEnv: ['OPENROUTER_API_KEY'],
      toSandboxSecrets: (key) => ({ ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL, ANTHROPIC_AUTH_TOKEN: key }),
      // No proxyKey: openrouter rides the PRIMARY sidecar, same as zai — see notes above.
    },
  },
  meridian: {
    factory: () => new MeridianProvider(),
    transport: 'claude-cli',
    ownsClaudeCliTransport: true,
    key: {
      // Meridian's base URL is operator-specific (its NAS/host address), so the "key" IS the base URL:
      // it flows through the same api-key slot but expands to ANTHROPIC_BASE_URL + a placeholder token.
      // A vanilla Meridian ignores the token; a keyed Anthropic-compatible proxy (auth required) does not —
      // set MERIDIAN_API_KEY and passthroughEnv overrides the placeholder with the real Bearer token.
      hostEnv: ['MERIDIAN_BASE_URL'],
      toSandboxSecrets: (url) => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: MERIDIAN_PLACEHOLDER_TOKEN }),
      // Applied after toSandboxSecrets, so a set MERIDIAN_API_KEY replaces the placeholder ANTHROPIC_AUTH_TOKEN.
      passthroughEnv: { MERIDIAN_API_KEY: 'ANTHROPIC_AUTH_TOKEN' },
      // No proxyKey: meridian is direct-mode only (no upstream credential to hand a sidecar) — see meridian.ts.
    },
    directOnly: true,
  },
} satisfies Record<string, ProviderSpec>;

/** The BUILT-IN providers selectable everywhere. Selection is by provider, not by model. Order = table order. */
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];
export type ProviderName = keyof typeof PROVIDERS;

/** Repo-configured customs, re-exported so choice-carrying callers need one import. */
export type { CustomProviderEntry } from './custom.js';

/**
 * Upstream the primary LLM-proxy sidecar targets for a REGISTRY key (`'claude'`, `'zai'`, … — what the
 * user types as --provider), not an adapter name; Anthropic unless the table says otherwise.
 */
export function providerUpstream(providerName: string | undefined): 'anthropic' | 'zai' | 'openrouter' {
  if (providerName === undefined || !isProviderName(providerName)) return 'anthropic';
  const spec: ProviderSpec = PROVIDERS[providerName];
  return spec.upstream ?? 'anthropic';
}

/** Narrow an arbitrary string to a BUILT-IN provider name. Customs resolve via resolveSpec instead. */
export function isProviderName(value: string): value is ProviderName {
  return Object.hasOwn(PROVIDERS, value);
}

/**
 * Resolve a provider name to its spec: built-in wins (customs cannot shadow one — the loader
 * error-flags collisions), else a spec synthesized from a healthy custom entry (S6 — a generalized
 * zai: claude CLI against a configured Anthropic-compatible endpoint, key read from `keyEnv`,
 * direct-only). Broken entries throw their recorded error; unknown names list what IS selectable.
 */
function resolveSpec(name: string, customs?: readonly CustomProviderEntry[]): ProviderSpec {
  if (isProviderName(name)) return PROVIDERS[name];
  const entry = customs?.find((e) => e.name === name);
  if (entry?.spec !== undefined) {
    const { baseUrl, keyEnv, model } = entry.spec;
    const custom = entry.spec;
    return {
      factory: () => new CustomProvider(custom),
      transport: 'claude-cli',
      ownsClaudeCliTransport: true,
      directOnly: true,
      ...(model !== undefined ? { forcedModel: model } : {}),
      egressHost: new URL(baseUrl).hostname,
      ...(baseUrl.startsWith('http:') ? { plainHttp: true } : {}),
      key: {
        hostEnv: [keyEnv],
        toSandboxSecrets: (key) => ({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key }),
      },
    };
  }
  if (entry?.error !== undefined) throw new AgentError(entry.error);
  const customNames = (customs ?? []).filter((e) => e.spec !== undefined).map((e) => e.name);
  throw new AgentError(`Unknown provider "${name}". Choose one of: ${[...PROVIDER_NAMES, ...customNames].join(', ')}.`);
}

/** Construct an AgentProvider by name (each runs on its own default model). */
export function makeProvider(name: string, customs?: readonly CustomProviderEntry[]): AgentProvider {
  return resolveSpec(name, customs).factory();
}

/**
 * Model the named provider forces when the run doesn't pick one (zai → glm; a custom's `model`).
 * Undefined for providers that pass the CLI default through.
 */
export function forcedProviderModel(name: string, customs?: readonly CustomProviderEntry[]): string | undefined {
  return resolveSpec(name, customs).forcedModel;
}

/** Options controlling how provider secrets are routed. */
export interface ProviderSecretOptions {
  /** When true (--llm-proxy active), keys for proxyable providers are held back from the sandbox. */
  proxyMode?: boolean;
}

/** Returns true if the named provider requires an explicit API key (i.e. is not auth-token Claude). */
export function requiresApiKey(name: string, customs?: readonly CustomProviderEntry[]): boolean {
  return resolveSpec(name, customs).key !== undefined;
}

/**
 * Host env var(s) a Claude-CLI-transport-owning provider (zai, openrouter, customs) reads its key
 * from, in priority order; undefined for providers that don't own the transport (they use Anthropic
 * authSecrets instead). Lets callers like agentAuthFromEnv resolve a primary-sidecar credential
 * generically instead of hardcoding a per-provider branch.
 */
export function claudeCliKeyEnv(name: string, customs?: readonly CustomProviderEntry[]): string[] | undefined {
  const s = resolveSpec(name, customs);
  return s.ownsClaudeCliTransport === true ? s.key?.hostEnv : undefined;
}

/**
 * Every host env var name a run's providers read a key from, deduped. Fed to the outgoing-secret gate
 * (deliver-change) so a custom provider's repo-configured `keyEnv` — which no static list can name —
 * is checked against the outgoing diff like the built-in credentials are.
 */
export function providerKeyEnvNames(choice: ProviderChoice): string[] {
  return [...new Set(usedProviderNames(choice).flatMap((name) => claudeCliKeyEnv(name, choice.customProviders) ?? []))];
}

/**
 * Collect the API-key secrets for the given providers, read from env and split into two buckets:
 * `sandboxSecrets` (the env vars the providers' CLIs read inside the sandbox) and `proxySecrets` (real
 * keys held by trusted sidecars, never injected into the sandbox). Throws if a selected provider's key
 * is missing — required whether it goes to the sandbox or a sidecar — so a run fails fast at dispatch
 * rather than mid-pipeline. Claude contributes nothing here (covered by authSecrets).
 *
 * Routing, driven entirely by each provider's PROVIDERS spec:
 * - Normal mode: the key is expanded via `toSandboxSecrets` into the sandbox.
 * - Proxy mode + `ownsClaudeCliTransport` (Zai): emit nothing — the key reaches the PRIMARY sidecar via
 *   `auth`, and proxy mode just withholds it from the sandbox.
 * - Proxy mode + `proxyKey` (Codex): the key is routed to `proxySecrets[proxyKey]` for its own SECONDARY
 *   sidecar and kept out of `sandboxSecrets`.
 *
 * Invariant: in proxy mode a provider's real key never lands in `sandboxSecrets` — e.g. proxy-mode Codex
 * keeps `OPENAI_API_KEY` out (→ `proxySecrets.codex`) and proxy-mode Zai withholds its z.ai key entirely.
 */
export function providerSecrets(
  names: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
  customs?: readonly CustomProviderEntry[],
): { sandboxSecrets: Record<string, string>; proxySecrets: ProviderProxySecrets } {
  const sandboxSecrets: Record<string, string> = {};
  const proxySecrets: ProviderProxySecrets = {};
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue; // dedupe (e.g. same provider for both stages)
    seen.add(name);

    const s = resolveSpec(name, customs);
    const { key } = s;
    if (key === undefined) continue; // Claude: auth handled by authSecrets, no key to route here.

    // Subscription mode: a credential FILE substitutes for the API key. When its env var is set we
    // forward it into the sandbox under the same name and waive the API-key requirement — the credential
    // lives in the sandbox like Claude's OAuth token, so proxy mode does not apply. auth.json is usually
    // stored pretty-printed, so collapse it to single-line JSON: the sandbox secret layer rejects any
    // value with a newline. Forward as-is if it is not parseable JSON (the newline guard then catches
    // genuinely malformed input with a clear error).
    if (key.subscriptionEnv !== undefined) {
      const sub = env[key.subscriptionEnv];
      if (sub !== undefined && sub !== '') {
        let value = sub;
        try {
          const parsed: unknown = JSON.parse(sub);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new AgentError(`${key.subscriptionEnv} must be a JSON object (the contents of ~/.codex/auth.json).`);
          }
          value = JSON.stringify(parsed);
        } catch (e) {
          if (e instanceof AgentError) throw e; // a bare scalar/array parsed but is not auth.json — fail at dispatch
          /* not JSON — leave as-is; the sandbox newline guard / codex surfaces it */
        }
        sandboxSecrets[key.subscriptionEnv] = value;
        continue;
      }
    }

    const value = key.hostEnv.map((k) => env[k]).find((v) => v !== undefined && v !== '');
    if (value === undefined) {
      throw new AgentError(`Provider "${name}" needs ${key.hostEnv.join(' or ')} in the environment.`);
    }
    if (opts.proxyMode === true && s.ownsClaudeCliTransport === true) {
      continue; // primary-sidecar provider (zai): key comes via auth; just withhold it from the sandbox.
    }
    if (opts.proxyMode === true && key.proxyKey !== undefined) {
      proxySecrets[key.proxyKey] = value;
    } else {
      Object.assign(sandboxSecrets, key.toSandboxSecrets(value));
      // Normal mode only: forward optional host env (e.g. a custom OpenAI base URL) into the sandbox.
      for (const [hostVar, sandboxVar] of Object.entries(key.passthroughEnv ?? {})) {
        const v = env[hostVar];
        if (v !== undefined && v !== '') sandboxSecrets[sandboxVar] = v;
      }
    }
  }
  return { sandboxSecrets, proxySecrets };
}

/** A run's provider choice: which provider implements, and optionally a different one for review. */
export interface ProviderChoice {
  /** Provider that implements (and, absent reviewProvider, runs every stage). Built-in or a repo
   *  custom name (S6). Default 'claude'. */
  provider?: string;
  /** When set, run only the review stage on this provider (cross-provider review). Built-ins only. */
  reviewProvider?: string;
  /**
   * When set, the implementer stage retries on this provider after the primary one throws an
   * AgentError (outage, usage limit, revoked credential). Built-ins only; must sit on a different
   * transport slot than the implementer (see Transport). The repair loop then resumes on whichever
   * provider actually ran the stage.
   */
  fallbackProvider?: string;
  /**
   * Repo customs (S6), loaded ONCE per entry point from the TARGET repo (cmd.repoPath /
   * params.repoPath) and carried with the choice — registry functions never do IO.
   */
  customProviders?: readonly CustomProviderEntry[];
}

/** Every provider name a run may start: implementer, reviewer, implementer fallback. The one list
 *  behind the credential, egress-host and plain-http checks, so a fallback can never slip past one. */
export function usedProviderNames(choice: ProviderChoice): string[] {
  return [
    choice.provider ?? 'claude',
    ...(choice.reviewProvider !== undefined ? [choice.reviewProvider] : []),
    ...(choice.fallbackProvider !== undefined ? [choice.fallbackProvider] : []),
  ];
}

/** True when the run needs an Anthropic-family credential (subscription token / API key): some used
 *  provider has no key wiring of its own (Claude). Codex/Cursor-only, or Zai/OpenRouter/customs with
 *  their own keys, need none. */
export function needsAnthropicAuth(choice: ProviderChoice): boolean {
  const used = usedProviderNames(choice);
  // Only a provider with no key wiring of its own (Claude) consumes authSecrets. Codex/Cursor bring their
  // own key; Zai/OpenRouter/customs own the Claude CLI transport with theirs. So a Codex-only review needs
  // no Anthropic credential at all (#391) — before, every non-transport-owner demanded one.
  // Sibling of selectAgents' injectAnthropicAuth: that one answers "may the Anthropic auth be layered in"
  // (false only for transport owners), this one "is it required at all".
  return used.some((n) => !requiresApiKey(n, choice.customProviders));
}

/** A resolved choice: the agents to run plus the secrets split into sandbox-safe and proxy-held buckets. */
export interface SelectedAgents {
  agent: AgentProvider;
  /** Present only when reviewProvider was set; pass to withStageProvider to route the review stage. */
  reviewAgent?: AgentProvider;
  /** Present only when fallbackProvider was set; the implementer stage's fallback (withStageFallback). */
  fallbackAgent?: AgentProvider;
  /** Sandbox-safe secrets injected into the sandbox env. */
  secrets: Record<string, string>;
  /** Real provider keys held by trusted sidecars (proxy mode); never injected into the sandbox. */
  proxySecrets: ProviderProxySecrets;
  /**
   * Whether the runner should ALSO layer Anthropic authSecrets (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)
   * into the sandbox. False when any used provider owns the Claude CLI transport with its own credentials
   * (Zai) — a stray Anthropic key would make the Claude CLI hit api.anthropic.com instead of that
   * provider's endpoint. True otherwise (Claude uses it; Codex/Cursor ignore it harmlessly).
   */
  injectAnthropicAuth: boolean;
}

/**
 * Throws when the provider/reviewProvider combination cannot run in one sandbox
 * (shared transport collision, or a reviewer-only primary-sidecar provider under --llm-proxy).
 */
export function validateProviderChoice(choice: ProviderChoice, opts: ProviderSecretOptions = {}): void {
  const provider = choice.provider ?? 'claude';
  const review = choice.reviewProvider;
  const customs = choice.customProviders;
  const specOf = (name: string): ProviderSpec => resolveSpec(name, customs);

  // Two distinct providers sharing one transport slot collide in a single sandbox (shared env namespace,
  // e.g. one ANTHROPIC_BASE_URL — Claude, zai, openrouter, meridian and customs all drive the claude CLI
  // through it). Every pair among implementer, reviewer and implementer-fallback must differ in slot:
  // claude+zai (both 'claude-cli') is the case this rejects.
  const fallback = choice.fallbackProvider;
  const roles: Array<[string, string]> = [
    ...(review !== undefined ? [['cross-provider review', review] as [string, string]] : []),
    ...(fallback !== undefined ? [['implementer fallback', fallback] as [string, string]] : []),
  ];
  for (const [role, other] of roles) {
    if (other !== provider && specOf(other).transport === specOf(provider).transport) {
      const names = [provider, other].sort().map((n) => `"${n}"`).join(' and ');
      throw new AgentError(
        `${role.charAt(0).toUpperCase()}${role.slice(1)} cannot mix ${names}: they share the ${specOf(provider).transport} transport and ` +
          `collide in one sandbox. Use the same provider, or pick providers on different transports.`,
      );
    }
  }
  if (review !== undefined && fallback !== undefined && review !== fallback && specOf(review).transport === specOf(fallback).transport) {
    throw new AgentError(
      `Implementer fallback "${fallback}" and review provider "${review}" share the ${specOf(review).transport} transport and collide in one sandbox.`,
    );
  }
  if (fallback !== undefined && fallback === provider) {
    throw new AgentError(`Implementer fallback "${fallback}" is the implementer itself; pick a different provider or drop --fallback-provider.`);
  }

  // A direct-only provider (meridian, customs) has no upstream a sidecar could target, so --llm-proxy
  // would silently fall the sidecar back to api.anthropic.com. Reject the combination outright.
  if (opts.proxyMode === true) {
    const directOnly = [provider, ...(review !== undefined ? [review] : []), ...(fallback !== undefined ? [fallback] : [])].find((n) => specOf(n).directOnly === true);
    if (directOnly !== undefined) {
      throw new AgentError(
        `Provider "${directOnly}" is direct-mode only and cannot run under --llm-proxy: it authenticates ` +
          `on its own host and exposes no upstream for a trusted sidecar. Run it without --llm-proxy.`,
      );
    }
  }

  // Under --llm-proxy, a provider that owns the Claude CLI transport (zai) is served by the PRIMARY sidecar,
  // whose upstream follows --provider only. So such a provider must BE the implementer; as a reviewer-only
  // it has no sidecar and would silently fall back to the implementer's Anthropic upstream + credential.
  if (opts.proxyMode === true && fallback !== undefined && specOf(fallback).ownsClaudeCliTransport === true) {
    throw new AgentError(
      `Implementer fallback "${fallback}" owns the primary sidecar's transport and cannot be a fallback under --llm-proxy; ` +
        `pick a provider on another transport (e.g. codex) or run without --llm-proxy.`,
    );
  }
  if (opts.proxyMode === true && review !== undefined && review !== provider && specOf(review).ownsClaudeCliTransport === true) {
    throw new AgentError(
      `Cross-provider review with "${review}" under --llm-proxy needs "${review}" as the implementer too ` +
        `(--provider ${review}): it owns the primary sidecar, whose upstream follows --provider. ` +
        `Use --provider ${review}, or run this combination without --llm-proxy.`,
    );
  }
}

/**
 * Resolve every used name, throwing the unknown/broken-provider error without constructing
 * anything. validateProviderChoice alone is NOT this check: its spec lookups live inside the
 * review-pairing and proxy-mode branches, so a bare unknown `--provider bogus` sails through it.
 * Dispatch entry points call this first so the failure precedes every side effect.
 */
export function assertProvidersResolvable(choice: ProviderChoice): void {
  for (const name of usedProviderNames(choice)) {
    resolveSpec(name, choice.customProviders);
  }
}

/**
 * The extra egress-enclave hosts a choice needs under --egress: the configured endpoint host of a
 * used custom (built-ins are already in DEFAULT_EGRESS_ALLOWLIST or sidecar-owned). Pure; computed
 * at dispatch BEFORE the enclave exists (the allowlist is baked into the proxy container at start).
 */
export function customEgressHosts(choice: ProviderChoice): string[] {
  const used = usedProviderNames(choice);
  const hosts = new Set<string>();
  for (const name of used) {
    const host = resolveSpec(name, choice.customProviders).egressHost;
    if (host !== undefined) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Fail fast when a used custom's plain-http endpoint meets the CONNECT-only egress enclave: the
 * proxy 405s non-CONNECT, so the run would hang/403 instead of erroring. http endpoints work
 * without --egress (LAN proxies); the desktop path is always-egress, so there they are CLI-only.
 */
export function assertEgressCompatible(choice: ProviderChoice): void {
  const used = usedProviderNames(choice);
  for (const name of used) {
    if (resolveSpec(name, choice.customProviders).plainHttp === true) {
      throw new AgentError(
        `Provider "${name}" has an http:// endpoint, which cannot traverse the CONNECT-only egress ` +
          `enclave. Run it without --egress, or give it an https:// endpoint.`,
      );
    }
  }
}

/**
 * Whether this choice can run under --llm-proxy at ALL (structural eligibility, not credential
 * availability): false for a direct-mode-only provider (meridian, repo customs) in any of the
 * implementer/reviewer/fallback roles, or for a primary-sidecar-owning provider (zai/openrouter) used
 * as reviewer-only or fallback while a different provider implements — the same combinations
 * `validateProviderChoice({ proxyMode: true })` rejects. Callers that auto-enable the proxy (the hub)
 * use this to decide whether to even attempt it, instead of surfacing the AgentError to the caller.
 *
 * Only proxy-specific ineligibility answers false: everything wrong with the choice REGARDLESS of the
 * proxy — an unknown or broken provider name, a transport collision — still throws, so a caller that
 * reads false and runs direct can never swallow one of those.
 */
export function llmProxySupported(choice: ProviderChoice): boolean {
  assertProvidersResolvable(choice);
  validateProviderChoice(choice, {});
  try {
    validateProviderChoice(choice, { proxyMode: true });
    return true;
  } catch (error) {
    if (error instanceof AgentError) return false;
    throw error;
  }
}

/**
 * Name of the first used provider whose subscription credential (e.g. Codex's CODEX_AUTH_JSON) is set
 * in env, if any. `providerSecrets` forwards that credential into the sandbox verbatim BEFORE it ever
 * consults `opts.proxyMode` (the subscription branch `continue`s first), so --llm-proxy gives it no
 * protection even when active. Callers that auto-enable the proxy (the hub) use this to detect when
 * they must warn instead of silently claiming protection the proxy does not actually provide.
 */
export function subscriptionCredentialProvider(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return usedProviderNames(choice).find((name) => {
    const sub = resolveSpec(name, choice.customProviders).key?.subscriptionEnv;
    if (sub === undefined) return false;
    const value = env[sub];
    return value !== undefined && value !== '';
  });
}

/**
 * Resolve a provider choice into agents + split secrets, shared by every runner. Keeps provider
 * construction, the used-provider set, the transport-collision check, the fail-fast key check, and
 * Anthropic-auth suppression in one place — all derived from the PROVIDERS table (no per-runner copy).
 */
export function selectAgents(
  choice: ProviderChoice,
  env: NodeJS.ProcessEnv = process.env,
  opts: ProviderSecretOptions = {},
): SelectedAgents {
  const provider = choice.provider ?? 'claude';
  const customs = choice.customProviders;
  const used = usedProviderNames(choice);

  validateProviderChoice(choice, opts);
  // Every later publish path redacts a custom provider's key by value, not only the paths handed the run config.
  registerInjectedSecretEnvVars(providerKeyEnvNames(choice));

  const { sandboxSecrets, proxySecrets } = providerSecrets(used, env, opts, customs);
  return {
    agent: makeProvider(provider, customs),
    ...(choice.reviewProvider !== undefined ? { reviewAgent: makeProvider(choice.reviewProvider, customs) } : {}),
    ...(choice.fallbackProvider !== undefined ? { fallbackAgent: makeProvider(choice.fallbackProvider, customs) } : {}),
    secrets: sandboxSecrets,
    proxySecrets,
    injectAnthropicAuth: !used.some((name) => resolveSpec(name, customs).ownsClaudeCliTransport === true),
  };
}
