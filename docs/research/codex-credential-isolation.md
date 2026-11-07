# Spike: can the Codex ChatGPT-plan credential stay on the host behind the LLM proxy?

Research only — no production code changed. Answers the questions from issue #585's follow-up spike about keeping `CODEX_AUTH_JSON` (`auth.json`) out of the sandbox the way `--llm-proxy` already keeps the Claude and direct-API-key credentials out.

**Pinned source read**: `docker/Dockerfile:10` sets `CODEX_CLI_VERSION=0.167.0`. The published npm package for that version ships a prebuilt per-platform binary with no bundled source, so the actual logic was read from the upstream `openai/codex` repository at tag `rust-v0.167.0` (the Rust-crate release tag matching `0.167.0`), under `codex-rs/`. All citations below are `<path under codex-rs/>:<line>` at that tag. Today's project code that this spike reasons about: `src/agents/codex.ts:20-42` (current sandbox setup, including the comment already noting that `--llm-proxy` does not apply to ChatGPT-plan auth) and `src/core/secret-scan.ts:236-254` (which already lists `CODEX_AUTH_JSON` and its nested token fields as credentials the publish-time scanner masks).

## Q1 — which hosts does ChatGPT mode call

- **Model requests** default to `login/src/token_data.rs` is unrelated here; the relevant constant is `model-provider-info/src/lib.rs:86`, `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`. `ModelProviderInfo::to_api_provider` (`model-provider-info/src/lib.rs:467-485`) picks this default specifically when the active auth mode is `Chatgpt`, `ChatgptAuthTokens`, `Headers`, `AgentIdentity`, or `PersonalAccessToken` — and falls back to `https://api.openai.com/v1` otherwise — unless the provider's own `base_url` is configured, in which case that value wins unconditionally (same lines).
- **Token refresh** defaults to `https://auth.openai.com/oauth/token` (`REFRESH_TOKEN_URL`, `login/src/auth/manager.rs:230`), unless the stored tokens carry OAuth provenance recording a different issuer (`login/src/auth/manager.rs:1872-1877`, reading `AccountOAuthProvenance` from `login/src/token_data.rs:36-40`) or the override env var below is set.
- **Logout/revoke** defaults to `https://auth.openai.com/oauth/revoke` (`REVOKE_TOKEN_URL`, `login/src/auth/manager.rs:231`), called from `login/src/auth/revoke.rs:135-145`.
- A secondary, opportunistic surface: Agent-Identity bootstrap calls `https://auth.openai.com/api/accounts` in production (`agent-identity/src/lib.rs:41`), reachable from Chatgpt-mode auth when `AgentIdentityAuthPolicy::ChatGptAuth` applies (`login/src/auth/manager.rs:122-128`, `:330-367`). **Needs a manual check**: confirm whether Vanguard's actual invocation (`codex exec --json --sandbox danger-full-access`, `src/agents/codex.ts:45`) ever reaches this path. Check: run one live `codex exec` turn under a real ChatGPT-plan `auth.json`, in front of a logging HTTP proxy that the sandbox is forced through, and read off every distinct host the proxy saw.

## Q2 — can a config key redirect these calls, or is interception needed

No interception needed; all three outbound surfaces above are redirectable through configuration or environment:

1. **Model calls.** `ModelProviderInfo.base_url` (`model-provider-info/src/lib.rs:153`) is honored verbatim once set, overriding the Chatgpt-mode default from Q1 (`model-provider-info/src/lib.rs:484-485`). Separately — and this is the piece that actually matters for keeping the real token out of the sandbox — the *value* placed in the Authorization header is resolved by `resolve_provider_auth` (`model-provider/src/auth.rs:284-308`), which checks `bearer_auth_for_provider` (`model-provider/src/auth.rs:379-388`) **before** ever falling through to the real-credential path (`auth_provider_from_auth`, `model-provider/src/auth.rs:406-423`, which calls `CodexAuth::get_token()` → the real `access_token` out of `auth.json`, `login/src/auth/manager.rs:626-651`). `bearer_auth_for_provider` resolves from either:
   - `provider.env_key` (`model-provider-info/src/lib.rs:522-537`) — a plain sandbox environment variable, exactly the mechanism Vanguard's existing `--llm-proxy` API-key flow already relies on (`src/agents/codex.ts:31-36`); or
   - the documented `model_providers.<id>.auth = { command, args, timeout_ms, refresh_interval_ms, cwd }` external-bearer hook (`protocol/src/config_types.rs:567-585`), implemented by `BearerTokenRefresher` (`login/src/auth/external_bearer.rs:19-64`), which runs a configured command to fetch a bearer value, caches it for `refresh_interval_ms`, and re-runs it on demand.

   Either knob short-circuits the real-token path entirely — so the sandbox's `auth.json` never needs a usable `access_token` for model calls to work.
