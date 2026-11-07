# CLI reference

Detailed reference for the `vanguard` CLI: models, providers, decision models, one-shot commands, fork-and-select, the sandbox image, and cost. Run `vanguard --help` for the full flag list.

## Models

Choose the model per stage with `model` (`'opus'`, `'sonnet'`, `'haiku'`, or a full id), and reasoning depth with `effort`. Two presets:

- `fastStages()` - a single low-effort `haiku` pass: cheap and quick, still on the subscription via the CLI.
- `planImplementReviewStages()` - plan on `opus` (high effort, emits a `<plan>`), then implement and review on `sonnet`. The capable model plans; the cheaper one executes.

Runs reuse the session and keep a stable prompt prefix to maximize Anthropic prompt caching; `RunResult.cacheEfficiency` reports the cached fraction of input tokens.

The canonical pipeline is implement → review → simplify. The reviewer reviews for correctness **and** over-engineering (the ponytail minimalism lens — would less code do the job?), so the third simplify pass is often redundant. Pass `--no-simplify` (on `run`/`watch`) for a lean implement → review run that skips it.

An optional **conformance pass** can be appended after the reviewer with `--conformance` (on `run`/`watch`; opt-in, default off, GitHub/Linear only). It runs a fresh, report-only stage that checks the final diff against the spec's Acceptance Criteria for unmet criteria, scope drift, and silently dropped requirements; its findings post to the PR and gate the merge alongside the reviewer's. It is report-only — it never edits files (`copyBack:false`). `--conformance-model <m>` sets the model for that stage; it defaults to the implementer/`--provider-model` model, so **pass `--conformance-model opus` to run the check on a planner-tier model** (the headline use case).

By default `run` uses the implement → review → simplify pipeline (the implementer plans inline). Pass `--plan` to prepend a dedicated planning stage (opus, high effort) that emits a `<plan>` for the implementer to follow — the plan → implement → review pipeline. Combine with `--review-model opus` to also review on the planner-tier model:

```bash
vanguard run --github o/r#1 --plan --review-model opus   # plan on opus, implement on sonnet, review on opus
```

## Providers

