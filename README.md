<p align="center">
  <img src="assets/banner.png" alt="Taskcell — self-hosted software factory" width="820" />
</p>

<p align="center">
  <b>Taskcell — self-hosted software factory</b> (formerly Vanguard) — fetches tasks from GitHub, GitLab, or Linear,<br/>
  implements them with an AI agent pipeline in an isolated sandbox, and opens PRs/MRs for human review — ready for review when every gate passed, draft otherwise.
</p>

<p align="center">
  <a href="https://github.com/spietrza/taskcell/actions/workflows/ci.yml"><img src="https://github.com/spietrza/taskcell/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8B5CF6.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-22D3EE" alt="Node >= 24">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/built%20with-Claude%20Agent%20SDK-D97757" alt="Claude Agent SDK">
  <img src="https://img.shields.io/badge/sandboxed-Docker-2496ED" alt="Docker sandbox">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/hero-flow-dark.svg" />
    <img src="docs/diagrams/hero-flow-light.svg" width="100%" alt="Vanguard at a glance: a task ticket from GitHub, GitLab, or Linear enters the agent pipeline in a Docker sandbox: plan (a read-only tech spec), implement, review in a fresh context, then the verify gate. Green opens a PR ready for review; red sends the change to repair, at most two rounds, which re-verifies, and if it is still red the PR opens as a draft." />
  </picture>
</p>

## What is Taskcell?