2. **Refresh.** `CODEX_REFRESH_TOKEN_URL_OVERRIDE` (`login/src/auth/manager.rs:232`, read at `:1872-1877`) redirects the refresh POST to any URL.
3. **Revoke.** `CODEX_REVOKE_TOKEN_URL_OVERRIDE` (`login/src/auth/manager.rs:233`, read at `login/src/auth/revoke.rs:135-145`) redirects logout's revoke call the same way.

Caveat carried into the go/no-go: bypassing the real-token path for model calls still leaves the refresh/revoke *request bodies* carrying whatever string sits in the sandbox's local `auth.json` `refresh_token` field (see Q3) — the override env vars only change the destination, not what gets sent. A sidecar sitting behind that override URL has to do the actual value substitution, the same role the existing proxy sidecar already plays for the nonce-shaped `OPENAI_API_KEY`.

## Q3 — which `auth.json` fields are parsed locally vs. only forwarded, and what happens on expiry

`AuthDotJson` (`login/src/auth/storage.rs:52-70`) wraps `TokenData` (`login/src/token_data.rs:10-34`):

| Field | Parsed locally? | Notes |
|---|---|---|
| `tokens.id_token` | Yes, strictly | Custom deserializer (`login/src/token_data.rs:13-17`, `:215-221`) runs `parse_chatgpt_jwt_claims` (`:189-213`) on every load, which calls `decode_jwt_payload` (`:144-155`) and requires three non-empty, base64url-decodable, dot-separated segments. A malformed `id_token` fails the WHOLE `auth.json` deserialize — the strictest field by far. |
| `tokens.access_token` | Partially | Plain `String`, no custom deserializer (`:20`), so any placeholder string loads without error. It IS parsed locally for its `exp` claim via `parse_jwt_expiration` (`:157-162`, same `decode_jwt_payload`) to decide a *proactive* refresh (`proactive_refresh_reason`, `login/src/auth/manager.rs:3528-3547`). If that parse fails, the code silently falls back to an age-based check instead of erroring (`manager.rs:3542-3547`) — so a non-JWT placeholder is tolerated everywhere except that one exp-based shortcut. |
| `tokens.refresh_token` | No | Plain `String` (`:22`), never decoded; forwarded verbatim as the refresh grant's credential (`request_chatgpt_token_refresh`, `login/src/auth/manager.rs:1774-1792`, forwarding `tokens.refresh_token.clone()`). |
| `tokens.oauth_provenance` | Yes | Issuer/client id read to pick the refresh endpoint and client id (`manager.rs:319-324`, `:1872-1877`). |
| `tokens.account_id`, `tokens.login_owner_id` | Yes | Used for account/workspace matching during a guarded reload before a refresh (`manager.rs:1714-1723`). |
| `last_refresh` | Yes | `DateTime<Utc>`; drives the scheduled-refresh fallback (`manager.rs:221`, constant `TOKEN_REFRESH_INTERVAL = 8` days, checked at `:3543-3547`). |
| top-level `OPENAI_API_KEY` | N/A here | Legacy field on `AuthDotJson` (`storage.rs:57-58`), unused when `auth_mode` is ChatGPT; Vanguard's own `CODEX_AUTH_JSON` doesn't populate it for this mode. |

Expiry behavior: the CLI **refreshes on its own**; it does not simply fail. Two paths:
1. **Proactive** — `AuthManager::auth()` (`login/src/auth/manager.rs:2603-2615`) checks `proactive_refresh_reason` before every use and refreshes first when due.
2. **Reactive** — on a 401 from the backend, an `UnauthorizedRecoveryStep` state machine (`login/src/auth/manager.rs:1983-1990` for the enum, named at `:2123-2129`) walks `Reload → RefreshToken → ExternalRefresh → Done`, retrying the call after each successful step. A hard failure surfaces only once that recovery is exhausted or `classify_refresh_token_failure` (`manager.rs:1829-1850`) marks the refresh-endpoint response as permanent.

## Q4 — refresh-token rotation and reuse detection

Both are real:
- **Rotation.** `persist_tokens` (`login/src/auth/manager.rs:1726-1767`) overwrites the stored `refresh_token` with whatever the refresh response returns (`:1764-1765`); the previous value is discarded on every successful refresh.
- **Reuse detection.** `classify_refresh_token_failure` (`manager.rs:1829-1850`) maps the server error code `refresh_token_reused` to `RefreshTokenFailedReason::Exhausted`, treated as **permanent** (`manager.rs:1844-1850` builds a non-retryable error; the caller at `:157-162` of the same impl records it and stops retrying).

