<p align="center">
  <img src="assets/banner.png" alt="Taskcell: self-hosted software factory" width="820" />
</p>

<p align="center">
  <b>Taskcell: a self-hosted software factory.</b><br/>
  It takes tasks from GitHub, GitLab or Linear, builds them with AI agents in a sealed sandbox, and opens pull requests for a human to review.
</p>

<p align="center">
  <a href="https://github.com/spietrza/taskcell/actions/workflows/ci.yml"><img src="https://github.com/spietrza/taskcell/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8B5CF6.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-22D3EE" alt="Node >= 24">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/built%20with-Claude%20Agent%20SDK-D97757" alt="Claude Agent SDK">
  <img src="https://img.shields.io/badge/sandboxed-Docker-2496ED" alt="Docker sandbox">
  <a href="docs/security/owasp-mapping.md"><img src="https://img.shields.io/badge/OWASP%20Agentic%20Top%2010-self--assessed-0F766E" alt="OWASP Agentic Top 10: self-assessed"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/hero-flow-dark.svg" />
    <img src="docs/diagrams/hero-flow-light.svg" width="100%" alt="Taskcell at a glance: a task ticket from GitHub, GitLab, or Linear enters the agent pipeline in a Docker sandbox: plan (a read-only tech spec), implement, review in a fresh context, then the verify gate. Green opens a PR ready for review; red sends the change to repair, at most two rounds, which re-verifies, and if it is still red the PR opens as a draft." />
  </picture>
</p>

## What it is

Taskcell turns a well-written ticket into a reviewed pull request. You label an issue; Taskcell checks that the ticket is clear enough, writes a tech spec if needed, runs a coding agent inside a locked-down Docker container, has a second model review the change, runs your tests, and opens a PR. It runs on your own machine, a server, or GitHub Actions, with your own model subscription or API key. The agent is treated as untrusted: it never holds your repository token, and nothing it writes reaches your repository without passing host-side checks and a human review.

