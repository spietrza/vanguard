# Auth and local secrets

This page covers the Claude credential. Every other provider brings its own key (`CODEX_API_KEY`, `CODEX_AUTH_JSON`, `CURSOR_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`); see [Providers](cli.md#providers).

## Claude: subscription or API key

Subscription is the default and draws on your Claude plan's usage allowance (no per-token charge — the same pool as interactive Claude Code). The API key is the alternative and bills the Developer Platform per token. Taskcell injects exactly one secret into the sandbox, so billing is unambiguous.

Taskcell runs Claude headless via `claude -p` (`claude --print --output-format stream-json`, see `src/agents/claude-code.ts`). Billing is decided purely by which auth env var is set, not by the CLI mode — `claude -p` consumes the same plan usage as the interactive CLI.

```bash
claude setup-token            # once, generates the subscription token
CLAUDE_CODE_OAUTH_TOKEN=...    # subscription (default)
ANTHROPIC_API_KEY=...          # API billing instead
```

See `.env.example`. `authFromEnv()` prefers the subscription token; `authSecrets(auth)` maps the choice to the single env var the sandbox receives.

**Two modes, no third.** Subscription (`CLAUDE_CODE_OAUTH_TOKEN`) draws on your plan's usage; API key (`ANTHROPIC_API_KEY`) bills per token on platform.claude.com. There is no separate credit pool for `claude -p` / Agent SDK usage — Anthropic announced one for 2026-06-15 but postponed it (the 2026-05 announcement was reversed), so headless runs keep consuming normal plan usage exactly like interactive Claude Code.

## Local secrets (two ways)

Taskcell reads everything from env vars (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN`). Locally, populate them however you like:

**Plain env / `.env`:**

```bash
cp .env.example .env && $EDITOR .env       # fill in the keys (gitignored)
set -a; . ./.env; set +a                    # load into the shell
node dist/cli/index.js watch --label vanguard --repo . --skills ./skills
```

**1Password (`op`), no plaintext on disk** — read each secret inline per run, so it never lands in a file or shell history:

```bash
LINEAR_API_KEY=$(op read "op://Personal/Linear API/credential") \
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Personal/Claude OAuth/credential") \
  node dist/cli/index.js run --linear TES-1 --repo . --skills ./skills
```

`op` (1Password CLI) needs `op signin` or the desktop app integration; its sessions can expire between calls, so prefer reading the secrets in the same command that uses them. On a server there is no 1Password — see [deploy.md](deploy.md#auth-subscription-not-api-credit).