Consequence for the design: the IdP invalidates a refresh token the instant it is exchanged, and flags a second presentation of the now-stale value as reuse. If a sandboxed `codex` process ever held even a stale copy of the real refresh token and raced its own refresh against the host, the loser's attempt would be permanently rejected and force a full re-login. **The host sidecar must be the only party that ever presents the real refresh token to the real endpoint** — exactly what routing refresh calls through `CODEX_REFRESH_TOKEN_URL_OVERRIDE` achieves, provided the sidecar serializes that exchange itself rather than merely relaying the sandbox's own attempt unmodified.

## Q5 — `cnf`/DPoP/mTLS binding, or plain bearer

**Plain bearer.** `TokenData` (`login/src/token_data.rs:10-34`) carries no `cnf`, key-binding, or certificate-thumbprint field, and a search across `login/src`, `model-provider/src`, `model-provider-info/src`, and `core/src` for DPoP, a `cnf` claim, or mTLS/client-certificate binding turns up nothing (the only `client_certificate` hits are an unrelated OpenTelemetry exporter setting, `core/src/otel_init.rs:45,62`). The header itself is built by `BearerAuthProvider::add_auth_headers` (`model-provider/src/bearer_auth_provider.rs:34-41`), which always emits exactly the bearer scheme with the token value and nothing else — no nonce, no signature, no proof-of-possession header. Net: `access_token` and `refresh_token` are each independently usable as a bare credential by anyone who holds them; there is no additional private key or certificate the host sidecar would need to protect beyond the token values themselves.

## Go / no-go

**GO** — config-level redirect through the host LLM proxy. Every outbound surface that matters (model calls, refresh, revoke) is already redirectable via an existing config key or environment variable (Q2); none of it needs TLS interception or a MITM layer, matching how `--llm-proxy` already handles the direct-API-key credential.

What an implementation issue has to add on top of "just set the override knobs," informed by Q3/Q4:

1. **Keep `id_token` JWT-shaped.** The sandbox's `auth.json` must still contain a syntactically valid three-segment `id_token` or the file fails to load at all (Q3). The sidecar can write a reduced or copied placeholder JWT — the claims it carries (email, plan type) aren't secrets and are fine to leave real, reduced, or fake; only the envelope shape is load-bearing.
2. **`access_token`/`refresh_token` can be opaque placeholders.** Neither needs to resemble the real value; `access_token` does not even need JWT shape, since a parse failure there just falls back to the age-based refresh heuristic (Q3).
3. **Route the model call's credential, not just its destination**, using `env_key` or the `auth.command` external-bearer hook (Q2) so the real `access_token` is never read for the Authorization header — set `base_url` alongside it to point the same provider at the sidecar.
4. **Make the sidecar the sole refresher.** Point `CODEX_REFRESH_TOKEN_URL_OVERRIDE` at the sidecar and have it perform the real exchange against `https://auth.openai.com/oauth/token` itself, returning fresh placeholders to the sandbox — never letting the sandbox's own refresh attempt (even with a stale value) reach the real endpoint (Q4).
5. **Re-attach account/workspace routing.** The `chatgpt-account-id` header that the real-credential path attaches automatically (`model-provider/src/auth.rs:421-423`) is skipped once `env_key`/`auth.command` short-circuits that path. The sidecar should re-add it itself (it already has the real `account_id` from the host-held `auth.json`, and that id is not secret) via the provider's `env_http_headers` config knob.
6. Point `CODEX_REVOKE_TOKEN_URL_OVERRIDE` at the sidecar too, so a future `logout`/`logout_with_revoke` path doesn't leak the real refresh token through revoke instead of refresh.

Items that need a live check before implementation, beyond source reading:

- **Agent-Identity bootstrap traffic** (Q1): confirm whether Vanguard's actual `codex exec` invocation ever triggers the `auth.openai.com/api/accounts` surface in practice. Check: one live run under a real ChatGPT-plan `auth.json`, sandbox network forced through a logging proxy, and read off every host contacted.
- **Where the `auth.command` subprocess actually executes** relative to the sandbox's network/filesystem restrictions — relevant to whether a trivial script can reach a host-side sidecar at all from inside `danger-full-access`. Check: configure a throwaway `auth.command` that writes its own environment and a reachability probe to a file, run one `codex exec` turn, and inspect that file from the host afterward.
