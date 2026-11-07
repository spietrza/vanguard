# Security boundaries

How the sandbox, proxies and delivery gates fit together. For the OWASP mapping see [owasp-mapping.md](owasp-mapping.md); to report a problem see [SECURITY.md](../../SECURITY.md).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../diagrams/security-dark.svg" />
    <img src="../diagrams/security-light.svg" width="100%" alt="Taskcell security boundary: untrusted issue, PR or MR text from GitHub, GitLab or Linear reaches the host (a CI job or a watch loop), which holds the GitHub or GitLab token. The GitHub Actions workflows first gate on the issue author and the sender; GitLab, Linear and watch-loop runs have no author gate. The host builds the prompt with untrusted tags escaped. The agent CLI runs in a Docker sandbox (non-root, cap-drop ALL, noexec tmpfs) with no GitHub or GitLab token; on a Linear task it gets the Linear API key to read the issue. Changed files come back through copy-back, which drops CI config, then a secret scan; only the host pushes the branch and opens the PR or MR. Opt-in sidecars: an LLM proxy holds the real model key while the agent gets a per-run nonce, and an egress proxy allows CONNECT only to allowlisted hosts (Linear, GitHub, npm, PyPI, plus the model APIs the LLM proxy does not front). On GitHub, the shadow Approver runs as a separate job from the default branch with a write token: it reads its policy (approver.json) from the base branch only and the PR head only as git objects, never checking out or running PR code; its gh calls are allowlisted, and it writes only a decisions.jsonl line on the vanguard-metrics branch, a check and a PR comment." />
  </picture>
</p>

Dashed edges are opt-in: `--llm-proxy` (on in this repo's GitHub Actions review and revise workflows), `--egress`, and the writes of the [shadow Approver](../autonomous-loop.md#approver-shadow-mode) (this repo's GitHub Actions workflow; it never merges, approves or labels). Without the first two the model token sits in the sandbox's noexec tmpfs and egress is open.

One opt-in feature sends data from the host itself: the [difficulty probe](../cli.md#decision-models) (`VANGUARD_DECISION_PROBE=1`) posts issue text to a decision-model endpoint from the host process, so neither the sandbox nor `--egress` and `--llm-proxy` cover it, and it skips white-label runs unless set to `all`. The sandbox is the blast radius, not the host. Secrets reach the sandbox through an in-RAM tmpfs file (POSIX-quoted, never in `docker inspect` or on disk), never via argv. Host subprocesses use argument arrays, never shell strings. `.env` is a template only; no secrets live in the repo. The base image is pinned by digest; SIGINT/SIGTERM destroy live sandboxes and a host concurrency limit caps how many run at once. Generate an image SBOM with `pnpm sbom` (needs syft). `vanguard run --egress` confines the sandbox to an internal docker network whose only route out is a proxy sidecar that tunnels just the allowlist (anthropic/github/linear/registries), so even a process that ignores the proxy has no route out.

`VANGUARD_OWNER_LABEL=<id>` labels every container and network with `vanguard.owner=<id>`, so a CI job can remove its own leftovers: first the containers with `docker ps -aq --filter label=vanguard.owner=<id> | xargs -r docker rm -f`, then the egress network with `docker network ls -q --filter label=vanguard.owner=<id> | xargs -r docker network rm`, which Docker refuses while a container still uses it. `xargs -r` skips the command when nothing matches, so a clean job does not fail its `after_script`.

## Host LLM proxy

`vanguard run --llm-proxy` (also on `watch`) keeps the real Anthropic credential out of the sandbox entirely. A trusted reverse-proxy sidecar holds the credential; the sandbox is handed only a random **per-run nonce** as `ANTHROPIC_AUTH_TOKEN` and points `ANTHROPIC_BASE_URL` at the sidecar. The sidecar validates the nonce, swaps in the real credential (OAuth `Authorization: Bearer` or `x-api-key`), and is the only thing that talks to `api.anthropic.com`.

Just add the flag; the key lives in the host env (never the sandbox) and Docker must be running:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...                       # host key, stays in the sidecar
vanguard run --linear TES-1 --llm-proxy                  # Claude credential held by the sidecar
vanguard watch --label vanguard --llm-proxy              # same, for the watch loop

export ZAI_API_KEY=...                                   # z.ai key, also stays in the sidecar
vanguard run --linear TES-1 --provider zai --llm-proxy   # z.ai credential held by the sidecar
```

The same nonce/sidecar pattern now also covers Codex/OpenAI when Codex is selected with `--llm-proxy`: a separate OpenAI sidecar holds the real OpenAI key, the sandbox gets a nonce as `OPENAI_API_KEY` plus a base URL pointed at that sidecar, and `api.openai.com` is dropped from the sandbox allowlist alongside `api.anthropic.com`. With `--provider zai`, the primary sidecar instead forwards to `api.z.ai` (the z.ai key as a bearer key), `api.z.ai` is dropped from the allowlist, and the sandbox gets the same `ANTHROPIC_BASE_URL`/nonce shape — so the same nonce/sidecar invariant covers z.ai too.

The flag **implies `--egress`** and additionally **removes `api.anthropic.com` from the sandbox's allowlist**, so the sandbox has no direct route to Anthropic — its only path to the model is through the sidecar. The invariant: the real key never enters the sandbox; a leaked nonce is useless beyond the run and never reaches Anthropic. `--llm-proxy` now protects the Claude, Codex/OpenAI, and z.ai provider keys. Cursor is not yet proxied — selecting `cursor` with `--llm-proxy` still injects `CURSOR_API_KEY` directly into the sandbox (a stable Cursor base-url proxy is planned).

See [smoke-tests/codex-openai-proxy.md](../smoke-tests/codex-openai-proxy.md) for the current verification status, a zero-cost negative preflight check, and a controlled live runbook that walks through the Codex/OpenAI proxy preflight and a read-only `review-pr` smoke run when active OpenAI billing is available.

The `review-pr` and `review-mr` commands read code from the change's real base branch and repository instruction files and skills from the repository's default branch. Default-branch guidance applies even when a release branch carries different review rules; an unavailable default branch fails the review.
