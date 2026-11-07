# Run Vanguard on your own repo (GitHub Actions)

Label a GitHub issue, get back a reviewed draft PR. The target repo does not need Vanguard installed and does not carry the workflow steps: each workflow in your repo is a **thin caller** (triggers, permissions, an actor gate, a `uses:` line) of a **reusable workflow** that lives in `spietrza/taskcell`. The reusable workflow checks Vanguard out beside your code, builds it, and runs it in a Docker sandbox on the GitHub runner.

You drop in **one or two thin callers** (implement, plus the optional doctor), set **one secret** and **one repo setting**, run the doctor once, then label an issue. A ready-made **issue template** is optional — it is just a convenient way to produce issues that pass triage; bring your own or none, as long as your issues meet [the triage contract](#what-an-issue-must-contain-the-triage-contract).

> **Cost:** each run uses ~15-20 GitHub Actions minutes — **unlimited on public repos**, 2000/month free on private. To avoid Actions minutes entirely, run an always-on `vanguard watch` on your own host (see [Cost & limits](cli.md#cost-and-limits) and [docs/deploy.md](deploy.md)).

---

## 1. The files

### How it fits together

| You own (in your repo) | Vanguard owns (`spietrza/taskcell/.github/workflows/`) |
|---|---|
| `on:` triggers, `permissions`, `concurrency` | the steps: checkout, build, label bootstrap, the CLI call |
| the `if:` actor gate, the `allowed-actors` list | timeouts, runner, flag assembly |
| model choices, secret mapping | defaults, label colours, the sandbox image build |

When Vanguard changes a default or a step, you get it on your next run (or when you move your pin) without touching your callers. Reusable workflows exist for `implement.yml`, `pr-review.yml`, `research.yml`, `revise.yml` and `doctor.yml`.

Things to know before copying:

- **Pin the ref.** `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` follows the moving `v1` tag (moved by hand once Vanguard's own factory is green on `main`). `@main` follows the tip immediately — a bad change then hits every repo at once, so prefer `@v1`.
- **`vanguard-ref` follows the workflow ref.** Leave the `vanguard-ref` input empty and the CLI is built at the same revision as the YAML, so a caller pinned `@v1` builds Vanguard at `v1` too. Set it only to build a different revision (for example to test a branch). On GitHub Enterprise Server `job.workflow_sha` / `job.workflow_repository` are not available, so set `vanguard-ref` explicitly there or the run fails at the "Resolve vanguard source ref" guard.
- **No `secrets: inherit`.** Each secret is mapped explicitly in the caller, so you can see exactly which credentials reach the run. Every secret is optional on the reusable side; map only what your setup needs.
- **`allowed-actors` is mandatory.** It is a JSON array of GitHub logins, passed as a string. The reusable workflow checks `github.event.sender.login` against it as a backstop to your own `if:`; a caller that omits it fails at startup, and a sender not in the list fails the run loudly (red, with an error) rather than skipping it, so a typo in the list cannot hide as a green no-op. Keep your caller's `if:` as well — it also gates on the issue or PR author, which the backstop does not.
- **Inputs never reach a shell as text.** The reusable workflows pass every input through `env:` and build the CLI arguments as a bash array, so a hostile value cannot inject a command.

### Permissions the caller must grant

The reusable workflows declare no `permissions:` of their own — they run with whatever the caller grants. A caller that omits the block on a repo whose default `GITHUB_TOKEN` is read-only fails mid-run (at `gh label create`, `gh pr create` or the comment post), not at startup. What each one needs:

| Reusable workflow | `contents` | `pull-requests` | `issues` |
|---|---|---|---|
| `implement.yml` | write | write | write |
| `doctor.yml` | read | read | write |
| `pr-review.yml` | read | write | write |
| `research.yml` | read | — | write |
| `revise.yml` | write (pushes the revision commit) | write | write |


### `.github/workflows/vanguard-implement.yml` — does the work

The **minimal** form: Claude does plan/implement/review/simplify, and the model credential stays in a sidecar (`llm-proxy`). Replace every `YOUR_LOGIN`.

```yaml
name: Vanguard Implement
on:
  issues:
    types: [labeled]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
concurrency:
  group: vanguard-implement-${{ github.repository }}
  cancel-in-progress: false
jobs:
  implement:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.actor == 'YOUR_LOGIN') ||
      (github.event_name == 'issues' &&
      contains(fromJSON('["ready for spec","ready for agent"]'), github.event.label.name) &&
      github.event.issue.user.login == 'YOUR_LOGIN' &&
      github.event.sender.login == 'YOUR_LOGIN')
    uses: spietrza/taskcell/.github/workflows/implement.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
      llm-proxy: true
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

To run Opus-spec / Sonnet-impl / Codex-review on a ChatGPT subscription instead, see [Full: cross-provider](#full-cross-provider-on-a-codex-subscription) below.

The reusable workflow installs Vanguard with `pnpm install --ignore-workspace`, which is what keeps this working when **your repo is a pnpm workspace (monorepo)**: otherwise `pnpm install` inside `.vanguard-src` would be captured by your root `pnpm-workspace.yaml`, leave `.vanguard-src/node_modules` empty, and the Vanguard build would fail. You do not need to do anything for this.

#### Inputs of `implement.yml`

| Input | Type | Default | Meaning |
|---|---|---|---|
| `allowed-actors` | string, **required** | — | JSON array of logins allowed to trigger the run |
| `provider` | string | `''` (CLI default) | implementation provider (`--provider`) |
| `provider-model` | string | `''` | implementation model (`--provider-model`) |
| `spec-model` | string | `''` | model for the spec pass (`--spec-model`) |
| `review-provider` | string | `''` | cross-provider reviewer, e.g. `codex` (`--review-provider`) |
| `review-model` | string | `''` | reviewer model (`--review-model`) |
| `escalate-model` | string | `''` (off) | model escalated to on the 2nd+ gate repair (`--escalate-model`); must be a model of the implementation provider |
| `fallback-provider` | string | `''` (off) | `--fallback-provider`: provider the implementer (and every other stage on its provider) retries on when the primary one throws (outage, usage limit, revoked credential); must be on a different transport, e.g. `codex` for a `claude` implementer |
| `fallback-model` | string | `''` (provider default) | `--fallback-model`: model for the fallback implementer |
| `conformance` | boolean | `false` | opt-in conformance review pass (`--conformance`) |
| `conformance-model` | string | `''` | model for the conformance pass |
| `llm-proxy` | boolean | `false` | keep the model credential in a sidecar (`--llm-proxy`) |
| `decision-probe` | boolean | `false` | opt in to the decision-model probe (see below) |
| `persist-metrics` | boolean | `false` | push run metrics to an orphan branch (see below) |
| `metrics-branch` | string | `''` (`vanguard-metrics`) | branch used by `persist-metrics` |
| `upload-run-records` | boolean | `false` | upload `.vanguard/runs/` as a workflow artifact (see below) |
| `skills` | string | `.vanguard-src/skills` | `--skills`: Vanguard's bundled skills; keep the default. Your repo's own skills go in `.github/vanguard-skills/<name>/SKILL.md` and are merged in automatically, no input needed ([Custom skills](skills.md#custom-skills-bring-your-own)). GitHub, GitLab and Projects runs used to ignore this input; they now read it, so a custom path that does not exist fails the run at startup |
| `max-tasks` | string | `''` (no cap) | `--max-tasks`: cap ready issues claimed per phase in one run |
| `vanguard-ref` | string | `''` (the workflow's own ref) | Vanguard source ref to build |

Secrets: `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AUTH_TOKEN` (all optional).

Empty model inputs mean "use the CLI default", so the defaults live in one place (the CLI), not duplicated in YAML.

#### `decision-probe`, `persist-metrics` and `upload-run-records` are off by default — on purpose

- **`decision-probe`** is the experimental, log-only [difficulty probe](cli.md#decision-models): it asks a decision model how hard the task is and whether the first attempt will pass, logs the answer, and changes nothing about routing. It **sends the issue title, labels, description and comments to Cloudflare Workers AI** from the host, outside the sandbox, `--egress` and `--llm-proxy`. With it off (the default) the Cloudflare secrets are not even exposed to the run, even if you map them. Turn it on only if you accept that, and map `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN`.
- **`persist-metrics`** pushes the run's `metrics.jsonl` lines to an orphan `vanguard-metrics` branch **in your repo** (`vanguard stats --branch vanguard-metrics` reads it back). That writes a branch into your repository and leaves a trace, which conflicts with white-label or zero-trace setups. Without it, metrics die with the job. It runs after the loop step finished, pass or fail (`always()` plus the step conclusion), but not after a blocked gate or a failed build, and needs the `contents: write` your caller already grants.
- **`upload-run-records`** uploads the job's `.vanguard/runs/` (per-stage JSON records, agent transcripts, diffs, `metrics.jsonl`) as a `vanguard-runs` workflow artifact kept for 14 days, so a run can be inspected after the job is gone: `gh run download <run-id> -n vanguard-runs`. Artifacts are downloadable by anyone with read access to the repository, which on a public repo means any signed-in GitHub user. Three guards apply regardless: transcripts and `finalText` are written through `redactTokens` (known token shapes masked), a secret-blocked run or a stage whose diff the scan flags leaves no `.diff`, `.bundle` or transcript on disk (`diffOmitted` on the record says why), and git bundles are never uploaded (the PR already carries that history). The scan exempts test paths (`*.test.ts`, `tests/**`, see `isTestPath`), so a credential the agent put in a fixture is in the stored diff exactly as it would be in the PR. Everything else the agent read or printed is in the transcript. Same gate as `persist-metrics`; `revise.yml` takes the same input.

Vanguard's own callers turn all three on; client repos should decide deliberately.

### `.github/workflows/vanguard-doctor.yml` — validate before your first issue

```yaml
name: Vanguard Doctor
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
  pull-requests: read
concurrency:
  group: vanguard-doctor-${{ github.repository }}
  cancel-in-progress: true
jobs:
  doctor:
    if: github.actor == 'YOUR_LOGIN'
    uses: spietrza/taskcell/.github/workflows/doctor.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Inputs: `allowed-actors` (required), `provider`, `review-provider`, `vanguard-ref`. Pass the same `provider` / `review-provider` as your implement caller (and map `CODEX_AUTH_JSON` if you review with Codex) so it validates the credentials the real run will use.

Run it from **Actions → Vanguard Doctor → Run workflow** (clickable from the GitHub mobile app). It processes no issues; it just checks Node, auth, labels, Docker, the sandbox image, and the repo remote, then goes green or red. Run it once on a fresh repo before you label anything.

### `.github/workflows/vanguard-pr-review.yml` — review a PR (optional)

Adds a visible, adversarial `gh pr review` when you put `ready for vanguard review` on your own PR. This example reviews with Codex and falls back to Claude if Codex fails (a usage limit, a bad model name). `watch-prs` has no provider fallback of its own, so `pr-review.yml` retries with `fallback-provider` / `fallback-model` when you set them.

```yaml
name: Vanguard PR Review
on:
  pull_request_target:
    types: [labeled]
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: write
  issues: write
concurrency:
  group: vanguard-pr-review-${{ github.repository }}
  cancel-in-progress: false
jobs:
  review:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.actor == 'YOUR_LOGIN') ||
      (github.event_name == 'pull_request_target' &&
      github.event.label.name == 'ready for vanguard review' &&
      github.event.pull_request.draft == false &&
      github.event.pull_request.user.login == 'YOUR_LOGIN' &&
      github.event.sender.login == 'YOUR_LOGIN')
    uses: spietrza/taskcell/.github/workflows/pr-review.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
      author: YOUR_LOGIN
      provider: codex
      review-model: gpt-5.6-sol
      fallback-provider: claude
      fallback-model: opus
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

Inputs: `allowed-actors` (required), `provider`, `review-model`, `fallback-provider`, `fallback-model`, `author` (`--author`), `llm-proxy`, `skills` (default `.vanguard-src/skills`, as for `implement.yml`: keep the default; a custom path that does not exist fails the review step), `vanguard-ref`. Leave the fallback inputs empty for no fallback. The fallback provider is preflighted too; if its *credential* is missing the job warns (step annotation + run summary) and reviews without a fallback rather than failing before the primary provider runs, so a Codex primary keeps working while the Claude secret is unset. Any other fallback preflight failure — an unknown provider name, a malformed `CODEX_AUTH_JSON` — fails the run, as for the primary. The fallback fires whenever the first attempt exits non-zero. It keeps the event hint, so the just-labeled PR is found even when the label search lags behind the label restore the failed attempt made; a head the first attempt already reviewed no longer carries the trigger label and is skipped. The one residual: a review that posted but whose label update then failed gets a second review. Do not combine `llm-proxy` with a Codex subscription (see the Full tier below).

### `vanguard-research.yml` and `vanguard-revise.yml` (optional)

Same shape: a caller with its triggers, permissions, `concurrency` and `if:`, plus `uses: spietrza/taskcell/.github/workflows/research.yml@v1` or `.../revise.yml@v1`.

| Workflow | Inputs | Secrets |
|---|---|---|
| `research.yml` | `allowed-actors`, `number` (issue number, required), `provider`, `research-model`, `vanguard-ref` | `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON` |
| `revise.yml` | `allowed-actors`, `number` (PR number, required), `provider`, `llm-proxy`, `upload-run-records`, `skills` (default `.vanguard-src/skills`; keep it, a missing custom path fails the run), `timeout-minutes` (default 90), `vanguard-ref` | `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, `VANGUARD_PUSH_TOKEN` |

Inside a called workflow the `inputs` context means the `workflow_call` inputs, not your `workflow_dispatch` ones, so the caller passes the number in: `number: ${{ github.event.issue.number || inputs.issue }}` for research, `number: ${{ github.event.pull_request.number || inputs.pr }}` for revise. Revise runs at most 2 rounds.

**Needs a human edit — `revise.yml` has no `fallback-provider`/`fallback-model` inputs yet.** `revise-pr` (the CLI `revise.yml` calls) now accepts `--fallback-provider`/`--fallback-model` and retries a rate-limited or otherwise-unavailable primary provider on the fallback inside the one CLI call — unlike the PR-review path, there is no separate preflight or shell-level retry to add. Vanguard cannot make this edit itself (`.github/workflows/**` is a hard constraint); apply it by hand to `revise.yml`:

```yaml
# workflow_call.inputs: add alongside `provider`
      fallback-provider:
        description: 'Provider to retry revision stages on when the primary one throws (outage, usage limit, rate limit, revoked credential). Empty = no fallback. Must be on a different transport than `provider`.'
        type: string
        default: ''
      fallback-model:
        description: 'Model for the fallback provider. Empty = its default.'
        type: string
        default: ''
```

and in the `Revise the PR from review comments` step, add the two inputs to its `env:` and forward them as flags:

```yaml
          IN_FALLBACK_PROVIDER: ${{ inputs.fallback-provider }}
          IN_FALLBACK_MODEL: ${{ inputs.fallback-model }}
        run: |
          ...
          [ -n "$IN_FALLBACK_PROVIDER" ] && args+=(--fallback-provider "$IN_FALLBACK_PROVIDER")
          [ -n "$IN_FALLBACK_MODEL" ] && args+=(--fallback-model "$IN_FALLBACK_MODEL")
```

Then set them on your `vanguard-revise.yml` caller the same way as `pr-review.yml`'s (e.g. `fallback-provider: claude`, `fallback-model: opus` behind a `codex` primary).

**Separately, this repo's own `vanguard-pr-review.yml` caller already could set a fallback and doesn't.** `pr-review.yml` has accepted `fallback-provider`/`fallback-model` since before this change (see the example above) — no code or schema edit needed there, only a `with:` value. The Claude-subscription 429 that stalled #609 would have retried immediately on a fallback provider/model if one had been configured on that caller. This is a plain config value, not a workflow-structure change, but it still lives under `.github/workflows/` and so still needs a human to add it.

The revise gate differs from the PR-review one: Vanguard's own PRs are authored by `github-actions[bot]`, so the **author** list must include it while the **sender** list stays human. A caller that copies the PR-review gate (`pull_request.user.login == 'YOUR_LOGIN'`) can never run:

```yaml
name: Vanguard Revise
on:
  pull_request_target:
    types: [labeled]
  workflow_dispatch:
    inputs:
      pr: { description: "PR number", required: true }
permissions:
  contents: write          # pushes the revision commit to the PR branch
  pull-requests: write
  issues: write
concurrency:
  group: vanguard-revise-${{ github.repository }}
  cancel-in-progress: false
jobs:
  revise:
    if: >-
      (github.event_name == 'workflow_dispatch' && github.actor == 'YOUR_LOGIN') ||
      (github.event.label.name == 'needs revision' &&
       contains(fromJSON('["YOUR_LOGIN","github-actions[bot]"]'), github.event.pull_request.user.login) &&
       github.event.sender.login == 'YOUR_LOGIN')
    uses: spietrza/taskcell/.github/workflows/revise.yml@v1
    with:
      allowed-actors: '["YOUR_LOGIN"]'
      number: ${{ github.event.pull_request.number || inputs.pr }}
      llm-proxy: true
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      VANGUARD_PUSH_TOKEN: ${{ secrets.VANGUARD_PUSH_TOKEN }}
```

`revise.yml` checks your default branch out with `persist-credentials: false` and feeds git a credential helper from `VANGUARD_PUSH_TOKEN` (falling back to the workflow token), so it also works on **private repos** where the engine's own `git fetch` of the PR branch needs auth.

### `.github/ISSUE_TEMPLATE/vanguard-task.md` — optional, the issue shape triage accepts

**Optional.** You are not required to copy this. You can use your own issue template, or none — what matters is that the issues you label meet [the triage contract](#what-an-issue-must-contain-the-triage-contract). This template is simply the shortest path to issues that pass: it pre-fills the `## Acceptance Criteria` heading and the `ready for agent` label. Without any template, **New issue** gives a blank form and it is easy to omit the heading triage requires.

```markdown
---
name: Vanguard Task / Agent Implementation
about: Submit a well-defined task ready for automatic implementation by Vanguard.
title: "[TASK] "
labels: ready for agent
assignees: ''
---

## 🎯 What are we building? (Context & Goal)
<!-- 1-2 sentences: the goal, and why. -->

## ✅ Acceptance Criteria
<!-- The MOST IMPORTANT section. Replace the examples with real, testable criteria. -->
- [ ] Feature X functions as intended.
- [ ] Tests cover the change.
- [ ] CI passes.

## 🛠 Technical Context / Scope of Changes
* **Main files/modules to modify:** `src/path/to/file.ts`
* **Known constraints:** `...`

---
### 🤖 Triage Instructions (For Humans)
* Change the label to `ready for spec` if this is a high-level idea Vanguard should research and write a Tech Spec for first.
* Leave it `ready for agent` if it is precisely scoped and Vanguard should implement straight away.
```

---

## 2. Secrets and repo setting (one-time)

1. **Secret `CLAUDE_CODE_OAUTH_TOKEN`** — Settings → Secrets and variables → Actions → New repository secret. Generate it locally with `claude setup-token`.
2. **Repo setting** — Settings → Actions → General → Workflow permissions → enable **"Allow GitHub Actions to create and approve pull requests"**. Without it the agent does all the work and then `gh pr create` fails. (CLI: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -F can_approve_pull_request_reviews=true`.)
3. (Full tier only) **Secret `CODEX_AUTH_JSON`** — see below.
4. (Recommended) **Secret `VANGUARD_PUSH_TOKEN`** — see [CI on factory PRs and revision pushes](#optional-vanguard_push_token--ci-on-factory-prs-and-revision-pushes).

Replace `YOUR_LOGIN` in the callers with your GitHub login, and set `allowed-actors` to the logins that may trigger runs. The `if:` gate restricts runs to your own issues, so a stranger labelling an issue cannot start a run; `allowed-actors` is the second lock behind it.

### Optional: `VANGUARD_PUSH_TOKEN` — CI on factory PRs and revision pushes

**When you need it:** your default branch is protected **and** its required status checks gate merges. Only then does this token buy hands-free CI on factory PRs and revisions. No branch protection, or no required checks? Skip this section; PRs still merge, they just miss a CI run.

**The problem.** GitHub's recursion guard means **events created by `GITHUB_TOKEN` trigger no workflows**. The implement pass opens its PR with the workflow's built-in `GITHUB_TOKEN`, so a new factory PR gets no CI run; the revise pass (`needs revision` label) pushes fix commits with it, so a revised PR gets no fresh CI run either. The same guard applies when revise un-drafts the PR at the end of a round: a `ready_for_review` event from `GITHUB_TOKEN` starts no review either. If the repo has branch protection with required checks, the PR sits `BLOCKED` until a human nudges it (an empty commit, or close/reopen); without protection it can be merged with stale or no CI.

**The fix.** A fine-grained Personal Access Token: a PR opened and pushes made with a PAT count as user events, so `pull_request: opened` / `synchronize` fire and CI runs normally. The factory PR then shows the PAT's owner as its author (the commit author is unchanged), and that account cannot approve it if your branch protection requires approvals. This is **provider-independent** — it is about the git push, not about which model (Claude, Codex, …) wrote the revision. Do not confuse it with `CODEX_AUTH_JSON` (LLM auth for the Codex reviewer); they are unrelated secrets.

1. Create the PAT: github.com → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate. Repository access: **Only select repositories** → this repo (add every repo that runs Vanguard if you want one token for all of them). Permissions: **Contents → Read and write** and **Pull requests → Read and write** (to open the factory PR) — nothing else (Metadata: Read is added automatically). Do **not** grant Workflows: that would let the autonomous reviser rewrite the very workflows that carry its actor gates and secrets. A revision that touches `.github/workflows/` is rejected by GitHub by design; apply such edits by hand. Set an expiration (e.g. 90 days).
2. Store it: `gh secret set VANGUARD_PUSH_TOKEN --repo OWNER/REPO` (repeat per repo — Actions secrets are per-repo, even when the PAT itself covers several).
3. Map it in the `secrets:` block of your implement and revise callers:

   ```yaml
   secrets:
     CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
     VANGUARD_PUSH_TOKEN: ${{ secrets.VANGUARD_PUSH_TOKEN }}
   ```

Both runs pick it up automatically when present, on the host only (it never enters the sandbox), and fall back to `GITHUB_TOKEN` when absent (PRs and pushes still work — they just don't trigger CI). A token without Pull requests write makes the implement run log a warning and open the PR with `GITHUB_TOKEN`. Push errors are redacted so the token cannot leak into logs or comments.

**Renewal.** Fine-grained PATs expire; GitHub emails you before expiry. Renew = generate a new token with the same scope and re-run `gh secret set` for each repo. Nothing else to change.

**Trust note.** The PAT acts as you, limited to `contents: write` and `pull_requests: write` on the selected repos. It cannot edit workflows (no `workflow` scope) and cannot bypass branch protection required checks.

---

## 3. Validate, then use it

1. **Validate:** run **Vanguard Doctor** once. Green means secrets, labels, Docker, and the sandbox image are all in place.
2. **Create an issue:** New issue → the **Vanguard Task** template. Fill in real Acceptance Criteria (replace the placeholders).
3. **Label it:**
   - `ready for agent` — the task is precisely scoped (you wrote the criteria); Vanguard builds it directly.
   - `ready for spec` — a rough idea; Vanguard writes a Tech Spec first, then builds it.
4. Vanguard opens a **draft PR** and moves the issue through `vanguard:running` → `vanguard:needs-human-review`. Its title is prefixed with a Conventional-Commits type (`fix:` for an issue carrying a `bug` label, `feat:` otherwise, plus an optional scope) — if your repo runs [release-please](https://github.com/googleapis/release-please) with squash-merge set to **"Default to pull request title"**, that prefix is what lands in the squash commit release-please reads, so the PR's changes reach the changelog and version bump without a human retitling it by hand first.

---

## Choosing the models

Models are set once, in the `with:` block of your implement caller — globally for the repo, not per issue. Empty means the CLI default (all-Claude). Override with inputs:

| Stage | Input | Example |
|---|---|---|
| Plan (spec) | `spec-model` | `opus` |
| Implement + simplify | `provider` / `provider-model` | `claude` / `sonnet` |
| Review | `review-provider` (+ `review-model`) | `codex` / `gpt-5.6-sol` |
| Escalation | `escalate-model` | `claude-fable-5-1` (example; off unless set) |

To change which models run, edit the caller's `with:` block. A cross-provider reviewer (e.g. Codex) takes its own model names — never pass it an Anthropic model name. On a ChatGPT subscription only Codex-flavoured names work (e.g. `gpt-5.6-sol`); a bare `gpt-5.6` is rejected with a 400.

### Full: cross-provider on a Codex subscription

To run **Opus** spec / **Sonnet** impl / **Codex** review with Codex on a ChatGPT Plus/Pro subscription (no OpenAI API key):

1. Add the credential as a secret (it holds OAuth tokens from `codex login`, not an API key):
   ```bash
   gh secret set CODEX_AUTH_JSON --repo OWNER/REPO < ~/.codex/auth.json
   ```
2. In the implement caller, set the model inputs, map the secret, and **drop `llm-proxy`** (a subscription talks to the ChatGPT backend, which the proxy allowlist does not cover):
   ```yaml
       uses: spietrza/taskcell/.github/workflows/implement.yml@v1
       with:
         allowed-actors: '["YOUR_LOGIN"]'
         provider: claude
         provider-model: sonnet
         spec-model: opus
         review-provider: codex
         review-model: gpt-5.6-sol
       secrets:
         CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
         CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
   ```

The stored `CODEX_AUTH_JSON` is a snapshot; Codex refreshes the access token from the embedded refresh token each run, so the secret must carry a live refresh token. Re-run `gh secret set` if a run ever fails to authenticate.

---

## One run, spec and build

`watch --once` does a spec pass then an implement pass in the same invocation. A `ready for spec` ticket is specced and built in one job: the spec pass generates the tech spec and advances the ticket to `ready for agent`, and the implement pass immediately picks it up without relying on GitHub's label index (which has eventual-consistency lag). A `ready for agent` ticket that was already labelled before the run is also picked up in the same pass.

## What an issue must contain (the triage contract)

This is the only hard requirement on issue content — independent of whether you use the template, your own, or none. Before spending model budget, the implement pass refuses an under-specified ticket. To pass, a `ready for agent` issue needs **one** of:

- a `## Acceptance Criteria` markdown heading (any level, emoji prefix is fine) followed by at least one **real** bullet (the template's example bullets do not count — replace them), **or**
- a Vanguard `<tech_spec>` comment, which the spec pass writes automatically for tickets you label `ready for spec`.

What does **not** pass: a plain `Acceptance criteria:` line with no `#` heading, or only the placeholder bullets. A ticket that meets neither condition is moved to `needs info` with a comment explaining what to add; fill it in and re-label.

So: do whatever you like for issue authoring (template, your own, freehand) — just make sure a `ready for agent` issue carries that heading + real bullets, or hand it to the spec pass with `ready for spec`.

## Label reference: routing vs enrichment

| Label | Set by | Bot state | Meaning | Bot action | Auto-advance? |
|---|---|---|---|---|---|
| `ready for spec` | Human | `vanguard:speccing` | Ticket is ready to be specced | Generate tech spec, post `<tech_spec>` comment, advance to `ready for agent` | Yes → `ready for agent` |
| `ready for agent` | Human or spec pass | `vanguard:running` | Ticket is ready to implement | Implement and open a draft PR | Yes → `vanguard:needs-human-review` |
| `needs info` | **Vanguard triage** (`assessTaskReadiness`) | — | Ticket is too vague to proceed — **rejected/parked** | Post clarification comment, stop | No — human must add content |
| `needs research` | **Human** (manually) | `vanguard:researching` | Ticket is a valid idea needing **external context** before speccing | Run external research, post findings comment, **REST** | No — human sets `ready for spec` or `ready for agent` next |

The labels above go on **issues**. Two more go on a **pull request** and fire the `pull_request_target: labeled` workflows — these need the `vanguard-pr-review.yml` and `vanguard-revise.yml` callers added alongside the implement/doctor pair.

| Label | On | Set by | Bot state | Bot action |
|---|---|---|---|---|
| `ready for vanguard review` | PR (trusted author's, non-draft) | Human | `vanguard:reviewing` → `vanguard:reviewed` | Adversarial **read-only** review — posts a comment, never edits code. Re-apply for a fresh pass. |
| `needs revision` | PR (trusted author's) | Human | `vanguard:revising` | Reads your review → pushes fix commits to the PR branch → un-drafts → back to `vanguard:needs-human-review`. Iterative: re-apply to loop. Needs `VANGUARD_PUSH_TOKEN` (section above) or the revised PR gets no CI. |

`ready for vanguard review` reviews *your* PR (read-only); `needs revision` has Vanguard *edit* a trusted author's draft per your review. Both gate on a trusted PR author **and** label-setter, same allowlist as the issue workflows.

### `needs research` vs `needs info`

These are orthogonal signals and must not be conflated:

- **`needs info`** is an automated *rejection* for under-specified tickets. Vanguard sets it when `assessTaskReadiness` fails (description too short, no acceptance criteria). The human must add content before the ticket can be picked up again.
- **`needs research`** is a human-initiated *enrichment* request for a well-formed ticket that would benefit from external context (prior art, standards, library docs). Vanguard does not apply the `needs_info` gate to the research pass — external research is valuable even for a one-line idea, and gating it would conflate the two signals.

The research pass is **iterative and resting**: each time a human re-applies `needs research`, Vanguard posts a new research comment that builds on prior findings (appends — never replaces). The issue rests with no routing label after each run; the human decides what comes next.

### Egress note for `needs research`

The research sandbox runs under the same egress allowlist as the spec and agent passes by default (`api.anthropic.com` + package registries — no general web). The `--web` CLI flag declares that the operator has widened egress to allow web search/fetch. Without `--web`, the agent conducts model-knowledge research and the comment header says so. To enable true web research, add the following hosts to a research-specific egress extension (do **not** widen `DEFAULT_EGRESS_ALLOWLIST` for the build passes):

- Common documentation hosts: `developer.mozilla.org`, `docs.github.com`, `pkg.go.dev`, `docs.rs`
- Standards bodies: `datatracker.ietf.org`, `www.w3.org`, `tc39.es`
- General search/fetch: your preferred search API endpoint

`research.yml` does not offer `--web` as an input: widening egress is a deliberate, per-host decision, not a toggle.