> **Taskcell was called Vanguard.** The repository moved from `spietrza/vanguard` to `spietrza/taskcell` (old links redirect). The CLI command, `VANGUARD_*` variables, `vanguard:*` labels and the `.vanguard/` directory keep their names for now, so existing setups keep working. Website: [taskcell.dev](https://taskcell.dev).

Taskcell turns work items into reviewed code changes — autonomously:

1. **Fetch** — pulls a Task from a pluggable Task Source: GitHub Issues, GitLab Issues, or Linear.
2. **Run** — an AI agent pipeline (implementer → reviewer → simplifier by default, planner → implementer → reviewer with `--plan`) implements it inside an isolated Docker sandbox.
3. **Verify** — a Proof-of-Work command runs after the agent finishes; failures flag the PR/MR instead of silently passing.
4. **Deliver** — opens the **PR/MR**, ready for review when every gate passed, draft otherwise. Humans review and merge; Vanguard does the toil.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/factory-loop-dark.svg" />
    <img src="docs/diagrams/factory-loop-light.svg" width="100%" alt="Vanguard factory loop: a human sets the spec or agent trigger on an issue (a label on GitHub and GitLab, a workflow state on Linear); Vanguard triages it in a CI job or a watch loop (too vague goes to needs info until a human edits it); the agent writes a read-only tech spec and builds (implement, review, simplify) in a Docker sandbox; Vanguard opens a PR, or an MR on GitLab, ready for review when every gate passed and a draft when a gate or the visual proof failed or no verify command ran. On GitHub, where the review workflow opts in (this repo's does), a ready PR first gets Vanguard's read-only review, which posts its verdict on the PR. When that review finishes, the Approver in shadow mode (this repo's opt-in workflow) waits for the required checks, decides APPROVE or ESCALATE from typed facts, posts a neutral check and a comment, and records the decision; it never merges, approves or labels, and drafts get no decision. A human reviews it and merges. On a GitHub PR, the needs revision label sends the agent to fix the review comments and push to the same PR; GitLab MRs have no revise pass. A GitHub Projects board skips triage and spec: moving a card to Todo starts the build." />
  </picture>
</p>

Run it once per ticket — or let the **Watch Loop** autonomously list ready Tasks, claim them, and process them end to end.

Status: Phase 1 (core engine), Phase 2 (task sources, pipeline, evals), and Phase 3 (adversarial review, human-in-the-loop, budget guardrails, dynamic MCP skills) are implemented and tested. Runs autonomously (AFK) as a `watch` loop; deployed always-on on Docker (Synology / Hetzner / any host).

## What's new (October 2026)

- **Factory backlog in the Hub** — the Task board header shows `Running N · Waiting K` (claimed or running tasks; tasks labelled `ready for agent`/`ready for spec` not yet picked up), Fleet shows `K waiting` next to its slot meter; `12+` marks a lower bound when the board holds only its first page. ([Hub](#hub))
- **Risk line in PR/MR reviews** — after `Verdict:` the reviewer states `Risk: low|medium|high` and what the change can break; advisory, never gates. ([External PR review](#external-pr-review))
- **Vanguard Hub** — `vanguard hub` serves the Inspector cockpit over HTTP/SSE: task board with **New Run**, live transcript, run records with proof of work, CI-run import, Add project by folder or by repository URL. Local mode, one instance per team; see [Hub](#hub) and [docs/hub.md](docs/hub.md).
- **Reactive model escalation** — `--escalate-model <m>`: the first gate repair stays on the implementer model; a second red gate resumes the same session on a stronger one. Cheap by default, expensive only after an observed failure. ([Models](#models))
- **Implementer fallback provider** — `--fallback-provider <p>` [`--fallback-model <m>`]: when the implementer's provider throws (outage, usage limit, revoked credential) the stage retries once on this provider — and so does every other stage that runs on the implementer's provider (simplifier, planner, any repo-flow stage), since a provider that is down for one is down for all; the repair loop resumes on whichever provider actually ran. Skills are injected for the fallback's CLI family too. Same mechanism the cross-provider reviewer already has. The fallback must sit on a different transport slot than the implementer: `claude`, `zai`, `openrouter`, `meridian` and custom endpoints all drive the `claude` CLI through `ANTHROPIC_BASE_URL`, so a `claude` implementer falls back to `codex` (or `cursor`), while a `codex` implementer can fall back to `claude`/`openrouter`/`zai`. The registry rejects a colliding pair at preflight; `vanguard doctor`/`watch` preflight checks the fallback's credential too. Not combinable with `--fork` (variants run on the primary only), and `--escalate-model` never reaches the fallback CLI: once the fallback holds the session its repairs stay on its own model.
- **Per-task model label** — `vanguard:model=<m>` on an issue pins that task's implementer model, over `--provider-model`; the human's call beats any heuristic. GitHub, GitLab, Linear.
- **Honest run metrics** — resumes, repairs and fork variants fold into the stage record (`attempts`, `firstExitReason`); `vanguard stats` gains a `BY MODEL` table that exposes gateway substitutions (`served (requested X)`).
- **Decision model as fork scorer and eval judge** — `run --fork n --fork-scorer decision` and `eval --judge-model clef-flash` replace an LLM writing JSON in a `<verdict>` tag with a calibrated `P(acceptable)` in ~100 ms. ([Fork-and-select](#fork-and-select))
- **Decision-model probe (experimental, log-only)** — with Cloudflare Workers AI credentials set, a sub-second [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) query scores each task's difficulty before the run; `vanguard stats` shows predicted vs observed first-try rate so you can decide whether it should drive routing. ([Models](#models))
- **PR review that survives truncation** — the reviewer states a `Verdict:` line first; a reply that stops before its completion signal is still a review, a reply with no verdict on a small diff is reported as the reviewer's failure (with the output tail in the job log), not as "PR too large" (#405).
- **Durable factory metrics** — `vanguard metrics push` persists a CI run's `metrics.jsonl` lines on an orphan `vanguard-metrics` branch; `vanguard stats --branch vanguard-metrics` reads them back. Without it, stats on GitHub Actions died with the job. ([Cost & limits](#cost--limits))
- **Langfuse / OTLP trace export (opt-in)** — every run becomes one OpenTelemetry trace (a `generation` span per stage with model, tokens, cost, turns, exit reason) POSTed to any OTLP/HTTP endpoint; three env vars point it at a self-hosted Langfuse and it becomes the cross-run ledger. Unset, nothing changes. ([Autonomous loop](#autonomous-loop))
- **Current-generation models** — the `$or-est` price table knows Claude 5.5 and Fable 5.1 (live OpenRouter rates, 2026-10-07), the `sonnet`/`opus`/`haiku` aliases point at the 5.5 rows, and an alias resolving within its own family no longer shows as a gateway swap in `vanguard stats`.
- **Provider routing fixes** — repair loops resume on the routed model (not the provider default); `--plan`/`flow-b` keep their planner-tier model on pass-through providers; OpenRouter accepts Claude aliases (`haiku`, `claude-sonnet-5`) and maps them to slugs.

## Contents

- [Design philosophy](#design-philosophy)
- [How it works](#how-it-works)
- [Layers](#layers)
- [Quick start](#quick-start)
- [Task sources](#task-sources-pick-one)
- [Auth](#auth) · [Local secrets](#local-secrets-two-ways)
- [End to end](#end-to-end)
- [Skills](#skills) · [Custom skills (bring your own)](#custom-skills-bring-your-own) · [When a skill is worth adding](#when-a-skill-is-worth-adding)
- [Models](#models)
- [Providers](#providers) — Claude / Codex / Cursor / z.ai / OpenRouter, cross-provider, Codex subscription, custom endpoint
- [Fork-and-select](#fork-and-select)
- [Security](#security) · [Host LLM proxy](#host-llm-proxy)
- [Development](#development)
- [Hub](#hub)
- [Autonomous loop](#autonomous-loop) · [Loop v1 (two-pass)](#loop-v1--two-pass-autonomous-pipeline) · [External PR review](#external-pr-review) · [Implement issues via GitHub Actions](#implement-issues-via-github-actions)
- [Approver (shadow mode)](#approver-shadow-mode)
- [Cost & limits](#cost--limits)
- [Retrospective memory](#retrospective-memory)
- [Proof of work](#proof-of-work)
- [Visual proof](#visual-proof)

New repo onboarding: [GitHub Actions](docs/onboarding-another-repo.md) · [Linear](docs/onboarding-linear.md) · [always-on host (Synology / Hetzner)](docs/deploy.md)

## Design philosophy

Vanguard treats autonomous coding as an engineering system, not a prompt-and-pray script. Five principles separate it from "run an agent in a loop":

- **Harness over code.** Every agent failure is a *harness* failure. Instead of hand-fixing the agent's output, you fix the instruction, skill, tool, or sandbox limit so the system is immune to that failure class next time. Real cases this codebase hardened against: a macOS worktree-path mismatch, a dangling-symlink copy-back crash, and a Synology kernel with no CPU CFS scheduler — each became a permanent fix, not a one-off patch.
- **Trade-off reasoning.** System prompts state the *business cost* of decisions — a wrong or sloppy change costs reviewer trust and rework far more than the seconds a typecheck or test run takes — so the model spends "effort" (adaptive thinking) where it matters and escalates when it should, via the `<tradeoffs>` section of the default system prompt.
- **Token-efficiency by construction.** Sessions are captured to the host and resumed/forked to reuse cached context instead of paying twice for it; `cacheReadInputTokens` and a derived `cacheEfficiency` are first-class on every `RunResult` and tracked per stage. Real runs sit at 97–99% cache, which is what makes always-on AFK economical.
- **Evals-first.** A judge-scored eval suite over control (ambiguous), edge, and refusal/hand-off cases guards against regressions when a model or prompt changes (corpus seeded; run `vanguard eval` for pass-rate and verdict scores — `--judge-model clef-flash` judges with a decision model, calibrated and parse-free; CI gating is phase 2).
- **Verifiable run artifacts.** Every run leaves an auditable trail under `.vanguard/runs/`: a per-stage transcript, a **git bundle of the exact changes**, the diff, one `run_complete` metric line (cost, tokens, cache efficiency, duration, exit reason), and optional host-driven Proof of Work with a SHA-256 over verification output. `vanguard stats` rolls it up across the fleet. This is what makes an AFK-generated PR trustworthy. The run also carries an optional host-driven Visual Proof for UI artifacts (see Visual proof below). *(Retrospective memory is also implemented: a deterministic host-side digest of prior failures and reviewer notes, fed back into later runs as advisory context.)*

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/run-pipeline-dark.svg" />
    <img src="docs/diagrams/run-pipeline-light.svg" width="100%" alt="One Vanguard run: on the host (a CI job or a watch loop), claim and triage (no model call; too vague goes to needs info). In the Docker sandbox: implement, review (Codex, fresh context, fixes), simplify (fresh context), then verify with the repo's verify script (else its detected test scripts); red sends it to repair (at most 2, the second on a stronger model) and back to verify. Green, or repairs used up, goes back to the host: secret scan (a hit pushes nothing), then push and open a PR, or an MR on GitLab: ready for review when green, a draft with verify-failed when still red, and also a draft when no verify command ran or the visual proof failed." />
  </picture>
</p>

**Loop v1 adds a layered two-pass flow before each implementation run:**

1. **Spec pass (Planner)** — Polls the spec-trigger (label or state). Runs triage: rejects vague tickets to needs-info before spending any model budget. If the ticket passes, runs `techSpecStage` (read-only: no code is written), posts the result as a `<tech_spec>` comment, then advances the ticket to the agent-trigger. A freshly-specced ticket is implemented on the **next poll** — the human has a window to review the spec before the agent runs.
2. **Agent pass (Implementer → Reviewer → Simplifier)** — Polls the agent-trigger. Runs triage again in `agent` mode: rejects tickets that lack acceptance criteria or a spec comment before spending implement budget. If the ticket passes, runs the full stage pipeline and opens a PR or MR — draft only when a gate or configured visual proof failed, or no verify command ran.

The agent runs inside the sandbox. The host owns all file sync (`copyIn` / `copyFileOut`) and secrets. A run stops when the agent emits `<promise>COMPLETE</promise>`.

## Layers

- **Sandbox** (`IsolatedSandboxProvider`): `DockerSandboxProvider` for local and Linux hosts, `FirecrackerSandboxProvider` for microVMs on a KVM host. Resource limits, tmpfs secrets, streaming exec.
- **Worktree** (`WorktreeManager`): one git worktree per task. Cleanup keeps a worktree that still has uncommitted changes.
- **Agent** (`AgentProvider`): `ClaudeCodeProvider` runs the in-sandbox `claude` CLI (effort levels, stream-json, usage and cost). `PiProvider` is a Phase 2 stub.
- **Context**: a prompt engine (`{{KEY}}` placeholders and `` !`cmd` `` expansion run in the sandbox), `buildXmlPrompt` for XML-tagged prompts, and `SkillRegistry` for injecting tools.
- **Pipeline**: `runStages` chains stages over one shared worktree and session. Built-in stage sets: Implementer/Reviewer/Simplifier, Generate/Evaluate/Repair, and Plan/Implement/Adversary (a red-team reviewer that reports `<findings>` without editing). `commitStage` and `publishForReview` are the Merger.
- **Guardrails**: `runBudgetedStages` enforces a hard cost ceiling and freezes the run (`budget_exceeded`) for resume after a raise; `runJudgedRepair` freezes to `needs_human` after three rejected repairs, leaving the sandbox live for `shellCommand()` entry.
- **Evals**: `runEvals` scores cases (control, edge, refusal) with a programmatic or LLM judge.

## Quick start

```bash
pnpm install
pnpm build
docker/build.sh                 # builds vanguard-sandbox (node + git + claude + linear CLIs)
```

Run the smoke example against a throwaway repo:

```bash
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Vault/Anthropic/token") pnpm tsx examples/smoke.ts
```

## Task sources (pick one)

`TaskFetcher` abstracts the source, so one deployment uses a single source of truth.

```ts
const fetcher = new LinearCliTaskFetcher({ team: 'ENG' });          // Linear (via the linear CLI)
const fetcher = new GitHubTaskFetcher('owner/repo');                    // GitHub Issues
const fetcher = new GitHubProjectFetcher({ owner, projectNumber, repo });// GitHub Projects v2
```

GitHub is also the review surface: `publishForReview` opens a PR, and `linkPullRequest` / `linkLinearIssue` comment the PR link back onto the source issue.

A Linear task in a repo whose `origin` is on gitlab.com, or on the self-hosted host named by `GITLAB_HOST`, opens a GitLab MR through `glab` instead (draft only when a gate or configured visual proof failed, or no verify command ran), and the review verdict lands as an MR note. A self-hosted host needs `GITLAB_HOST` even when `glab auth login` already knows it; preflight stops a run whose origin host glab is logged in to but `GITLAB_HOST` does not name. That check never sends `GITLAB_TOKEN` to the origin host, so a job with only a token relies on `GITLAB_HOST`. Host detection reads the hostname in `origin` as written, so a remote that uses an SSH config alias is not recognised: `git@gitlab.com-work:group/project.git` takes the GitHub route on the Linear path, and `--source gitlab` accepts an alias such as `github.com-work` as a GitLab host and fails later in `glab`. Use the real hostname in `origin`. Agent runs never write CI config: `.github/workflows/`, local actions under `.github/actions/` (an action kept elsewhere is not covered), `.gitlab-ci.yml` and every `.yml`/`.yaml` under `.gitlab/`, including insights, dashboards and Kubernetes agent config, are dropped on copy-back with a warning, so a task that only edits those files ends with no changes; make such edits by hand. When a run changed any of them, the PR or MR description (or the `revise-pr` summary comment) lists those files under **Not included**. `vanguard review-mr` skips an MR head it already reviewed, so a CI retry after a completed review posts no second review. Two runs on the same head that overlap can both post, since the check runs before the review and the note is posted after it. Only a marker in a note by the user `glab` runs as counts, so another participant cannot suppress the review by posting a marker. An MR author who can change the job definition can still suppress it, as [External PR review](#external-pr-review) explains. After a switch to a token of another user, earlier reviews stop counting and each open MR head is reviewed once more. A running `watch-mrs` keeps the user it read first, so restart it after such a switch. When it cannot read that user (the token needs `GET /user`) or the MR notes, it fails and posts nothing, and the error says which. The reviewer states a `Verdict:` line first, so a reply cut off before its completion signal still counts as a review (posted with a truncation note). A reply with no verdict is retried once with a larger budget and a verdict-first triage instruction; if the retry has no verdict either, `review-mr` posts nothing and exits non-zero, so the head is never marked as reviewed, and both discarded replies' tails are in the job log.

`LinearCliTaskFetcher` drives Linear entirely through the `linear` CLI (from schpet/linear-cli; authenticate with `linear auth login` or set `LINEAR_API_KEY`), covering fetch/list/comment with no SDK dependency. The CLI's skill (SKILL.md in that repo) can be injected via `skillRegistryFromDirectory` so the agent uses it directly. Confirm the `linear issue query --json` field shape against your workspace before relying on it.

## Auth

Subscription is the default and draws on your Claude plan's usage allowance (no per-token charge — the same pool as interactive Claude Code). The API key is the alternative and bills the Developer Platform per token. Vanguard injects exactly one secret into the sandbox, so billing is unambiguous.

Vanguard runs Claude headless via `claude -p` (`claude --print --output-format stream-json`, see `src/agents/claude-code.ts`). Billing is decided purely by which auth env var is set, not by the CLI mode — `claude -p` consumes the same plan usage as the interactive CLI.

```bash
claude setup-token            # once, generates the subscription token
CLAUDE_CODE_OAUTH_TOKEN=...    # subscription (default)
ANTHROPIC_API_KEY=...          # API billing instead
```

See `.env.example`. `authFromEnv()` prefers the subscription token; `authSecrets(auth)` maps the choice to the single env var the sandbox receives.

**Two modes, no third.** Subscription (`CLAUDE_CODE_OAUTH_TOKEN`) draws on your plan's usage; API key (`ANTHROPIC_API_KEY`) bills per token on platform.claude.com. There is no separate credit pool for `claude -p` / Agent SDK usage — Anthropic announced one for 2026-06-15 but postponed it (the 2026-05 announcement was reversed), so headless runs keep consuming normal plan usage exactly like interactive Claude Code.

### Local secrets (two ways)

Vanguard reads everything from env vars (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN`). Locally, populate them however you like:

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

`op` (1Password CLI) needs `op signin` or the desktop app integration; its sessions can expire between calls, so prefer reading the secrets in the same command that uses them. On a server there is no 1Password — see [docs/deploy.md](docs/deploy.md#secrets-no-1password-on-the-server).

## End to end

```ts
const task = await fetcher.fetch('123');
const ctx = await prepareContext({ taskId: task.id, localRepoPath, baseBranch: 'main', start: 'base', sandbox });
try {
  await runStages(ctx, implementReviewSimplifyStages(), { agent, variables: taskToVariables(task) });
  const commit = await commitStage(ctx, { message: `feat: ${task.title}` });
  if (commit.committed) await publishForReview(ctx, { title: task.title });
} finally {
  await disposeContext(ctx);
}
```

`examples/from-github-issue.ts` runs this whole loop from a GitHub issue.

## Skills

Vanguard supports Claude Code skills (the `SKILL.md`-per-directory format used by collections like [obra/superpowers](https://github.com/obra/superpowers), [mattpocock/skills](https://github.com/mattpocock/skills), and [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills)). Point a registry at a directory of skills and Vanguard injects the whole set into the agent's `~/.claude/skills` inside the sandbox. The agent auto-discovers and selects the relevant ones at runtime, so there is no per-run list to maintain.

```ts
import { skillRegistryFromDirectory, run } from 'vanguard';

// Clone a skills collection into ./skills (each subdir with a SKILL.md is one skill).
const skills = await skillRegistryFromDirectory('./skills');
await run(opts, { skills });
```

For targeted injection instead of the whole set, construct `new SkillRegistry({ id: '/host/path' })` and call `inject(['id'], sandbox)`.

The repo bundles five skills in `skills/`: `code-review` and `simplify` (used by the loop's review pass), `tech-spec` (specs for under-specified tasks), `caveman` (cut tokens on long runs), and `ponytail` (avoid over-engineering: climb the laziness ladder, stop at the first rung that works). `tech-spec` reaches only the spec pass: the CLI's and the factory's implement, revise and review runs never load it, because it forbids editing source files. An SDK caller that points `skillRegistryFromDirectory` at the bundled dir loads it too and should drop it from non-spec runs itself.

### Custom skills (bring your own)

A skill is a directory with a `SKILL.md` (frontmatter `name` + `description`, then the body), the standard Claude Code format. `--skills <dir>` injects every subdirectory in that dir, and the agent picks the right one per task by matching each skill's `description`. A migration task pulls in `db-migrations`, a release task `release`, and `ponytail` fires on everything. You curate the set, the model chooses per task. There is no per-issue flag.

Keep your domain skills in the target repo under `.github/vanguard-skills/`:

```
.github/vanguard-skills/
  db-migrations/SKILL.md
  release/SKILL.md
```

That is the whole setup. Vanguard injects every skill in the `--skills` dir plus every skill in the target repo's `.github/vanguard-skills/` into `run` and `watch` on every source (GitHub, GitLab, Projects, Linear), the spec pass (`spec`, and `watch` loop-v1), `revise-pr`, and the reviewers (`review-pr`, `watch-prs`, `review-mr`, `watch-mrs`). `research` runs without skills. Reviewers take repo skills from the PR's base branch, so a PR cannot change the skills of its own review. The implement workflow passes the bundled `skills/`, so the agent keeps `ponytail`/`code-review`/`simplify` and gains yours. A thin `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` caller needs no extra step or input. Leave the workflow's `skills` input at its default: pointing it at `.github/vanguard-skills` would drop the bundled skills the review and simplify stages use.

A repo skill with the same directory name as a bundled one replaces it, so a repo can ship its own `code-review`; the run log names every skill replaced this way. Skill directories that are symlinks are skipped, and so are `SKILL.md` files that are symlinks, with a warning in the run log. A `.github/vanguard-skills` that is not a directory, or that resolves outside the repo, fails the run.

Skills are injected per-provider in the format each CLI auto-discovers:

| Provider | Target | Format |
|---|---|---|
| `claude-code`, `zai`, `openrouter`, `meridian`, custom endpoints | `~/.claude/skills/<id>/` | Full skill directory |
| `codex` | `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | Pointer index: name + description + path to `.vanguard/skills/<id>/SKILL.md` |
| `cursor` | `.cursor/rules/<id>.mdc` | One `.mdc` per skill with `description`/`globs` frontmatter + pointer |

Codex receives only a pointer index (not the full skill bodies) in its always-on `AGENTS.md` to avoid inflating every turn with N full skill texts; the model reads the body from `.vanguard/skills/<id>/SKILL.md` when the description matches the task. Cursor rules use `alwaysApply: false` so they are description-attached, not always-on, for the same reason. Neither `.cursor/rules/` nor `.vanguard/skills/` is copied back into the PR diff.

**Cross-provider runs:** skills are injected for every CLI family that may run in the sandbox: the implementer (`--provider`), the reviewer (`--review-provider`) and the implementer fallback (`--fallback-provider`). With `--provider claude --review-provider codex`, the Claude stages get `~/.claude/skills/` and the Codex reviewer gets the `AGENTS.md` pointer index.

Two checks before a skill goes in. It must be self-contained: `SKILL.md` plus plain text, no MCP or browser, since the sandbox has neither. It must allow model invocation: skip any with `disable-model-invocation: true`, because the agent never triggers those itself. Only the `description`s load up front, so curate about a dozen, not a whole collection.

### When a skill is worth adding

A skill is worth adding when it carries knowledge the model lacks: how to drive an unfamiliar CLI (the linear-cli skill below), a repo-specific procedure such as writing a migration or cutting a release, or long instructions that only some tasks need.

Generic expert skills such as `docker-expert` or `python-expert` add little, because the model already knows Docker and Python. Put your stack rules and conventions in the target repo's `CLAUDE.md` (Codex reads `AGENTS.md`), which the agent CLI loads on every stage.

An instruction that a stage must follow on every run belongs in the stage prompt, since the model decides whether to open a skill. Vanguard's review prompt says "If a code-review skill is available, use it.", and the simplify prompt says the same for `simplify`. Both prompts also state their core instructions directly, so a stage that skips the skill still follows them. The skills add the detailed checks, and `code-review` adds the severity rules for blocking a merge.

To see which skills a run used, search its transcripts in `.vanguard/runs/<taskId>/`. A Claude-family stage logs each Skill tool call as `"skill":"<id>"`. Codex and Cursor read the body from `.vanguard/skills/<id>/SKILL.md`, so search for that path instead.

### Example: the linear-cli skill

[schpet/linear-cli](https://github.com/schpet/linear-cli) ships a skill at `skills/linear-cli/` that teaches the agent to drive the `linear` CLI directly. The sandbox image already includes the `linear` CLI, so you only inject the skill and forward `LINEAR_API_KEY`:

```bash
git clone --depth 1 https://github.com/schpet/linear-cli /tmp/linear-cli
```

```ts
const skills = await skillRegistryFromDirectory('/tmp/linear-cli/skills'); // registers the linear-cli skill
const sandbox = new DockerSandboxProvider({ secrets: { ...authSecrets(auth), LINEAR_API_KEY: process.env.LINEAR_API_KEY! } });
await run({ ...opts, sandbox }, { skills });
```

The agent then auto-discovers the skill and can read or update Linear from inside the sandbox.

## Models

Choose the model per stage with `model` (`'opus'`, `'sonnet'`, `'haiku'`, or a full id), and reasoning depth with `effort`. Two presets:

- `fastStages()` - a single low-effort `haiku` pass: cheap and quick, still on the subscription via the CLI.
- `planImplementReviewStages()` - plan on `opus` (high effort, emits a `<plan>`), then implement and review on `sonnet`. The capable model plans; the cheaper one executes.

Runs reuse the session and keep a stable prompt prefix to maximize Anthropic prompt caching; `RunResult.cacheEfficiency` reports the cached fraction of input tokens.

The canonical pipeline is implement → review → simplify. The reviewer reviews for correctness **and** over-engineering (the ponytail minimalism lens — would less code do the job?), so the third simplify pass is often redundant. Pass `--no-simplify` (on `run`/`watch`) for a lean implement → review run that skips it.

An optional **conformance pass** can be appended after the reviewer with `--conformance` (on `run`/`watch`; opt-in, default off, GitHub/Linear only). It runs a fresh, report-only stage that checks the final diff against the spec's Acceptance Criteria for unmet criteria, scope drift, and silently dropped requirements; its findings post to the PR and gate the merge alongside the reviewer's. It is report-only — it never edits files (`copyBack:false`). `--conformance-model <m>` sets the model for that stage; it defaults to the implementer/`--provider-model` model, so **pass `--conformance-model opus` to run the check on a planner-tier model** (the headline use case).

## Providers

The agent behind each stage is a swappable `AgentProvider`: `claude` (Claude Code CLI, default), `codex` (OpenAI Codex CLI), `cursor` (Cursor CLI; see [docs/CURSOR-provider.md](docs/CURSOR-provider.md)), `zai` (z.ai GLM Coding Plan), `openrouter` (OpenRouter's Anthropic skin), or `meridian` (self-hosted [Meridian](https://github.com/rynfar/meridian) proxy — share a Claude Max subscription from another host; see [docs/MERIDIAN-provider.md](docs/MERIDIAN-provider.md)). Selection is **by provider, not by model** — each provider runs on its own default model. Two modes:

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

**Per-stage model** (independent of provider) — `--provider-model <m>` sets the model for the implementer/simplifier stages and `--review-model <m>` for the review stage; each defaults to the provider's own default model. A bare alias (`sonnet`, `opus`, `haiku`) floats to the newest generation the credential serves, so the implementer upgrades itself on release day; a full id (`claude-fable-5-1`) stays pinned, which is what you want wherever the model is a merge gate. `vanguard stats` records both the requested and the served name, so an alias upgrade shows as the new id, while a gateway substituting a different family shows as `served (requested X)`. `--escalate-model <m>` is **reactive escalation**: the first gate repair (conformance/verify/incomplete) resumes on the implementer model; if the gate is still red, the second and later repairs resume the same session on the escalation model. Nothing is predicted up front — the cheap model only gets replaced once it has demonstrably failed. The one up-front call is yours: label an issue `vanguard:model=<m>` (e.g. `vanguard:model=claude-fable-5`) and that task runs exactly as if `--provider-model <m>` had been passed for it — the reviewer keeps `--review-model` (a cross-provider reviewer is untouched), conformance keeps `--conformance-model`, and `--escalate-model` steps aside since the label already is the escalation. It is a plain label with one colon (case-sensitive; not a GitLab scoped label), read once at run start; anyone who can label the issue can pick its model, and the per-stage budget caps still apply. Works on GitHub, GitLab and Linear (labels fetched over GraphQL). On `--provider cursor` the model values are Cursor's own: an Auto mode (`auto-intelligence`, `auto-balance`, `auto-cost`) or a Cursor id from `agent models`. The Claude aliases map onto the matching Auto mode. See [docs/CURSOR-provider.md](docs/CURSOR-provider.md#choosing-a-model).

**Decision model vs LLM judge — what Clef is and is not.** A decision model (Cloudflare [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), Typesafe Jev — the second only through a Typesafe or self-hosted endpoint via `VANGUARD_DECISION_URL`) does not replace Haiku, Sonnet or any generating model: it cannot write code, a review or a sentence. It answers typed questions (yes/no, pick one, rate on a rubric) with a calibrated probability per option, in one forward pass. It overlaps with an LLM only where Vanguard asks for a *decision* — the eval judge, the fork scorer, the difficulty probe — and nowhere else. Side by side, for those roles:

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

**Difficulty probe (experimental, log-only).** Decision models answer typed questions with calibrated probabilities in milliseconds instead of generating text; Vanguard talks to them through one client speaking the System One API. Two are known to it: Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) — the one in use, on Workers AI's free tier — and Typesafe's Jev, which Cloudflare does not host and which has not been exercised here. Opt in with `VANGUARD_DECISION_PROBE=1` plus credentials: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AUTH_TOKEN` (Workers AI; `VANGUARD_DECISION_MODEL` is `clef`, the default, or `clef-flash`), or `VANGUARD_DECISION_URL` [+ `VANGUARD_DECISION_TOKEN`] pointing at any System-One-compatible endpoint, which is also the only way to run `jev` (a Typesafe endpoint or a self-hosted `vllm-jev`). The probe uses one model and one endpoint per run — `VANGUARD_DECISION_MODEL` picks it, there is no ensemble (`eval --judge-model` and `--fork-scorer` take their own model argument, which overrides it). The credentials alone do nothing — they are Cloudflare's generic variable names. While the sandbox is being provisioned, each run asks: will the first attempt pass the gate, how hard is this (Trivial…Research-grade, x.5 rounds up), is the spec clear? The answer is logged (`decision_probe` line in `metrics.jsonl`, one console line) and **changes nothing** about routing. After enough runs, `vanguard stats` prints a `PROBE` table of predicted vs observed first-try rate per predicted level, one pair per run — if they track, the probe earns the right to set `vanguard:model=` automatically; if not, unset the switch. A failing probe warns once and the run proceeds; it can never fail because of it. **What leaves the host:** the task title, labels, description and comments (including a posted or `--spec-file` tech spec) go from the host process to the endpoint — outside the sandbox, `--egress` and `--llm-proxy`. White-label runs (client repos, `--commit-author`) are therefore skipped unless you set `VANGUARD_DECISION_PROBE=all`.

**What switching the decision model on gives you.** Nothing in the implement/review path changes — the implementer, reviewer and escalation keep running exactly as before. What you get:

- **A difficulty signal before every run, for free.** Three calibrated probabilities (first attempt passes the gate, difficulty level, spec clarity) logged next to the run. Today it only observes; once `vanguard stats`' `PROBE` table shows the prediction tracking the observed repair rate, it can start setting `vanguard:model=` automatically — the predictive routing that is deliberately not built on guesswork.
- **A judge that is fast, cheap and parse-free.** `vanguard eval --judge-model clef-flash` returns a probability per case in ~0.5 s instead of an LLM writing a `<verdict>` JSON blob that has to parse; the pass threshold is `P(acceptable) ≥ 0.5`, not a model's self-rating. Run the corpus twice (default judge, then clef) and diff the pass rates — that comparison is the point.
- **A fork scorer that compares like with like.** `run --fork n --fork-scorer decision` picks the variant with the highest `P(acceptable)`; the diff's completion state and file list are in the question, and an empty or unfinished diff scores near zero.
- **A second opinion where parsing used to fail.** Every decision above used to be a generated string parsed by regex or Zod; a decision model cannot produce a malformed answer, only a probability you can threshold.

What it does not give you: text. It cannot write code, a review, or explain its number; it cannot replace Sonnet, Opus, Fable or Haiku anywhere they generate.

**Decision model quick start (Cloudflare Workers AI, free tier).** Workers AI includes 10,000 Neurons a day at no charge; `clef`, the default, costs 21,818 Neurons per million input tokens, so a factory probe (~7–8k tokens of issue and spec) uses ~165 Neurons — about 60 runs a day for free. `clef-flash` is ~6× cheaper (3,455 Neurons per million) but, replayed on 11 factory probes, was markedly overconfident (Brier 0.16 vs 0.05 for `clef`); pick it with `VANGUARD_DECISION_MODEL=clef-flash` when volume outgrows the free tier.

1. In the Cloudflare dashboard create an API token from the **Workers AI** template (Account → Workers AI → **Read** is enough; drop the Edit row) and copy your **Account ID** from the account's overview sidebar.
2. Export the credentials outside any dotfiles repo (Vanguard reads the process environment, not `.env`), and switch the probe on:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=…   # 32 hex chars
   export CLOUDFLARE_AUTH_TOKEN=…   # the token, shown once
   export VANGUARD_DECISION_PROBE=1
   ```
   For the GitHub Actions factory, add the same two values as repository secrets, pass them to the reusable workflow under `secrets:`, and set `decision-probe: true` on the caller (off by default, see [onboarding](docs/onboarding-another-repo.md)).
3. Run anything. The probe logs one line per run and `vanguard stats` grows a `PROBE` table; `vanguard eval --judge-model clef-flash` and `run --fork 3 --fork-scorer decision` use the same credentials.

What a live call looks like (recorded 2026-10-07, `clef-flash`, 485 input tokens, 518 ms):

```
vanguard: spietrza/taskcell#999 difficulty probe (clef-flash, 518ms): first-try 0.58, difficulty 1.59/4, spec clear 0.79
```

and the judge on a refusal case: an output that charges ahead scores `P(acceptable)=0.11`; one that merely sounds careful but does not do what the expectation names scores `0.48` — the judge reads the expectation, not the tone. The fork scorer gives a small, tested diff `0.91` and an empty diff `0.03`.

`--conformance-model <m>` sets the model for the optional conformance stage (see Models above); it defaults to the implementer/`--provider-model` model, so pass `--conformance-model opus` to run conformance on a planner-tier model. Mix freely with provider selection:

By default `run` uses the implement → review → simplify pipeline (the implementer plans inline). Pass `--plan` to prepend a dedicated planning stage (opus, high effort) that emits a `<plan>` for the implementer to follow — the plan → implement → review pipeline. Combine with `--review-model opus` to also review on the planner-tier model:

```bash
vanguard run --github o/r#1 --plan --review-model opus   # plan on opus, implement on sonnet, review on opus
```

The commit is authored `Vanguard <vanguard@local>` by default; override with `--commit-author "Name <email>"` (git's standard form) to attribute the work to yourself. The PR itself is opened by whichever account owns the push token (`VANGUARD_PUSH_TOKEN`/`GH_TOKEN`), independent of the commit author.

**White-label mode.** Passing `--commit-author` also switches Vanguard to deliver a plain, human-looking PR — the "Vanguard" branding is dropped everywhere it would reach the remote:

- Branch becomes `feat/<issue-number>-<hash>` (e.g. `feat/904-9d414a3d`) instead of `chore/vanguard-…`.
- The PR body is just the `Closes #N` / `Part of #N` line — no "Automated implementation … by Vanguard" attribution and no `## Proof of work` block.
- No Vanguard review comment is posted on the PR, and no "opened a PR" comment is posted back on the issue.
- The commit message is Conventional-Commits-safe — `feat: <lower-case subject> (#N)`, header ≤100 chars — so a target repo's `commitlint` passes.

`vanguard research` honours the same switch: with `--commit-author` its comment heading drops "Vanguard" (`## Research` instead of `## Vanguard Research`) and uses a neutral hidden marker — the author value is unused there since research never commits.

**One-shot spec pass.** `vanguard spec <owner/repo#n> --repo <path> [--spec-model <m>] [--commit-author <a>]` runs the same tech-spec generator the watch loop uses (`techSpecStage`: read-only codebase research, `<tech_spec>` output) as a single CLI step — **no labels are read or written**. The spec is posted as an issue comment; `--commit-author` white-labels the heading (`Tech spec:` instead of `Vanguard tech spec:`). Recognition is keyed on the `<tech_spec>` tag, so triage and the conformance manifest treat both headings identically. Pair it with `vanguard run` on the same issue once the spec looks right — e.g. spec on a planner-tier model, then implement on a cheaper one (`--provider-model`) with the review pinned back on the planner tier (`--review-model`).

**Fully local spec (no tracker trace).** Add `--out <file>` to `vanguard spec` to write the spec to a local file instead of posting any comment, then feed it back with `vanguard run … --spec-file <file>`: the file is injected into the fetched task as a virtual comment, so the implementer prompt, triage, and the conformance manifest read it exactly like a posted spec — but the only public artifact of the whole pipeline is the PR itself. `--spec-file` is single-issue only (rejected with `--parent`/`--project` fan-out); make sure `.vanguard/` is gitignored in the target repo so the spec never rides along in a commit.

**Standalone PR review — to the tracker or to a file.** `vanguard review-pr <owner/repo#n> --repo <path> [--review-model <m>]` reviews an existing PR (an adversarial pass, larger budget on retry) and posts the verdict as a PR comment. Add `--out <file>` to write the review to a local file and post **nothing** to the PR — the same no-trace escape hatch as `spec --out`, for reviewing client PRs without leaving an automation comment.

**Address human review feedback.** `vanguard revise-pr <owner/repo#n> --repo <path> [--review-model <m>] [--max-rounds <n>]` reads the human review threads + comments on a bot PR, applies fixes, pushes to the PR branch, and replies to + resolves each addressed thread. It treats every non-bot commenter's feedback as a change request, whatever their role on the repository, so run it only where the people who can comment are trusted; on a public repository, anyone can. Unlike `review-pr` (which *produces* a review), `revise-pr` *consumes* one. On a client repo pass `--commit-author "Name <email>"` — it authors the revision commits as that identity and drops the "vanguard" token from the hidden revision marker, so the whole exchange looks human. Prefer to inspect before anything touches the PR? `--out <file>` runs it as a **dry-run**: it applies the fixes and writes the diff + the reply it would post to each thread into the file, pushing and commenting **nothing** — review it, then re-run without `--out` to apply.

The quality pipeline (reviewer, conformance, verification) still runs and still gates the `Closes`-vs-`Part of` decision — only the *surfacing* is suppressed. Default (no `--commit-author`) keeps the full Vanguard branding and review comment. Note the white-label branch has no unique marker, so `gc` won't auto-reap it — enable "auto-delete branch on merge" on the repo instead.

**Base branch.** By default Vanguard branches off `main` and targets the PR at `main`. Pass `--base <branch>` (e.g. `--base dev`) to branch off and open the PR against a different base — the diff is then computed against, and the PR merges into, that branch.

```bash
vanguard run --linear TES-1 --provider-model opus --review-model haiku   # plan/implement big, review cheap
vanguard run --linear TES-1 --provider-model sonnet --conformance --conformance-model opus   # implement on sonnet, check conformance on opus
vanguard run --linear TES-1 --provider-model sonnet --review-model claude-fable-5-1 --escalate-model claude-fable-5-1   # cheap implement on the current Sonnet; a 2nd failed gate repair escalates to a pinned top model
vanguard run --github o/r#1 --commit-author "Sebastian Pietrzak <spietrza@gmail.com>"   # commit authored as you
```

`--provider` / `--review-provider` / `--provider-model` / `--review-model` work the same on `run` and `watch`. The simplifier stays on the main provider. Each non-Claude provider brings its own key, forwarded into the sandbox **only when that provider is selected**: `CODEX_API_KEY` for codex, `CURSOR_API_KEY` for cursor, `ZAI_API_KEY` for zai (a missing key fails fast at dispatch, not mid-run). Under `--llm-proxy` the Codex/OpenAI key **and** the z.ai key are held by a trusted sidecar instead of the sandbox (see [Host LLM proxy](#host-llm-proxy) below); Cursor's key is still injected directly (not yet proxied). Claude auth is the baseline (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), but a run whose providers are all Codex/Cursor consumes none of it, so `watch-prs --provider codex` needs no Anthropic credential in direct mode; `--llm-proxy` still needs one for the primary sidecar. The sandbox image ships the `claude` and `codex` CLIs; the Cursor CLI is opt-in (`CURSOR_CLI_VERSION=<version> ./docker/build.sh`), and cursor reports tokens but no cost, so budget caps do not bind it — see [docs/CURSOR-provider.md](docs/CURSOR-provider.md).

Codex does not read its key straight from the environment: `CodexProvider` runs `codex login --with-api-key` (the key piped from `OPENAI_API_KEY` inside the sandbox, never on the command line) before `codex exec`. Under `--llm-proxy` Codex is instead configured (via `~/.codex/config.toml`) to use a custom OpenAI-compatible provider pointed at the trusted sidecar, reading only the per-run nonce from `OPENAI_API_KEY` (no `codex login`, and the real key never enters the sandbox). Either way, the OpenAI account behind the key must have active billing — without it `codex exec` connects and authenticates but the API returns "account is not active", which surfaces as a failed review stage.

**Codex on a ChatGPT subscription (no API key).** Set `CODEX_AUTH_JSON` to the contents of a `~/.codex/auth.json` produced by `codex login` on a ChatGPT Plus/Pro account (`auth_mode: chatgpt`, OAuth tokens, no API key). The runner forwards it verbatim into the sandbox, where `CodexProvider` writes it to `~/.codex/auth.json` (0600) and skips login — `codex exec` then runs on the subscription and self-refreshes the access token via the embedded refresh token. This works like Claude's `CLAUDE_CODE_OAUTH_TOKEN`: the credential lives in the sandbox, so `--llm-proxy` does not apply to it (and `CODEX_AUTH_JSON` takes precedence over `CODEX_API_KEY`/`OPENAI_API_KEY` when both are set). Solid for local and long-running (Synology) use; on ephemeral CI the stored token must carry a valid refresh token, and an API key is the sturdier choice there. Example: `CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)" vanguard run --linear TES-1 --provider codex`.

**Custom OpenAI-compatible endpoint.** To run Codex against any endpoint that speaks the OpenAI **Responses** API (a self-hosted vLLM, OpenRouter, Together, a gateway, …) instead of `api.openai.com`, set `OPENAI_BASE_URL` on the host. The runner forwards it into the sandbox as `VANGUARD_OPENAI_BASE_URL`, and `CodexProvider` writes a `~/.codex/config.toml` provider pointed at it (`wire_api = "responses"`), sending your key from `OPENAI_API_KEY`/`CODEX_API_KEY` as the bearer token:

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1   # must include the /v1 path (OpenRouter's Responses API is in beta)
export OPENAI_API_KEY=sk-...                           # the key your endpoint expects
vanguard run --linear TES-1 --provider codex --provider-model <model-the-endpoint-serves>
```

Constraints: (1) the endpoint must implement the OpenAI **Responses** API (`/v1/responses`) — Codex no longer speaks `/chat/completions`; (2) this is **direct mode only** — it is ignored under `--llm-proxy`, whose sidecar always targets `api.openai.com` (point the sidecar elsewhere by changing the proxy upstream, not this var); (3) with `--egress` the endpoint's host must be in the allowlist, otherwise run without `--egress` so the sandbox can reach it directly. `CODEX_AUTH_JSON` (subscription) takes precedence — set `OPENAI_BASE_URL` only in the API-key path.

**z.ai (GLM Coding Plan).** `--provider zai` reuses the in-sandbox Claude Code CLI, pointed at z.ai's Anthropic-Messages-compatible coding endpoint (`https://api.z.ai/api/coding/paas/v4`) with the GLM model family (default `glm-5.2`). It needs **no Anthropic token** — set `ZAI_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the z.ai key is held by the primary trusted sidecar (forwarding to `api.z.ai` as a bearer key) and the sandbox gets only the per-run nonce. (z.ai's endpoint is OpenAI-compatible too, but the Codex CLI dropped `wire_api = "chat"` support, so the Claude-CLI route is the supported one.)

**OpenRouter.** `--provider openrouter` follows the same pattern as z.ai, pointed at OpenRouter's Anthropic-Messages-compatible "skin" (`https://openrouter.ai/api`) with a dotted OpenRouter slug as the model (default `anthropic/claude-sonnet-4.6`; override with `--provider-model`). It needs **no Anthropic token** — set `OPENROUTER_API_KEY` and the runner injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (a bearer key) into the sandbox. Under `--llm-proxy` the OpenRouter key is held by the primary trusted sidecar (forwarding to `openrouter.ai` as a bearer key) and the sandbox gets only the per-run nonce. **Recommended:** in your OpenRouter account, pin **Anthropic 1P** as the top-priority provider for Claude models — the Claude Code CLI expects Anthropic-1P behaviour, and this is an account-level provider-selection preference, not something the run can set per-request.

## Fork-and-select

`run --fork <n>` runs the implementer stage `n` times (each variant forks the same base, on a worktree reset between runs), scores each variant's diff, and keeps the best one before the review/simplify stages continue. Scoring is an LLM verdict produced by a one-shot run of the same provider in a throwaway `/tmp` cwd (the diff is supplied in the prompt, so the scorer never touches the worktree) — or, with `--fork-scorer decision`, a [decision model](#models) (`clef-flash` on Workers AI or any System-One endpoint): `P(acceptable)` for each diff in ~100 ms, a calibrated probability instead of a model's self-rated JSON, with no verdict parsing to fail. The diff leaves the host for that call (outside the sandbox, `--egress` and `--llm-proxy`); on a white-label run (`--commit-author`) that is the client's diff, so it needs the same consent as the difficulty probe: `VANGUARD_DECISION_PROBE=all`. Credentials and consent are checked once at start-up, before any issue is claimed. Use it to trade tokens for quality on hard tasks:

```bash
vanguard run --linear TES-1 --fork 3
```

## Security

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/security-dark.svg" />
    <img src="docs/diagrams/security-light.svg" width="100%" alt="Vanguard security boundary: untrusted issue, PR or MR text from GitHub, GitLab or Linear reaches the host (a CI job or a watch loop), which holds the GitHub or GitLab token. The GitHub Actions workflows first gate on the issue author and the sender; GitLab, Linear and watch-loop runs have no author gate. The host builds the prompt with untrusted tags escaped. The agent CLI runs in a Docker sandbox (non-root, cap-drop ALL, noexec tmpfs) with no GitHub or GitLab token; on a Linear task it gets the Linear API key to read the issue. Changed files come back through copy-back, which drops CI config, then a secret scan; only the host pushes the branch and opens the PR or MR. Opt-in sidecars: an LLM proxy holds the real model key while the agent gets a per-run nonce, and an egress proxy allows CONNECT only to allowlisted hosts (Linear, GitHub, npm, PyPI, plus the model APIs the LLM proxy does not front). On GitHub, the shadow Approver runs as a separate job from the default branch with a write token: it reads its policy (approver.json) from the base branch only and the PR head only as git objects, never checking out or running PR code; its gh calls are allowlisted, and it writes only a decisions.jsonl line on the vanguard-metrics branch, a check and a PR comment." />
  </picture>
</p>

Dashed edges are opt-in: `--llm-proxy` (on in this repo's GitHub Actions review and revise workflows), `--egress`, and the writes of the [shadow Approver](#approver-shadow-mode) (this repo's GitHub Actions workflow; it never merges, approves or labels). Without the first two the model token sits in the sandbox's noexec tmpfs and egress is open.

One opt-in feature sends data from the host itself: the [difficulty probe](#models) (`VANGUARD_DECISION_PROBE=1`) posts issue text to a decision-model endpoint from the host process, so neither the sandbox nor `--egress` and `--llm-proxy` cover it, and it skips white-label runs unless set to `all`. The sandbox is the blast radius, not the host. Secrets reach the sandbox through an in-RAM tmpfs file (POSIX-quoted, never in `docker inspect` or on disk), never via argv. Host subprocesses use argument arrays, never shell strings. `.env` is a template only; no secrets live in the repo. The base image is pinned by digest; SIGINT/SIGTERM destroy live sandboxes and a host concurrency limit caps how many run at once. Generate an image SBOM with `pnpm sbom` (needs syft). `vanguard run --egress` confines the sandbox to an internal docker network whose only route out is a proxy sidecar that tunnels just the allowlist (anthropic/github/linear/registries), so even a process that ignores the proxy has no route out.

`VANGUARD_OWNER_LABEL=<id>` labels every container and network with `vanguard.owner=<id>`, so a CI job can remove its own leftovers: first the containers with `docker ps -aq --filter label=vanguard.owner=<id> | xargs -r docker rm -f`, then the egress network with `docker network ls -q --filter label=vanguard.owner=<id> | xargs -r docker network rm`, which Docker refuses while a container still uses it. `xargs -r` skips the command when nothing matches, so a clean job does not fail its `after_script`.

### Host LLM proxy

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

See [docs/smoke-tests/codex-openai-proxy.md](docs/smoke-tests/codex-openai-proxy.md) for the current verification status, a zero-cost negative preflight check, and a controlled live runbook that walks through the Codex/OpenAI proxy preflight and a read-only `review-pr` smoke run when active OpenAI billing is available.

## Development

```bash
pnpm typecheck
pnpm test
```

Node 24+, pnpm, Vitest, ESM with NodeNext. Tests are co-located as `*.test.ts`. Docker integration tests run when Docker is present and skip otherwise.

## Hub

`vanguard hub` is the factory's cockpit in a browser: the same Inspector UI the Tauri desktop app
ships, served over plain HTTP + SSE from a Node process next to your repos, with no native app to
install. One instance per developer or team; agent code runs where the hub runs.

```bash
pnpm install && pnpm build:ui          # once: deps + the UI bundle
docker/build.sh                        # once: vanguard-sandbox (only needed for runs started from the hub)
export CLAUDE_CODE_OAUTH_TOKEN=...     # the shell that starts the hub is the env the runs get
pnpm hub --repo /path/to/your/repo     # opens http://127.0.0.1:7777/#token=… (the launch URL it prints)
```

What you get per project: a **Dashboard** of projects with run counts and spend; a **Task board**
of your tracker's issues (GitHub, GitLab, Linear) with **New Run** starting the pipeline in the
sandbox, a live transcript, and a `Running N · Waiting K` count in its header; **Fleet**, which runs a
`watch` loop at the concurrency you set and shows slots in use and how many tasks wait; **Runs** with
every stage's record, diff, transcript, proof of work and visual proof; **Remote**, which imports a CI run's `vanguard-runs` artifact and shows it like a local
run; **Workflow** for the repo's `.vanguard/flows/*.hcl`; **Settings** for `.vanguard/app.json`.
**Add project** takes an existing folder or a repository URL it clones for you.

Three ways to use it:

1. **Local factory** — runs start from the Task board and execute in Docker on this machine; PRs
   land on GitHub/GitLab as usual. Needs the token in the hub's environment and the sandbox image.
2. **Observe the CI factory** — keep running Vanguard in GitHub Actions (callers with
   `upload-run-records: true`) and use the hub read-only: Remote → Fetch records → open the run.
   Nothing to install beyond `gh auth login`.
3. **Self-hosted** — `docker/hub.Dockerfile` on a VPS (Coolify, Hetzner) behind Tailscale or an
   authenticating reverse proxy, never a published port: local mode has no login yet.
   `VANGUARD_HUB_ALLOW_ADD=1` enables Add project / Clone on a non-loopback bind.

Details, wire format, env vars and the Compose example: [docs/hub.md](docs/hub.md).

## Autonomous loop

`vanguard watch` polls a source for ready items and runs each one by itself (claim → run → PR → move to review): `--source linear` (trigger = state type + label) or `--source github` (open issues with labels). Each run implements, then **reviews and simplifies its own diff in a fresh, independent context** using the bundled `skills/` (code-review + simplify) injected into the sandbox. Loop v1.1 adds safe defaults so GitHub can be started with `vanguard watch --source github --github-repo owner/repo`, and Linear with `vanguard watch --loop-v1 --label vanguard`. To run it always-on in Docker on Synology / Hetzner / any host, see [docs/deploy.md](docs/deploy.md).

### Loop v1 — two-pass autonomous pipeline

Loop v1 adds a deterministic Spec pass before every Agent pass. Routing differs by source:

**GitHub (routes by LABELS):**

`--label` (e.g. `vanguard`) is an optional **ownership** label for GitHub: when supplied, an issue is only picked up if it carries it *in addition to* the routing label below. The short GitHub command does not require it because the repo plus `ready for spec` / `ready for agent` already define the loop lane.

| Routing label | What happens |
|---|---|
| `ready for spec` | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + relabelled `needs info` (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue relabelled `ready for agent`. If `--label` is supplied, the issue must also carry that ownership label. |
| `ready for agent` | Agent pass triggers (next poll after spec, or immediately for directly-labelled issues). Triage runs again — no spec or acceptance criteria → `needs info`. Valid tickets: full Implementer → Reviewer → Simplifier pipeline → PR (draft only when a gate or configured visual proof failed, or no verify command ran). If `--label` is supplied, the issue must also carry that ownership label. |
| `needs info` | Parked. Human updates the ticket and moves it back. |

> **Note on the issue template:** The [Vanguard Task template](.github/ISSUE_TEMPLATE/vanguard-task.md) defaults to `ready for agent` only. The spec loop runs when a human downgrades the label to `ready for spec` (for high-level ideas that need a research + planning pass first). Leaving the label as `ready for agent` skips the spec pass and goes straight to implementation — this is intentional, not a bug. Add an ownership label such as `vanguard` only when your watcher is started with `--label vanguard`.

#### Routing labels — full set (which go on an **issue** vs a **PR**)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/labels-dark.svg" />
    <img src="docs/diagrams/labels-light.svg" width="100%" alt="Vanguard routing labels on GitHub, in three columns: labels you add, labels Vanguard sets while working, and labels that mean it is your turn. needs research leads to vanguard:researching, which posts findings and rests until you pick the next label. ready for spec leads to vanguard:speccing, which posts the spec and moves the issue to ready for agent, or to needs info when triage finds it too vague. ready for agent leads to vanguard:running, then vanguard:needs-human-review once the PR is open, or needs info. needs revision on a PR Vanguard opened leads to vanguard:revising, which pushes fixes and returns to vanguard:needs-human-review. ready for vanguard review on any PR leads to vanguard:reviewing, then vanguard:reviewed; where the review workflow opts in, it adds that label itself to a factory PR that opens ready for review or leaves draft. GitLab uses the same ready for spec, ready for agent and needs info labels, writes its states with a double colon (vanguard::speccing, vanguard::running, then vanguard::review once the MR is open) and has no research or revise pass; Linear routes by workflow states instead." />
  </picture>
</p>

`ready for ...` / `needs ...` are **triggers you add by hand**; `vanguard:...` are **states Vanguard sets itself**. On GitHub Actions, issue-side triggers fire `issues: labeled` workflows; PR-side triggers fire `pull_request_target: labeled` workflows. The exception is `ready for vanguard review`: this repo's review workflow also adds it to a factory PR that opens ready for review or leaves draft, so that PR gets Vanguard's review without anyone labelling it. A caller copied from [docs/onboarding-another-repo.md](docs/onboarding-another-repo.md) runs on the label only.

These are the GitHub names. GitLab (`watch --source gitlab`) uses the same `ready for spec`, `ready for agent` and `needs info` triggers but writes its states with a double colon: `vanguard::speccing`, `vanguard::running`, `vanguard::review` once the MR is open, and `vanguard::reviewing` / `vanguard::reviewed` for `watch-mrs`, whose trigger label you pass with `--label`. GitLab has no `needs research` or `needs revision` pass. Linear routes by workflow states (table below), and a GitHub Projects board by its Status column.

| Label | On | Kind | Triggers / means |
|---|---|---|---|
| `ready for spec` | issue | trigger | spec pass writes a `<tech_spec>`, then builds |
| `ready for agent` | issue | trigger | builds directly (issue already scoped) |
| `needs research` | issue | trigger | external research → posts a findings comment → **rests** (no auto-advance; you set spec/agent next) |
| `needs info` | issue | triage (resting) | parked — ticket too vague |
| `ready for vanguard review` | **PR** | trigger | adversarial **read-only** review → posts a comment; never edits code |
| `needs revision` | **PR** (opened by Vanguard) | trigger | reads your review comments → fixes on the PR branch → pushes → un-drafts if still a draft → back to `needs-human-review` |
| `vanguard:speccing` · `:running` · `:researching` · `:revising` · `:reviewing` | issue/PR | transient state | Vanguard is working (seconds–minutes) |
| `vanguard:needs-human-review` · `:reviewed` · `:verify-failed` · `:visual-proof-failed` | issue/PR | resting state | waiting on a human |

The word "review" means two things: `ready for vanguard review` (PR) is **Vanguard reviewing your PR** (read-only comment); `needs revision` (PR) is **Vanguard acting on your review of its own PR** (edits + pushes). `vanguard:needs-human-review` is the post-build resting state — your turn to review the PR.

```bash
# GitHub Loop v1.1 defaults
vanguard doctor --source github --github-repo owner/repo
vanguard watch --source github --github-repo owner/repo

# GitHub Loop v1 with custom labels/model
vanguard doctor --source github --github-repo owner/repo --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info"
vanguard watch --source github --github-repo owner/repo \
  --label vanguard \
  --spec-label "ready for spec" \
  --agent-label "ready for agent" \
  --needs-info-label "needs info" \
  --spec-model haiku
```

**Linear (routes by STATES):**

| State condition | What happens |
|---|---|
| State TYPE matches `--spec-state` (e.g. `triage`) + label | Spec pass triggers. Triage runs first — vague tickets get a clarification comment + moved to Needs Info state (no model budget spent). Valid tickets: `techSpecStage` posts a `<tech_spec>` comment, issue moved to the agent-trigger state (`--agent-state`, default `Todo`). |
| State TYPE matches `--trigger-state` (default `unstarted`) + label | Agent pass triggers (next poll after spec, or for any pre-specced issue). Triage runs in `agent` mode — vague tickets moved to `--needs-info-state`. Valid tickets: Implementer → Reviewer → Simplifier → PR (draft only when a gate or configured visual proof failed, or no verify command ran). |
| Needs Info state | Parked. Human updates the ticket and moves it back. |

The two-flag split is Linear-specific: `--agent-state` sets the **state name** the spec pass moves the ticket to (`Todo`), while `--trigger-state` matches the **state type** the agent pass fires on (`unstarted`). The default `Todo` is of type `unstarted`, so they line up out of the box and `--trigger-state` rarely needs setting (hence its absence from the example below) — unlike GitHub, where a single `--agent-label` is both the move target and the trigger.

```bash
# Linear Loop v1.1 defaults
vanguard doctor --loop-v1 --label vanguard
vanguard watch --loop-v1 --label vanguard

# Linear Loop v1 with custom states/model
vanguard doctor --loop-v1 --label vanguard --spec-state triage --spec-state-name Spec \
  --needs-info-state "Needs Info" --agent-state Todo
vanguard watch --loop-v1 --label vanguard \
  --spec-state triage \
  --spec-state-name Spec \
  --needs-info-state "Needs Info" \
  --agent-state Todo \
  --spec-model haiku
```

### Keeping the sandbox image current

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

**Shared behaviour (both sources):**

- `vanguard doctor` runs the AFK preflight without claiming work. It checks Node 24+, LLM auth, repo remote, Docker daemon, the sandbox image, `vanguard-sandbox:latest` or `VANGUARD_SANDBOX_IMAGE` when set (including the Claude CLI version inside it — see [Keeping the sandbox image current](#keeping-the-sandbox-image-current)), source auth, GitHub routing labels, and Linear env/skills setup. On a GitHub repo it also verifies the "Allow GitHub Actions to create and approve pull requests" setting (best-effort — skipped if the token cannot read it) and, when Codex is selected with a `CODEX_AUTH_JSON` subscription credential, validates its shape before the run.
- Triage is deterministic (`assessTaskReadiness`) and rejects under-specified tickets before spending any model tokens.
- The spec stage is read-only: it posts a `<tech_spec>` comment but never writes code or opens a PR.
- In continuous mode, a freshly-specced ticket is implemented on the **next poll** (human intervention window). In `--once` mode spec and build complete in the same invocation.
- `--spec-only` runs just the spec pass on each tick:
  - It works with or without `--once`. The agent pass never lists, claims or runs anything.
  - `--max-tasks` caps the spec pass only.
  - Flags only the agent pass reads (`--claimed-state`, `--review-state`, `--plan`, `--flow` and similar) have no effect.
  - Use it for a human review window in scheduled `--once` jobs: a spec-only job advances specced tickets to a review state or label (`--agent-state` / `--agent-label`) that the build job does not trigger on, a human moves approved tickets to the build trigger, and a separate watch without `--spec-only` builds them. On Linear the spec pass and the build job both list issues by state type, so the review state's type must differ from the `--spec-state` type (or the spec pass specs the ticket again on every poll) and from the build job's trigger type (`unstarted` by default). With the default `--spec-state triage`, a backlog-type review state works.
  - `--spec-only` requires `--agent-state` (Linear) or `--agent-label` (GitHub, GitLab) other than the default build trigger (`Todo`, `ready for agent`), which would give no review window. Only the default is checked: Vanguard cannot see a build job that triggers on another state or label.
  - The build job must be single-pass, or its own spec trigger must point at an unused state or label: a loop-v1 build job (the `watch --source github --once` shorthand is one) specs any ticket still in the spec trigger and builds it in the same `--once` run, so that ticket never waits in review. On GitHub and GitLab the single-pass build job's `--label` must be the approval label a human applies (for example `ready for agent`), not the loop-v1 ownership `--label`: the spec pass leaves the ownership label on every ticket, so a build job on it would also build tickets still in review and tickets not yet specced.
  - Preflight for a spec-only watch (or `doctor --spec-only`) skips the checks that only guard publishing: the pr-create setting, the agent-pass claimed/review labels, and a Linear run's GitHub/GitLab publish auth.
- The human role is to write good tickets + approve the final PR. The [issue template](.github/ISSUE_TEMPLATE/vanguard-task.md) is the intended intake path.
- External PR review is available as a one-shot `review-pr` command, an always-on `watch-prs` polling loop, or a GitHub Actions label trigger.

Operator logs stay terse and progress-oriented so always-on runs are scannable:

```text
preflight: node 24 ok
preflight: llm auth ok
preflight: github labels ok
spec: poll -> 1 ready
spec owner/repo#123: claim -> triage
spec owner/repo#123: advanced -> next poll agent
watch: poll -> 1 ready
watch owner/repo#124: claim -> running
watch owner/repo#124: pr opened -> review
```

Normal logs report source, task id, phase, outcome, and next action. Full prompts, diffs, transcripts, and proof details stay in `.vanguard/runs/`.

### External PR review

`vanguard review-pr` runs an adversarial, read-only review over an existing GitHub PR diff and posts a non-blocking GitHub review comment. It does not edit code, open another PR, or move issue labels. The review opens with its `Verdict:` line followed by `Risk: low|medium|high — <what the change can break>` (MR reviews get the same line). The risk is advisory: it never changes the verdict or the merge gate, and `review-pr` reports it in its result and the job summary next to the verdict.

The reviewer applies the repository's review guidelines (`CLAUDE.md` or `AGENTS.md`, and any document they point to). It reads them from its sandbox checkout, which `review-pr` and `review-mr` build from the local `main` branch, not from the PR or MR head. Keep that local `main` current with the target branch; guideline edits inside the diff are reviewed, not applied. This stops an author from rewriting the rules their own change is judged by only when the author cannot change the job that runs the review. A GitLab MR pipeline reads its job definitions from the MR's source branch, so the author of a same-project MR controls the whole job. They can point `main` at their own head, since the detached checkout has no local `main` until the job script makes one. They can also change the provider, model, prompt or token, or stop the review from running or posting. A GitHub workflow on `pull_request` for a branch in the same repository has the same exposure, because it takes the workflow file from the PR's merge ref. A workflow on `pull_request_target`, or on `workflow_dispatch` run from the base branch, takes it from the base branch and avoids this, provided the job checks out and runs only base-branch code. Never check out or build the PR head in a `pull_request_target` job, because that job has the repository's secrets and a write token. Where that matters, run the review from a pipeline whose configuration the author does not control. A label that a maintainer adds after reading the diff is not enough: the job definition still comes from the source branch, and the author can push a new one after the maintainer has read it.

```bash
vanguard review-pr https://github.com/owner/repo/pull/123
vanguard review-pr --github-pr 123 --github-repo owner/repo --provider codex --review-model gpt-5
```

`vanguard watch-prs` turns that reviewer into a small PR loop. It polls only PRs with an explicit trigger label, skips drafts and Vanguard/bot-authored PRs, swaps labels while reviewing, and restores the trigger label on failure so the next poll can retry; if the restore itself fails you will see a `restore failed -> manual label check` log line and should verify the PR labels by hand before the next poll. Pass `--author <login>` to restrict the loop to a single author's PRs (self-review-only). Successful reviews include a hidden `headRefOid` marker, so the loop skips the same commit if the trigger label is re-added accidentally.

```bash
vanguard doctor-prs --github-repo owner/repo --label "ready for vanguard review"
vanguard watch-prs --github-repo owner/repo --label "ready for vanguard review"
vanguard doctor-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed"
vanguard watch-prs --github-repo owner/repo \
  --label "ready for vanguard review" \
  --reviewing-label "vanguard:reviewing" \
  --reviewed-label "vanguard:reviewed" \
  --author owner \
  --provider codex \
  --review-model gpt-5
```

| PR label state | What happens |
|---|---|
| `ready for vanguard review` | Picked up on the next poll. The label is removed and `vanguard:reviewing` is added before the review starts. |
| `vanguard:reviewing` | Claimed/in progress. Later polls skip it. |
| `vanguard:reviewed` | Review comment posted successfully. Re-add the trigger label after new commits if you want another review pass; the same commit is deduped by the hidden review marker. A review whose reply stated its `Verdict:` line but stopped before the completion signal counts as posted (with a truncation note), so it is deduped too. A reply with no verdict after two passes posts an incomplete notice without the marker — remove and re-add the trigger label (or run the workflow by hand) to retry. |

Operator logs stay compact:

```text
review-pr owner/repo#123: fetch -> diff
review-pr owner/repo#123: agent -> reviewing
review-pr owner/repo#123: posted -> pr review
review-pr owner/repo#123: done
watch-prs: poll -> 1 ready
watch-prs owner/repo#123: claim -> reviewing
watch-prs owner/repo#123: reviewed -> marked
```

#### GitHub Actions trigger

`.github/workflows/vanguard-pr-review.yml` fires on `pull_request_target` when the `ready for vanguard review` label is applied to a PR. It also fires when a factory PR (a `chore/vanguard-*` branch in this repo, opened by an allowed login) opens ready for review or leaves draft: a first job adds the label, so that PR is reviewed without anyone labelling it. It can also be triggered manually via `workflow_dispatch` to sweep all currently-labeled PRs.

**Required secrets:** `CLAUDE_CODE_OAUTH_TOKEN` — the Claude subscription OAuth token. The built-in `GITHUB_TOKEN` provides PR/label write access automatically.

**Security model:** the workflow uses `pull_request_target` because posting reviews requires repo secrets and write permissions. It checks out only the base branch — PR head code is never fetched or executed. The model credential stays inside the `--llm-proxy` sidecar, which also restricts sandbox egress to an allowlist, so the untrusted PR diff cannot exfiltrate the model credential. Because Flow B is read-only (it reviews the diff in a sandbox and only posts a comment), the job gate is an **author + sender allow-list** rather than a single login: `contains(fromJSON('["spietrza","pawelkrystkiewicz"]'), github.event.pull_request.user.login)` **and** the same check on `github.event.sender.login` — a trusted person labels a trusted person's PR. Widen the list to add reviewers; keep it tight because each entry can trigger a run on the repo's review credit. (The sibling `vanguard-revise.yml` flow, which *pushes* code, keeps its author gate to the bot/owner only — see Flow C.)

**Behavior:** each run (a label event, or a factory PR that just became ready) runs `watch-prs --once` (the gate, not an `--author` filter, controls which PRs are eligible), reviewing PRs carrying the trigger label. This is idempotent: already-reviewed commits are skipped via the hidden `headRefOid` marker and the label swap.

**Re-review:** after new commits land, remove and re-add `ready for vanguard review` to trigger a fresh pass.

**Label setup:** the workflow creates the three routing labels idempotently on every run (`gh label create --force`), so no manual label setup is needed in a fresh repo.

**Relationship to always-on `watch-prs`:** both modes watch the same label; dedupe makes running both safe but redundant — pick one per repo.

Run `vanguard gc --remote <owner/repo>` on a timer (cron or systemd) to reap stale sandboxes, worktrees, and merged branches — see [Garbage collection](docs/deploy.md#garbage-collection) for cron and systemd-timer examples.

Each run appends a `run_complete` metric line per stage to `.vanguard/runs/metrics.jsonl` (cost, tokens, cache efficiency, duration, exit reason). `vanguard stats` aggregates that into a rollup — per task, per stage, per model (served, annotated with the requested one when a gateway substituted it), and a grand total — for fleet cost/time visibility (`--json` for machine output). **On an ephemeral host (GitHub Actions) that file dies with the job**, so a run there ends with `vanguard metrics push`: it appends the run's metric lines to a single `metrics.jsonl` on an orphan `vanguard-metrics` branch of the repo (git plumbing only — no checkout, no merge; idempotent, so a re-run never duplicates; needs push rights, which the implement workflow's `contents: write` already grants). `vanguard stats --branch vanguard-metrics` then reads that durable copy from any clone — it is where the `BY MODEL` and `PROBE` tables for the factory come from.

**Langfuse / OTLP mirror (opt-in).** The same per-stage records can be exported as one OpenTelemetry trace per run: the task id is the trace, each stage is a `generation` span carrying `gen_ai.request.model`, `gen_ai.usage.{input_tokens,output_tokens,cache_read_input_tokens}`, `gen_ai.usage.cost` / `vanguard.cost_usd`, `vanguard.turns` and `vanguard.exit_reason`; flow, provider, PR URL and exit reason ride on every span as filterable Langfuse trace metadata, and the task id doubles as the Langfuse *session*, so the spec run, the implement run and each revise round of one issue group together. Switch it on with an endpoint **and** auth — endpoint without auth is off, and with nothing set nothing changes:

| Variable | Value |
| --- | --- |
| `VANGUARD_OTLP_ENDPOINT` (or the standard `OTEL_EXPORTER_OTLP_ENDPOINT`, honored only with `VANGUARD_OTEL=1`, so an inherited host-wide OTel config never starts an export) | OTLP base; for Langfuse `https://<your-langfuse>/api/public/otel` (`/v1/traces` is appended) |
| `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | a Langfuse project key pair — Basic auth and the `x-langfuse-ingestion-version: 4` real-time header are derived; used only for a Langfuse-shaped endpoint (`VANGUARD_OTLP_ENDPOINT`, or a path containing `/api/public/otel`), so a host-wide `OTEL_EXPORTER_OTLP_ENDPOINT` never receives them |
| `VANGUARD_OTLP_HEADERS` (or `OTEL_EXPORTER_OTLP_HEADERS`) | alternative for any other collector: the OTel `k=v,k2=v2` list, which must include `Authorization=…` |

The export is a hand-rolled OTLP/HTTP JSON POST from the host process (no OpenTelemetry SDK, nothing reaches the sandbox), fired from the same place the metric line is written so local and CI runs behave the same; a failure is reported once on stderr and never fails the run — `metrics.jsonl` stays the record of truth. **Self-hosting on Coolify:** deploy Langfuse from Coolify's one-click service template, create a project, copy its public/secret keys, and set the three variables where Vanguard runs (on GitHub Actions: a repository variable for the endpoint, two secrets for the keys, passed through the workflow's `env`).

### Implement issues via GitHub Actions

Run Loop v1 straight from GitHub Actions — no always-on host. Label an issue and the workflow runs the pipeline in a sandbox, with the routing labels moving live:

- **`ready for spec`** — a rough idea: Vanguard writes a tech spec, advances the ticket to `ready for agent`, **then builds it** and opens a PR — all in one job.
- **`ready for agent`** — a written, ready ticket: Vanguard builds it directly.
- **too vague** — triage parks it at `needs info` (no budget spent); you fill it in and re-label.

Your repo carries only a **thin caller** (triggers, permissions, an actor gate and a `uses:` line); the steps live in reusable workflows in this repo (`implement.yml`, `pr-review.yml`, `research.yml`, `revise.yml`, `doctor.yml`), so a change to a default or a step reaches every repo without touching its copy. For the copy-paste callers, secret mapping, `allowed-actors`, the `@v1` / `@main` pin, the inputs of each workflow, the Codex-subscription setup, and the triage contract see **[docs/onboarding-another-repo.md](docs/onboarding-another-repo.md)**. `decision-probe`, `persist-metrics` and `upload-run-records` are off by default there: the probe ships issue text to Cloudflare, persisting metrics writes a branch into your repo, and run-record artifacts are readable by anyone who can read the repo.

The job runs `vanguard watch --source github --once` **once**: a `ready for spec` ticket is specced and built in the same invocation. Vanguard's own [`vanguard-implement.yml`](.github/workflows/vanguard-implement.yml) is a caller of [`implement.yml`](.github/workflows/implement.yml) (`uses: ./.github/workflows/implement.yml`). Each run processes every matching open issue (not only the one just labelled), so labelling one `ready for agent` also picks up any others already waiting — run an always-on `vanguard watch` on a host if you want continuous polling instead ([docs/deploy.md](docs/deploy.md)). Set `max-tasks: <n>` on the caller (or `--max-tasks <n>` on a host-run `vanguard watch`) to cap how many ready issues one run claims per phase, so a mislabelled batch cannot flood one CI runner.

**Run summary:** on Actions every run — each issue `watch` builds, each PR `watch-prs` reviews, each `revise-pr` round — also appends a markdown block to the job's **Summary** tab (via `$GITHUB_STEP_SUMMARY`): task id, flow, provider and model, a per-stage table (exit, turns, time, cost), the cost total, the PR URL, the review verdict, and how the run ended (`completed` / `verify-failed` / `secret-blocked` / `no-changes` / `error`). Several runs in one job stack. Outside Actions nothing is written. The on-disk run record under `.vanguard/runs/<taskId>/` (transcripts, diffs, bundles) still dies with the job unless the caller uploads it as an artifact.

**Required secret:** `CLAUDE_CODE_OAUTH_TOKEN` (repository or org secret). The built-in `GITHUB_TOKEN` covers git push, PR, and label writes.

**Required repo setting:** enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**. Without it the agent's `gh pr create` fails with `GitHub Actions is not permitted to create or approve pull requests` after doing all the work. (Set it via API: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.)

**Security:** the job condition restricts triggers to the maintainer's own issues (`github.event.issue.user.login` and `sender.login`), so a stranger labelling an issue cannot start a run. `--llm-proxy` keeps the model credential in a sidecar, out of the sandbox.

#### Run it on another repo

The target repo does not need Vanguard installed: add the `CLAUDE_CODE_OAUTH_TOKEN` secret, enable the PR-creation setting above, and drop in a ~25-line caller that does `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` — the full caller, the secret mapping and the input tables are in **[docs/onboarding-another-repo.md](docs/onboarding-another-repo.md)**.

Notes: the repo needs at least one commit (an empty repo has no `main` to open a PR against). The sandbox agent reads the target repo's `CLAUDE.md`, so put design/stack rules there to steer output — Vanguard does not inject your local Claude Code skills. The reusable workflow passes `--skills .vanguard-src/skills`, which injects Vanguard's bundled skills (`ponytail`, `code-review`, `simplify`), plus any skills the repo keeps in `.github/vanguard-skills/` (see [Custom skills](#custom-skills-bring-your-own)). Don't run this **and** an always-on GitHub watcher on the same labels — pick one per repo (a Linear watcher does not clash). The reusable workflow installs Vanguard with `--ignore-workspace`, so it also works when the target repo is a **pnpm workspace** (monorepo).

**Backward compatibility — `vanguard:review` label (deprecated).** The post-build resting state was renamed from `vanguard:review` to `vanguard:needs-human-review`; the maintained repos (vanguard, temp-test, alpha-window) have had the old label deleted. A repo onboarded before the rename may still carry `vanguard:review` on in-flight items — Vanguard will not migrate it automatically. The new default and the old label coexist harmlessly (`gh label create --force` adds the new one without touching the old); delete the stale `vanguard:review` once nothing in flight uses it, or pass `--review-state vanguard:review` to a host-run `vanguard watch` if you deliberately want to keep the old terminal label (the reusable workflow has no input for it).

#### Cross-provider on a Codex subscription (no OpenAI key)

Want Opus to plan, Sonnet to build, and Codex to review, with Codex running on a ChatGPT Plus/Pro subscription instead of a paid OpenAI API key? Two changes to the caller.

**1. Add the subscription credential as a secret.** Run `codex login` once on your machine (a ChatGPT account, `auth_mode: chatgpt`), then push the resulting `auth.json` verbatim — it holds OAuth tokens, not an API key:

```bash
gh secret set CODEX_AUTH_JSON --repo OWNER/REPO < ~/.codex/auth.json
```

**2. Set the providers and drop `llm-proxy`.** Map the secret in the caller's `secrets:` block and pick a provider per stage in `with:`:

```yaml
    uses: spietrza/taskcell/.github/workflows/implement.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
      spec-model: opus
      provider: claude
      provider-model: sonnet
      review-provider: codex
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

`spec-model: opus` plans, `provider: claude` + `provider-model: sonnet` implements and simplifies, `review-provider: codex` reviews (these map to `--spec-model`, `--provider`, `--provider-model`, `--review-provider`). Vanguard writes `CODEX_AUTH_JSON` to `~/.codex/auth.json` inside the sandbox (see [Providers](#providers)) and Codex runs on the subscription. `--skills` reaches both: the Claude stages get the full skill directories, the Codex reviewer gets a pointer index in its `AGENTS.md` (see [Skills](#skills)).

`provider-model` applies only to the Claude stages; it is never handed to the cross-provider reviewer (an Anthropic model name like `sonnet` would be rejected by the ChatGPT backend). The Codex reviewer uses its own default model — set `review-model` to pick a specific one.

`llm-proxy` is left off on purpose: a subscription talks to the ChatGPT backend, which the proxy allowlist does not cover (it routes the `api.openai.com` API-key path only). Without the proxy the Claude token sits in the sandbox directly — acceptable on a repo you own; if you need the proxy isolation, give Codex an `OPENAI_API_KEY` with active billing instead and keep `--llm-proxy`.

One CI caveat: the stored `CODEX_AUTH_JSON` is a snapshot. Codex refreshes the short-lived access token from the embedded `refresh_token` on each run, so the secret must carry a live refresh token; re-run `gh secret set` if a run ever fails to authenticate. For long-running hosts (a `vanguard watch` on a server or NAS) the local file refreshes itself and this does not come up.

## Approver (shadow mode)

`vanguard approve` is the stage after review: it decides whether a factory PR is boring enough to merge without a human, deterministically and with no LLM in the loop. v1 runs in **shadow mode** — it computes and publishes the decision, and never merges, approves, or edits a label. The point is to collect a record of what it *would* have done next to what humans actually did.

**What it decides.** One of two verdicts. `ESCALATE` if any rule fires, `APPROVE` only when the rule list comes back empty. The rules cover: not a same-repo `chore/vanguard-*` head, a closed or merged PR, draft, a required check that is not `success` from the expected app, a missing / stale / blocking / verdict-less review, a merge conflict, a head that moved under the run, git facts that could not be computed, a changed path on a sensitive surface (CI config, dependencies, deploy/migrations, security surface, the review pipeline itself, gate config, agent instructions, release config), a diff over the size ceiling, a deleted test file or a net loss of test cases, a new dependency, a removed export — plus a deterministic audit sample (10%) that escalates a share of otherwise-clean PRs so humans keep seeing normal cases, and a trailing-week per-module line ledger that escalates a drip of individually-small changes.

**Which typed facts it reads.** Only structured data, never free text from an issue, PR body, or comment. From `gh`: the PR record (`isDraft`, head/base refs and SHAs, head repo) and check runs on the head SHA matched by **both** name and app id. From the published review: the verdict line and the head-SHA marker of the latest review in the external review format whose author is on the allow-list — a body with no marker, or with more than one distinct marker SHA, is rejected, and the main loop's own in-pipeline review never counts. From git, read-only (fetch into `FETCH_HEAD`, then `show`/`diff`/`patch-id`/`merge-tree` against SHAs — the PR head is never checked out): changed files, lines and paths against the merge base, deleted test files and test-case delta, removed exports, new manifest dependencies, patch ids and ancestry, and merge-tree cleanliness. Any git fact that cannot be computed fails closed into `git-facts-failed`.

**Where records go.** One JSON line per decision, appended to `decisions.jsonl` on the orphan `vanguard-metrics` branch (the same branch `vanguard metrics push` uses — the files coexist, nothing is rewritten). Append-only and idempotent per (PR, head SHA): a rerun at the same head adds nothing, except that a `stopped` / `policy-unreadable` placeholder does not block the full decision once the stop is lifted. Each record holds the verdict, every rule id that fired, the signals behind them, the audit draw and its seed, and the `sha256` of the policy that produced it, so any decision can be replayed. The decision is also published as a `neutral` check run (`vanguard/approver`) and a PR comment. The check run and comment go out first and the record last; all three are attempted even when one fails, and any failure makes the command exit non-zero after the rest ran.

**How to run it.**

```bash
vanguard approve --pr 557 --github-repo spietrza/taskcell     # decide, publish, record
vanguard approve --pr 557 --github-repo spietrza/taskcell --json      # print the decision record
vanguard approve --pr 557 --github-repo spietrza/taskcell --dry-run   # decide and print only — publish and record nothing
```

`--github-repo` is required (the approver never infers the repo it judges), `--repo <path>` points at a local checkout of the base branch (default: cwd), and `--mode` accepts `shadow` only in v1.

**In CI (this repo).** `.github/workflows/vanguard-approver.yml` runs it after the external review of a factory PR finishes (`workflow_run` on `Vanguard PR Review`), and waits for the required CI checks before deciding. That way the decision sees complete inputs once; triggering on CI as well would record a premature `review-missing` that the per-head dedupe then keeps. It builds the CLI from the default branch and never checks out PR code. Run it by hand from Actions → Vanguard Approver (shadow) with a PR number. Drafts get no decision, since the review does not run on them.

**Policy and kill switch.** Everything tunable lives in `.vanguard/approver.json`, read from the **base branch only** (`git show refs/remotes/origin/<base>:.vanguard/approver.json`) — never the working tree or the PR head, so a PR cannot widen the policy judging it; a PR that touches that file always escalates. An unreadable or invalid policy fails closed to `ESCALATE` (`policy-unreadable`). Field-by-field reference: [docs/approver-policy.md](docs/approver-policy.md).

Two kill switches, either one short-circuits to `ESCALATE` (`stopped`) before any diff or ledger collection:

```bash
VANGUARD_APPROVER_STOP=1 vanguard approve --pr 557 --github-repo spietrza/taskcell   # per-run, env
# or, repo-wide: set "enabled": false in .vanguard/approver.json on the base branch
```

## Cost & limits

Two cost dimensions: **GitHub Actions minutes** (only when you run via Actions) and **model usage**.

**GitHub Actions minutes.** A run builds Vanguard + the sandbox image, then runs the pipeline — about **15-20 minutes per run** on `ubuntu-latest`.
- **Public repos: unlimited.** GitHub bills no Actions minutes for public repositories, so the Actions path has no minute ceiling there.
- **Private repos: 2000 min/month** on the Free plan (then paid). At ~15-20 min/run that is roughly **100-130 runs/month**.
- **Avoid Actions minutes entirely:** run an always-on `vanguard watch` on your own hardware (Synology / Hetzner / any Docker host — see [docs/deploy.md](docs/deploy.md)). It uses **zero** GitHub minutes, polls Linear or GitHub itself, and is the right home for a private-repo factory or heavy use. The Linear path has no Actions option anyway and always runs on a host.
- **Cut per-run minutes** (private-repo Actions): the biggest slice is rebuilding the sandbox image every run — prebuild it and push to GHCR, then `docker pull` instead of `docker build` (saves ~2-3 min/run); cache `pnpm` and the build. Keep `runs-on: ubuntu-latest` (1× multiplier; larger runners multiply the minute cost). A single `watch --once` (the default since the spec→build fix) already halved the old double-sweep.

**Model usage.** Billing follows the credential, not the run count: a **subscription** (`CLAUDE_CODE_OAUTH_TOKEN`, or Codex `CODEX_AUTH_JSON`) draws on your plan's usage with no per-token charge; an **API key** bills per token (see [Auth](#auth)). On a subscription the marginal cost of a run is plan usage + time, not dollars. `vanguard stats` rolls up per-run tokens/cost from `.vanguard/runs/metrics.jsonl`.

## Retrospective memory

`vanguard memory` reads `.vanguard/runs` artifacts — failed runs, failed proofs, and reviewer notes (not diffs or transcripts) — and refreshes a short, redacted digest at `.vanguard/memory/retrospective.md`. It is deterministic (no LLM): a host-side rollup, advisory only.

Subsequent `run`, `watch`, and spec runs automatically load that digest into the implementer and tech-spec prompts as advisory context ("use only when relevant"); the digest refreshes best-effort after each run. `.vanguard/` is gitignored — this is operational host state, not committed source.

```bash
vanguard memory                 # refresh + print the digest
vanguard memory --json          # machine-readable report
vanguard memory --limit 20      # keep the 20 most recent entries
```

## Proof of work

After the agent finishes, the host (not the agent) runs a verification command inside the sandbox, captures its stdout and stderr, computes a SHA-256 over the combined output, and stamps a Proof of Work block into the PR body and the run record. The agent cannot fake it.

Command precedence: `--verify "<cmd>"` flag > `VANGUARD_VERIFY_CMD` env > a `verify` script in the worktree `package.json` (the host builds `<pm> install --frozen-lockfile && <pm> run verify`) > auto-detect from `package.json` (if a `test` script exists, the host builds `<pm> install --frozen-lockfile [&& <pm> run typecheck] && <pm> test`) > skip (no command resolved means no block, PR body unchanged). A repo that declares its own `verify` script (e.g. mirroring what its CI build job runs) gets exactly that gate instead of the typecheck/test guess, so verify matches CI.

On failure the PR always opens, the body carries a `FAIL` Proof of Work block (command, exit code, SHA-256, and an output tail), and a `vanguard:verify-failed` label is added to the PR (best-effort).

```bash
vanguard run --linear TES-1 --verify "pnpm typecheck && pnpm test"
# or set for all runs:
VANGUARD_VERIFY_CMD="pnpm typecheck && pnpm test" vanguard watch --label vanguard
```

## Visual proof

After the agent finishes, the host (not the agent) optionally runs a user-supplied visual proof command inside the sandbox — for UI changes that produce screenshots or visual artifacts (e.g. Playwright). It captures stdout and stderr, computes a SHA-256 over the combined output, lists the artifacts the command wrote under `/workspace/.vanguard/visual-proof`, hashes each one (a manifest of path + SHA-256 + byte size — artifacts are not copied out in this version), and stamps a Visual Proof block into the PR body and the run record.

Command precedence: `--visual-proof "<cmd>"` flag > `VANGUARD_VISUAL_PROOF_CMD` env > skip. Unlike Proof of work, there is no auto-detect — if no command is resolved, there is no visual proof and the PR body is unchanged.

Allowed artifact extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`, `.html`, `.json`.

Visual proof failure never blocks the PR: the PR always opens, and on a non-zero exit — or if a configured command can't be executed at all (sandbox crash, cancel, timeout) — the body carries a `FAIL` Visual proof block (a crash is recorded with exit code `-1`) and a `vanguard:visual-proof-failed` label is added to the PR (best-effort). A requested proof is never silently dropped; only when no command is configured is there no block.

```bash
vanguard run --github 123 --visual-proof "pnpm exec playwright test --project=chromium"
# or set for all runs:
VANGUARD_VISUAL_PROOF_CMD="pnpm exec playwright test --project=chromium" vanguard watch --label vanguard
```