> **Naming.** Taskcell was called Vanguard, and the repository moved from `spietrza/vanguard` to `spietrza/taskcell` (old links redirect). The CLI command (`vanguard`), the `VANGUARD_*` environment variables, the `vanguard:*` labels and the `.vanguard/` directory keep the old name so existing setups keep working. Website: [taskcell.dev](https://taskcell.dev).

## How it works

Every task passes six stations:

1. **Card.** A ticket on GitHub, GitLab or Linear gets a trigger label (`ready for spec` or `ready for agent`) or moves to a trigger state. A deterministic triage check parks vague tickets at `needs info` before any model is called.
2. **Spec.** For `ready for spec`, a read-only planning pass researches the codebase and posts a `<tech_spec>` comment. No code is written.
3. **Sealed cell.** The agent implements the change in a Docker sandbox: non-root, capabilities dropped, no repository token, and optionally no network beyond an allowlist.
4. **Review.** A second model, optionally from another provider, reviews the diff in a fresh context and fixes what it finds, then a simplify pass tidies the change.
5. **Gates.** The host runs your verify command (Proof of Work), an optional conformance check against the spec, and a secret scan of the outgoing diff. A red gate sends the change back for up to two repair rounds.
6. **Pull request.** The host pushes the branch and opens the PR, ready for review when every gate passed and a draft otherwise. A human reviews and merges.

Run it once per ticket with `vanguard run`, or let `vanguard watch` (or the GitHub Actions workflows) pick up labelled tickets on their own. Details: [docs/autonomous-loop.md](docs/autonomous-loop.md) and [docs/architecture.md](docs/architecture.md).

## Quick start

You need Node 24+, pnpm, Docker and a Claude subscription token (`claude setup-token`) or an Anthropic API key.

```bash
git clone https://github.com/spietrza/taskcell && cd taskcell
pnpm install
pnpm build
docker/build.sh                 # builds vanguard-sandbox (node + git + claude + linear CLIs)
```

Check the setup against your target repository, then run one issue:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...      # or ANTHROPIC_API_KEY=...
node dist/cli/index.js doctor --source github --github-repo owner/repo
node dist/cli/index.js run --github owner/repo#123 --repo /path/to/repo --skills ./skills --llm-proxy
```

`--llm-proxy` keeps the model credential in a sidecar and limits the sandbox's network to an allowlist. The examples in the docs call the CLI `vanguard`; `pnpm link --global` puts it on your PATH.

To run the factory from GitHub Actions instead, with no host of your own, follow [docs/onboarding-another-repo.md](docs/onboarding-another-repo.md). For an always-on host, see [docs/deploy.md](docs/deploy.md). For a browser cockpit with a task board, live transcripts and run records, run `pnpm build:ui && pnpm hub --repo /path/to/repo` ([docs/hub.md](docs/hub.md)).

## Task sources and providers

| Task source | How to use it | Review surface |
|---|---|---|
| GitHub Issues | `run --github owner/repo#n`, `watch --source github` or the Actions workflows | Pull request |
| GitHub Projects v2 | `run --project <n>`, `watch --source project` | Pull request |
| GitLab Issues | `run --gitlab group/project#n`, `watch --source gitlab` | Merge request |
| Linear | `run --linear ID`, `watch --source linear` | PR or MR, by the repo's `origin` |

| Provider | `--provider` | Credential |
|---|---|---|
| Claude Code CLI (default) | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| OpenAI Codex CLI | `codex` | `CODEX_API_KEY` / `OPENAI_API_KEY`, or `CODEX_AUTH_JSON` (ChatGPT subscription) |
| Cursor CLI | `cursor` | `CURSOR_API_KEY` |
| z.ai GLM Coding Plan | `zai` | `ZAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Meridian proxy | `meridian` | see [docs/MERIDIAN-provider.md](docs/MERIDIAN-provider.md) |

Any stage can run on a different provider or model: `--review-provider codex` for cross-provider review, `--provider-model`, `--review-model`, `--escalate-model` for a stronger model after a failed repair, and `--fallback-provider` for outages. See [docs/task-sources.md](docs/task-sources.md) and [docs/cli.md](docs/cli.md).

## Security

Taskcell runs coding agents on untrusted input and treats the agent as hostile. These controls sit around it:

- **Sandboxed agent.** The agent runs in a Docker container as a non-root user, with all Linux capabilities dropped except three file-ownership ones, `no-new-privileges`, and memory, CPU and PID limits. Secrets reach it through a file on an in-memory tmpfs, not through command-line arguments.
- **No repository token in the sandbox.** GitHub and GitLab tokens stay on the host. The host, not the agent, pushes the branch and opens the PR.
- **Egress allowlist and LLM proxy.** `--egress` puts the sandbox on an internal network whose only way out is a proxy that allows listed hosts. `--llm-proxy` also keeps the model key in a sidecar and gives the sandbox a per-run nonce.
- **Secret gate on the outgoing diff.** Before anything is pushed, the diff is scanned for secret patterns and for the exact values of credentials injected into the run. A hit pushes nothing.
- **CI config is never copied back.** Changes to `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml` and `.gitlab/**.yml` are dropped, so agent code cannot become CI code.
- **Trust gates on input.** The GitHub Actions workflows only start for allowlisted senders, and `watch` / `watch-prs` skip issues and PRs whose author is neither a repository member nor allowlisted. On GitHub, comments count as instructions only from repository owners, members and collaborators, the issue author, or logins you allowlist with `--feedback-authors`. On Linear, only workspace members count. GitLab has no association model, so set `--feedback-authors` there to make comment trust a boundary; once it is set, comments from unlisted authors are ignored.
- **Humans merge.** Taskcell opens pull requests and never merges them. The approver runs in shadow mode and only records what it would decide.

How these fit together: [docs/security/boundaries.md](docs/security/boundaries.md). How they map to the OWASP Top 10 for Agentic Applications and the OWASP Top 10 for LLM Applications: [docs/security/owasp-mapping.md](docs/security/owasp-mapping.md) (a self-assessment, not a certification). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Documentation

| Page | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Design principles, one run end to end, layers, library use |
| [docs/task-sources.md](docs/task-sources.md) | GitHub, Projects, GitLab and Linear sources |
| [docs/auth.md](docs/auth.md) | Subscription vs API key, local secrets, 1Password |
| [docs/cli.md](docs/cli.md) | Models, providers, decision models, one-shot commands, white-label mode, fork-and-select, sandbox image, cost and limits |
| [docs/autonomous-loop.md](docs/autonomous-loop.md) | Watch loop, routing labels, PR review, GitHub Actions, metrics, approver, retrospective memory, Proof of Work, visual proof |
| [docs/skills.md](docs/skills.md) | Bundled skills, custom skills, per-provider injection |
| [docs/hub.md](docs/hub.md) | The browser cockpit (`vanguard hub`) |
| [docs/onboarding-another-repo.md](docs/onboarding-another-repo.md) | Run the factory on your repo with GitHub Actions |
| [docs/onboarding-linear.md](docs/onboarding-linear.md) | Linear setup |
| [docs/deploy.md](docs/deploy.md) | Always-on host (Docker, Coolify) and garbage collection |
| [docs/approver-policy.md](docs/approver-policy.md) | Approver policy reference |
| [docs/CURSOR-provider.md](docs/CURSOR-provider.md), [docs/MERIDIAN-provider.md](docs/MERIDIAN-provider.md) | Provider guides |
| [docs/security/boundaries.md](docs/security/boundaries.md) | Security boundaries and the host LLM proxy |
| [docs/security/owasp-mapping.md](docs/security/owasp-mapping.md) | OWASP self-assessment |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Contributing

```bash
pnpm install
pnpm typecheck
pnpm test
```

Strict TypeScript, ES modules, Vitest with tests next to the code (`*.test.ts`). Docker integration tests run when Docker is present and skip otherwise. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