The agent behind each stage is a swappable `AgentProvider`: `claude` (Claude Code CLI, default), `codex` (OpenAI Codex CLI), `cursor` (Cursor CLI; see [CURSOR-provider.md](CURSOR-provider.md)), `zai` (z.ai GLM Coding Plan), `openrouter` (OpenRouter's Anthropic skin), or `meridian` (self-hosted [Meridian](https://github.com/rynfar/meridian) proxy — share a Claude Max subscription from another host; see [MERIDIAN-provider.md](MERIDIAN-provider.md)). Selection is **by provider, not by model** — each provider runs on its own default model. Two modes:

**One provider does everything** (default)

```bash
vanguard run --linear TES-1                 # Claude implements + reviews + simplifies
vanguard run --linear TES-1 --provider codex # Codex runs every stage
vanguard run --linear TES-1 --provider zai   # z.ai GLM runs every stage (ZAI_API_KEY)
```

**Cross-provider review** (opt-in) — the implementer stays on the main provider while only the review stage runs on an independent one, so a different model family catches different classes of bugs:

```bash
vanguard run    --linear TES-1 --provider claude --review-provider codex
vanguard watch  --label vanguard --provider codex --review-provider claude
```

**Per-stage model** (independent of provider) — `--provider-model <m>` sets the model for the implementer/simplifier stages and `--review-model <m>` for the review stage; each defaults to the provider's own default model. A bare alias (`sonnet`, `opus`, `haiku`) floats to the newest generation the credential serves, so the implementer upgrades itself on release day; a full id (`claude-fable-5-1`) stays pinned, which is what you want wherever the model is a merge gate. `vanguard stats` records both the requested and the served name, so an alias upgrade shows as the new id, while a gateway substituting a different family shows as `served (requested X)`. `--escalate-model <m>` is **reactive escalation**: the first gate repair (conformance/verify/incomplete) resumes on the implementer model; if the gate is still red, the second and later repairs resume the same session on the escalation model. Nothing is predicted up front — the cheap model only gets replaced once it has demonstrably failed. The one up-front call is yours: label an issue `vanguard:model=<m>` (e.g. `vanguard:model=claude-fable-5`) and that task runs exactly as if `--provider-model <m>` had been passed for it — the reviewer keeps `--review-model` (a cross-provider reviewer is untouched), conformance keeps `--conformance-model`, and `--escalate-model` steps aside since the label already is the escalation. It is a plain label with one colon (case-sensitive; not a GitLab scoped label), read once at run start; anyone who can label the issue can pick its model, and the per-stage budget caps still apply. Works on GitHub, GitLab and Linear (labels fetched over GraphQL). On `--provider cursor` the model values are Cursor's own: an Auto mode (`auto-intelligence`, `auto-balance`, `auto-cost`) or a Cursor id from `agent models`. The Claude aliases map onto the matching Auto mode. See [CURSOR-provider.md](CURSOR-provider.md#choosing-a-model).

```bash
vanguard run --linear TES-1 --provider-model opus --review-model haiku   # plan/implement big, review cheap
vanguard run --linear TES-1 --provider-model sonnet --conformance --conformance-model opus   # implement on sonnet, check conformance on opus
vanguard run --linear TES-1 --provider-model sonnet --review-model claude-fable-5-1 --escalate-model claude-fable-5-1   # cheap implement on the current Sonnet; a 2nd failed gate repair escalates to a pinned top model
vanguard run --github o/r#1 --commit-author "Your Name <you@example.com>"   # commit authored as you
```

`--provider` / `--review-provider` / `--provider-model` / `--review-model` work the same on `run` and `watch`. The simplifier stays on the main provider. Each non-Claude provider brings its own key, forwarded into the sandbox **only when that provider is selected**: `CODEX_API_KEY` for codex, `CURSOR_API_KEY` for cursor, `ZAI_API_KEY` for zai (a missing key fails fast at dispatch, not mid-run). Under `--llm-proxy` the Codex/OpenAI key **and** the z.ai key are held by a trusted sidecar instead of the sandbox (see [Host LLM proxy](security/boundaries.md#host-llm-proxy)); Cursor's key is still injected directly (not yet proxied). Claude auth is the baseline (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), but a run whose providers are all Codex/Cursor consumes none of it, so `watch-prs --provider codex` needs no Anthropic credential in direct mode; `--llm-proxy` still needs one for the primary sidecar. The sandbox image ships the `claude` and `codex` CLIs; the Cursor CLI is opt-in (`CURSOR_CLI_VERSION=<version> ./docker/build.sh`), and cursor reports tokens but no cost, so budget caps do not bind it — see [CURSOR-provider.md](CURSOR-provider.md).

Codex does not read its key straight from the environment: `CodexProvider` runs `codex login --with-api-key` (the key piped from `OPENAI_API_KEY` inside the sandbox, never on the command line) before `codex exec`. Under `--llm-proxy` Codex is instead configured (via `~/.codex/config.toml`) to use a custom OpenAI-compatible provider pointed at the trusted sidecar, reading only the per-run nonce from `OPENAI_API_KEY` (no `codex login`, and the real key never enters the sandbox). Either way, the OpenAI account behind the key must have active billing — without it `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.

**Codex on a ChatGPT subscription (no API key).** Set `CODEX_AUTH_JSON` to the contents of a `~/.codex/auth.json` produced by `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`, OAuth tokens, no API key). The runner forwards it verbatim into the sandbox, where `CodexProvider` writes it to `~/.codex/auth.json` (0600) and skips login — `codex exec` then runs on the subscription and self-refreshes the access token via the embedded refresh token. This works like Claude's `CLAUDE_CODE_OAUTH_TOKEN`: the credential lives in the sandbox, so `--llm-proxy` does not apply to it (and `CODEX_AUTH_JSON` takes precedence over `CODEX_API_KEY`/`OPENAI_API_KEY` when both are set). Solid for local and long-running host use; on ephemeral CI the stored token must carry a valid refresh token, and an API key is the sturdier choice there. Example: `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)" vanguard run --linear TES-1 --provider codex`.

**Custom OpenAI-compatible endpoint.** To run Codex against any endpoint that speaks the OpenAI **Responses** API (a self-hosted vLLM, OpenRouter, Together, a gateway, …) instead of `api.openai.com`, set `OPENAI_BASE_URL` on the host. The runner forwards it into the sandbox as `VANGUARD_OPENAI_BASE_URL`, and `CodexProvider` writes a `~/.codex/config.toml` provider pointed at it (`wire_api = "responses"`), sending your key from `OPENAI_API_KEY`/`CODEX_API_KEY` as the bearer token:

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1   # must include the /v1 path (OpenRouter's Responses API is in beta)
export OPENAI_API_KEY=sk-...                           # the key your endpoint expects
vanguard run --linear TES-1 --provider codex --provider-model <model-the-endpoint-serves>
```

Constraints: (1) the endpoint must implement the OpenAI **Responses** API (`/v1/responses`) — Codex no longer speaks `/chat/completions`; (2) this is **direct mode only** — it is ignored under `--llm-proxy`, whose sidecar always targets `api.openai.com` (point the sidecar elsewhere by changing the proxy upstream, not this var); (3) with `--egress` the endpoint's host must be in the allowlist, otherwise run without `--egress` so the sandbox can reach it directly. `CODEX_AUTH_JSON` (subscription) takes precedence — set `OPENAI_BASE_URL` only in the API-key path.

**z.ai (GLM Coding Plan).** `--provider zai` reuses the in-sandbox Claude Code CLI, pointed at z.ai's Anthropic-Messages-compatible coding endpoint (`https://api.z.ai/api/coding/paas/v4`) with the GLM model family (default `glm-5.2`). It needs **no Anthropic token** — set `ZAI_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the z.ai key is held by the primary trusted sidecar (forwarding to `api.z.ai` as a bearer key) and the sandbox gets only the per-run nonce. (z.ai's endpoint is OpenAI-compatible too, but the Codex CLI dropped `wire_api = "chat"` support, so the Claude-CLI route is the supported one.)

**OpenRouter.** `--provider openrouter` follows the same pattern as z.ai, pointed at OpenRouter's Anthropic-Messages-compatible "skin" (`https://openrouter.ai/api`) with a dotted OpenRouter slug as the model (default `anthropic/claude-sonnet-4.6`; override with `--provider-model`). It needs **no Anthropic token** — set `OPENROUTER_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the OpenRouter key is held by the primary trusted sidecar (forwarding to `openrouter.ai` as a bearer key) and the sandbox gets only the per-run nonce. **Recommended:** in your OpenRouter account, pin **Anthropic 1P** as the top-priority provider for Claude models — the Claude Code CLI expects Anthropic-1P behaviour, and this is an account-level provider-selection preference, not something the run can set per-request.

## Decision models

**Decision model vs LLM judge — what Clef is and is not.** A decision model (Cloudflare [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), Typesafe Jev — the second only through a Typesafe or self-hosted endpoint via `VANGUARD_DECISION_URL`) does not replace Haiku, Sonnet or any generating model: it cannot write code, a review or a sentence. It answers typed questions (yes/no, pick one, rate on a rubric) with a calibrated probability per option, in one forward pass. It overlaps with an LLM only where Taskcell asks for a *decision* — the eval judge, the fork scorer, the difficulty probe — and nowhere else. Side by side, for those roles:

| | LLM judge (Haiku default, any `--judge-model`) | Decision model (`clef-flash` / `clef`) |
|---|---|---|
| Output | Markdown with a `<verdict>{passed, score, reason}</verdict>` JSON blob that must parse | A probability per allowed answer; nothing to parse |
| `score` means | The model's self-rated 0..1 quality | P(acceptable); `passed` = P ≥ 0.5 |
| Calibration | Not calibrated; "0.8" is a feeling | Trained for calibrated probabilities (vendor claim; not yet measured on this corpus) |
| Latency per decision | Seconds (a one-shot agent run) | ~40 ms (`clef-flash`) to ~200 ms (`clef`) on Workers AI, vendor-measured |
| Cost per decision | Full LLM tokens, incl. the reasoning it writes | $0.09 / M input tokens, no output tokens |
| Context | Model-dependent (hundreds of K) | 64K tokens on Workers AI; 16K on a self-hosted `vllm-jev` |
| Can explain itself | Yes, the `reason` field is prose | No; the reason is just the numbers |
| Can do the task itself | Yes (it is the same kind of model as the implementer) | No |
| Where it leaves the host | Through the sandbox / `--llm-proxy` / `--egress` | Host-side HTTP to the endpoint; white-label runs need `VANGUARD_DECISION_PROBE=all` |
| Verified in this repo | Yes, the default path | Live on Workers AI since 2026-10-07 (probe, `eval --judge-model clef-flash`, `--fork-scorer decision`) |

To compare them on the corpus, run `vanguard eval --json` twice (default judge, then `--judge-model clef-flash`) and diff the pass rates per kind — that, not the vendor table, is the number that would justify switching the default.

**Difficulty probe (experimental, log-only).** Decision models answer typed questions with calibrated probabilities in milliseconds instead of generating text; Taskcell talks to them through one client speaking the System One API. Two are known to it: Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) — the one in use, on Workers AI's free tier — and Typesafe's Jev, which Cloudflare does not host and which has not been exercised here. Opt in with `VANGUARD_DECISION_PROBE=1` plus credentials: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AUTH_TOKEN` (Workers AI; `VANGUARD_DECISION_MODEL` is `clef`, the default, or `clef-flash`), or `VANGUARD_DECISION_URL` [+ `VANGUARD_DECISION_TOKEN`] pointing at any System-One-compatible endpoint, which is also the only way to run `jev` (a Typesafe endpoint or a self-hosted `vllm-jev`). The probe uses one model and one endpoint per run — `VANGUARD_DECISION_MODEL` picks it, there is no ensemble (`eval --judge-model` and `--fork-scorer` take their own model argument, which overrides it). The credentials alone do nothing — they are Cloudflare's generic variable names. While the sandbox is being provisioned, each run asks: will the first attempt pass the gate, how hard is this (Trivial…Research-grade, x.5 rounds up), is the spec clear? The answer is logged (`decision_probe` line in `metrics.jsonl`, one console line) and **changes nothing** about routing. After enough runs, `vanguard stats` prints a `PROBE` table of predicted vs observed first-try rate per predicted level, one pair per run — if they track, the probe earns the right to set `vanguard:model=` automatically; if not, unset the switch. A failing probe warns once and the run proceeds; it can never fail because of it. **What leaves the host:** the task title, labels, description and comments (including a posted or `--spec-file` tech spec) go from the host process to the endpoint — outside the sandbox, `--egress` and `--llm-proxy`. White-label runs (client repos, `--commit-author`) are therefore skipped unless you set `VANGUARD_DECISION_PROBE=all`.

**What switching the decision model on gives you.** Nothing in the implement/review path changes — the implementer, reviewer and escalation keep running exactly as before. What you get:

- **A difficulty signal before every run, for free.** Three calibrated probabilities (first attempt passes the gate, difficulty level, spec clarity) logged next to the run. Today it only observes; once `vanguard stats`' `PROBE` table shows the prediction tracking the observed repair rate, it can start setting `vanguard:model=` automatically — the predictive routing that is deliberately not built on guesswork.
- **A judge that is fast, cheap and parse-free.** `vanguard eval --judge-model clef-flash` returns a probability per case in ~0.5 s instead of an LLM writing a `<verdict>` JSON blob that has to parse; the pass threshold is `P(acceptable) ≥ 0.5`, not a model's self-rating. Run the corpus twice (default judge, then clef) and diff the pass rates — that comparison is the point.
- **A fork scorer that compares like with like.** `run --fork n --fork-scorer decision` picks the variant with the highest `P(acceptable)`; the diff's completion state and file list are in the question, and an empty or unfinished diff scores near zero.
- **A second opinion where parsing used to fail.** Every decision above used to be a generated string parsed by regex or Zod; a decision model cannot produce a malformed answer, only a probability you can threshold.

What it does not give you: text. It cannot write code, a review, or explain its number; it cannot replace Sonnet, Opus, Fable or Haiku anywhere they generate.

**Decision model quick start (Cloudflare Workers AI, free tier).** Workers AI includes 10,000 Neurons a day at no charge; `clef`, the default, costs 21,818 Neurons per million input tokens, so a factory probe (~7–8k tokens of issue and spec) uses ~165 Neurons — about 60 runs a day for free. `clef-flash` is ~6× cheaper (3,455 Neurons per million) but, replayed on 11 factory probes, was markedly overconfident (Brier 0.16 vs 0.05 for `clef`); pick it with `VANGUARD_DECISION_MODEL=clef-flash` when volume outgrows the free tier.

1. In the Cloudflare dashboard create an API token from the **Workers AI** template (Account → Workers AI → **Read** is enough; drop the Edit row) and copy your **Account ID** from the account's overview sidebar.
2. Export the credentials outside any dotfiles repo (Taskcell reads the process environment, not `.env`), and switch the probe on:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=…   # 32 hex chars
   export CLOUDFLARE_AUTH_TOKEN=…   # the token, shown once
   export VANGUARD_DECISION_PROBE=1
   ```
   For the GitHub Actions factory, add the same two values as repository secrets, pass them to the reusable workflow under `secrets:`, and set `decision-probe: true` on the caller (off by default, see [onboarding](onboarding-another-repo.md)).
3. Run anything. The probe logs one line per run and `vanguard stats` grows a `PROBE` table; `vanguard eval --judge-model clef-flash` and `run --fork 3 --fork-scorer decision` use the same credentials.

What a live call looks like (recorded 2026-10-07, `clef-flash`, 485 input tokens, 518 ms):

```
vanguard: spietrza/taskcell#999 difficulty probe (clef-flash, 518ms): first-try 0.58, difficulty 1.59/4, spec clear 0.79
```

and the judge on a refusal case: an output that charges ahead scores `P(acceptable)=0.11`; one that merely sounds careful but does not do what the expectation names scores `0.48` — the judge reads the expectation, not the tone. The fork scorer gives a small, tested diff `0.91` and an empty diff `0.03`.

## One-shot commands and white-label mode

The commit is authored `Vanguard <vanguard@local>` by default; override with `--commit-author "Name <email>"` (git's standard form) to attribute the work to yourself. The PR itself is opened by whichever account owns the push token (`VANGUARD_PUSH_TOKEN`/`GH_TOKEN`), independent of the commit author.

**White-label mode.** Passing `--commit-author` also switches Taskcell to deliver a plain, human-looking PR — the "Vanguard" branding (PR text still uses the old name) is dropped everywhere it would reach the remote:

- Branch becomes `feat/<issue-number>-<hash>` (e.g. `feat/904-9d414a3d`) instead of `chore/vanguard-…`.
- The PR body is just the `Closes #N` / `Part of #N` line — no "Automated implementation … by Vanguard" attribution and no `## Proof of work` block.
- No Taskcell review comment is posted on the PR, and no "opened a PR" comment is posted back on the issue.
- The commit message is Conventional-Commits-safe — `feat: <lower-case subject> (#N)`, header ≤100 chars — so a target repo's `commitlint` passes.

`vanguard research` honours the same switch: with `--commit-author` its comment heading drops "Vanguard" (`## Research` instead of `## Vanguard Research`) and uses a neutral hidden marker — the author value is unused there since research never commits.

**One-shot spec pass.** `vanguard spec <owner/repo#n> --repo <path> [--spec-model <m>] [--commit-author <a>]` runs the same tech-spec generator the watch loop uses (`techSpecStage`: read-only codebase research, `<tech_spec>` output) as a single CLI step — **no labels are read or written**. The spec is posted as an issue comment; `--commit-author` white-labels the heading (`Tech spec:` instead of `Vanguard tech spec:`). Recognition is keyed on the `<tech_spec>` tag, so triage and the conformance manifest treat both headings identically. Pair it with `vanguard run` on the same issue once the spec looks right — e.g. spec on a planner-tier model, then implement on a cheaper one (`--provider-model`) with the review pinned back on the planner tier (`--review-model`).

**Fully local spec (no tracker trace).** Add `--out <file>` to `vanguard spec` to write the spec to a local file instead of posting any comment, then feed it back with `vanguard run … --spec-file <file>`: the file is injected into the fetched task as a virtual comment, so the implementer prompt, triage, and the conformance manifest read it exactly like a posted spec — but the only public artifact of the whole pipeline is the PR itself. `--spec-file` is single-issue only (rejected with `--parent`/`--project` fan-out); make sure `.vanguard/` is gitignored in the target repo so the spec never rides along in a commit.

**Standalone PR review — to the tracker or to a file.** `vanguard review-pr <owner/repo#n> --repo <path> [--review-model <m>]` reviews an existing PR (an adversarial pass, larger budget on retry) and posts the verdict as a PR comment. Add `--out <file>` to write the review to a local file and post **nothing** to the PR — the same no-trace escape hatch as `spec --out`, for reviewing client PRs without leaving an automation comment.

The `review-pr` and `review-mr` commands read code from the change's real base branch and repository instruction files and skills from the repository's default branch. Default-branch guidance applies even when a release branch carries different review rules; an unavailable default branch fails the review.

**Address human review feedback.** `vanguard revise-pr <owner/repo#n> --repo <path> [--review-model <m>] [--max-rounds <n>]` reads the human review threads + comments on a bot PR, applies fixes, pushes to the PR branch, and replies to + resolves each addressed thread. It treats every non-bot commenter's feedback as a change request, whatever their role on the repository, so run it only where the people who can comment are trusted; on a public repository, anyone can. Unlike `review-pr` (which *produces* a review), `revise-pr` *consumes* one. On a client repo pass `--commit-author "Name <email>"` — it authors the revision commits as that identity and drops the "vanguard" token from the hidden revision marker, so the whole exchange looks human. Prefer to inspect before anything touches the PR? `--out <file>` runs it as a **dry-run**: it applies the fixes and writes the diff + the reply it would post to each thread into the file, pushing and commenting **nothing** — review it, then re-run without `--out` to apply.

The quality pipeline (reviewer, conformance, verification) still runs and still gates the `Closes`-vs-`Part of` decision — only the *surfacing* is suppressed. Default (no `--commit-author`) keeps the full branding and review comment. Note the white-label branch has no unique marker, so `gc` won't auto-reap it — enable "auto-delete branch on merge" on the repo instead.

**Base branch.** By default Taskcell branches off `main` and targets the PR at `main`. Pass `--base <branch>` (e.g. `--base dev`) to branch off and open the PR against a different base — the diff is then computed against, and the PR merges into, that branch.

## Fork-and-select

`run --fork <n>` runs the implementer stage `n` times (each variant forks the same base, on a worktree reset between runs), scores each variant's diff, and keeps the best one before the review/simplify stages continue. Scoring is an LLM verdict produced by a one-shot run of the same provider in a throwaway `/tmp` cwd (the diff is supplied in the prompt, so the scorer never touches the worktree) — or, with `--fork-scorer decision`, a [decision model](#decision-models) (`clef-flash` on Workers AI or any System-One endpoint): `P(acceptable)` for each diff in ~100 ms, a calibrated probability instead of a model's self-rated JSON, with no verdict parsing to fail. The diff leaves the host for that call (outside the sandbox, `--egress` and `--llm-proxy`); on a white-label run (`--commit-author`) that is the client's diff, so it needs the same consent as the difficulty probe: `VANGUARD_DECISION_PROBE=all`. Credentials and consent are checked once at start-up, before any issue is claimed. Use it to trade tokens for quality on hard tasks:

```bash
vanguard run --linear TES-1 --fork 3
```

## Keeping the sandbox image current

`docker/Dockerfile` pins the Claude CLI that ships inside `vanguard-sandbox:latest`. The pin moves with the repo; a built image does not. A stale CLI does not fail loudly — it fails *mid-run*, against the model gateway, after the sandbox is up and the prompt is rendered. One such drift answered every request with `API Error: 400 This session advanced while the request was waiting`, which reads like a gateway or session bug and is neither.

So every sandbox start reads `claude --version` out of the container and refuses to continue when it predates the pin. `vanguard doctor` reports the same thing as a `sandbox claude cli` check.

To repair it:

```bash
vanguard doctor --fix
```

This installs the pinned CLI into the existing image and re-runs the checks. It does **not** rebuild — a rebuild also re-downloads the linear-cli release tarball, which is exactly what a corporate MITM proxy breaks, and updating the CLI alone goes through a plain npm install. The original `USER` and `WORKDIR` are read from the image and restored, because `docker commit` snapshots the *container's* config: commit a root container without restoring them and the image starts running as root, at which point the CLI refuses to launch at all.

A full rebuild still works where the network allows it:

```bash
CLAUDE_CLI_VERSION=2.1.260 ./docker/build.sh
```

The check is deliberately **not** an auto-update. Refreshing an image needs the network at run start and rewrites an image that concurrent sandboxes share — on the machines where this drift actually bites, the build is itself the unreliable step, so doing it automatically would turn a rare manual command into a recurring mid-run failure. `VANGUARD_SKIP_IMAGE_CHECK=1` bypasses the gate if you are deliberately running an older image.

`VANGUARD_SANDBOX_IMAGE` overrides the image name used everywhere the sandbox runs (main sandbox, preflight, and the llm-proxy/egress sidecars) — set it to an image ID (`sha256:...`) in CI so a job pins the exact image it just built instead of the mutable `vanguard-sandbox:latest` tag, which another pipeline on a shared Docker host could overwrite between build and run.

## Cost and limits

Two cost dimensions: **GitHub Actions minutes** (only when you run via Actions) and **model usage**.

**GitHub Actions minutes.** A run builds Taskcell + the sandbox image, then runs the pipeline — about **15-20 minutes per run** on `ubuntu-latest`.
- **Public repos: unlimited.** GitHub bills no Actions minutes for public repositories, so the Actions path has no minute ceiling there.
- **Private repos: 2000 min/month** on the Free plan (then paid). At ~15-20 min/run that is roughly **100-130 runs/month**.
- **Avoid Actions minutes entirely:** run an always-on `vanguard watch` on your own hardware (any Docker host — see [deploy.md](deploy.md)). It uses **zero** GitHub minutes, polls Linear or GitHub itself, and is the right home for a private-repo factory or heavy use. The Linear path has no Actions option anyway and always runs on a host.
- **Cut per-run minutes** (private-repo Actions): the biggest slice is rebuilding the sandbox image every run — prebuild it and push to GHCR, then `docker pull` instead of `docker build` (saves ~2-3 min/run); cache `pnpm` and the build. Keep `runs-on: ubuntu-latest` (1× multiplier; larger runners multiply the minute cost). A single `watch --once` (the default since the spec→build fix) already halved the old double-sweep.

**Model usage.** Billing follows the credential, not the run count: a **subscription** (`CLAUDE_CODE_OAUTH_TOKEN`, or Codex `CODEX_AUTH_JSON`) draws on your plan's usage with no per-token charge; an **API key** bills per token (see [Auth](auth.md)). On a subscription the marginal cost of a run is plan usage + time, not dollars. `vanguard stats` rolls up per-run tokens/cost from `.vanguard/runs/metrics.jsonl`.
