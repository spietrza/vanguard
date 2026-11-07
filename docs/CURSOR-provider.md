# Provider note — `cursor`

`--provider cursor` (and `--review-provider` / `--fallback-provider cursor`) runs a stage on the
[Cursor CLI](https://cursor.com/docs/cli/overview) (`agent`) inside the sandbox, in headless print mode:

```bash
agent -p --output-format stream-json --trust --sandbox disabled [--model <m>] [--resume <chatId>]
```

The prompt goes on stdin. Before each call the provider writes a permission allowlist
(`Shell(*)`, `Read(**)`, `Write(**)`) into the sandbox's `~/.cursor/cli-config.json`, keeping the rest of
the file. It does this instead of passing `--force`, because a team admin can disable "Run Everything", and then
`--force` aborts the run. Without either one, print mode rejects every shell command except `ls`.
`--sandbox disabled` turns off Cursor's own sandbox. In both cases the Vanguard container is the
boundary, as with codex's `danger-full-access`.

## Setup

1. **Key.** Create a user API key at [cursor.com/dashboard/api](https://cursor.com/dashboard/api) and
   export it as `CURSOR_API_KEY`. It is forwarded into the sandbox only when cursor is selected, and a
   missing key fails at dispatch (and in `vanguard doctor`). Runs bill against that account's plan. Keys
   (`crsr_…`) are redacted from logs and blocked by the diff secret scan.
2. **Image.** The CLI is opt-in in the sandbox image. It adds about 760 MB. Build it with a version id from
   `cursor.com/install`:

   ```bash
   CURSOR_CLI_VERSION=2026.10.16-e3cb207 ./docker/build.sh
   ```

   The tarball is checked against a pinned per-arch sha256 (defaults match 2026.10.16-e3cb207). For another
   version, also set `CURSOR_CLI_SHA256_X64` / `CURSOR_CLI_SHA256_ARM64` (the `sha256sum` of each arch's tarball).

   `vanguard doctor` checks for `agent` in the image whenever cursor is one of the providers.
3. **GitHub Actions: not supported yet.** The reusable workflows do not install the Cursor CLI in the
   sandbox image and do not pass `CURSOR_API_KEY` through, so `provider: cursor` fails there. Cursor
   runs locally, on an always-on host and in the desktop app, wherever you build the image as in step 2.
   Workflow support (a `cursor-cli-version` input plus an optional `CURSOR_API_KEY` secret) is planned.

## Choosing a model

Model names work differently here than on `claude` or `codex`. Cursor does not take Anthropic or OpenAI
names as they are. It runs either one of its **Auto modes**, which pick a model on every call, or a
**Cursor model id**. These values work in `--provider-model`, `--review-model`, `--spec-model`,
`--fallback-model` and `--escalate-model`:

| Value                                                         | Runs                                    |
| ------------------------------------------------------------- | --------------------------------------- |
| nothing, or `auto`                                            | Auto Balance (the account default)      |
| `auto-balance` (= `auto-smart[optimize_for=balanced]`)        | Auto Balance                            |
| `auto-intelligence` (= `auto-smart[optimize_for=intelligence]`) | Auto Intelligence                     |
| `auto-cost` (= `auto-smart[optimize_for=cost]`)               | Auto Cost                               |
| an id from `agent models`, e.g. `claude-opus-5-5-high`, `gpt-5.6-sol-high`, `composer-2.5` | exactly that model (ids vary by account and plan) |

The short names are Vanguard's and translate to Cursor's `auto-smart[…]` form. They also fit a
`vanguard:model=auto-intelligence` issue label, while the long form exceeds GitHub's 50-character label
limit.

```bash
vanguard run --github o/r#1 --provider cursor --provider-model auto-intelligence --review-model auto-cost
```

The Claude tiers that Vanguard's presets pin (spec → `haiku`, planner → `opus`, escalation →
`claude-fable-5-1`) are not Cursor models. They map onto the matching Auto mode, so each stage keeps its
trade-off:

| Requested (alias or Anthropic id)                  | Runs on                                  |
| -------------------------------------------------- | ---------------------------------------- |
| `haiku`, `claude-haiku-*`                          | `auto-smart[optimize_for=cost]`          |
| `sonnet`, `claude-sonnet-*`                        | `auto-smart[optimize_for=balanced]`      |
| `opus`, `fable`, `claude-opus-*`, `claude-fable-*` | `auto-smart[optimize_for=intelligence]`  |

An Auto mode is not deterministic. In one run the implementer landed on Claude Opus 5.5 and the reviewer on
Grok 4.7. Run records and `stats` show the model Auto actually routed to, taken from the "> Auto routed to
…" notice. When there is no notice they show the mode's display name, for example "Auto Cost".

## Behaviour

- **Usage.** Token usage comes from the `result` event (input, output, cache-read). Cursor reports no
  cost.
- **Resume.** Repair-gate repairs and the spec resume nudge pass `--resume <chatId>`. The chat lives in
  the run's sandbox under `~/.cursor`. No session jsonl is captured or restored; that is Claude-only.
- **System prompt.** Cursor has no system-prompt flag, so a stage's system prompt goes at the start of
  the stdin prompt.
- **Skills.** They are injected as `.cursor/rules/<id>.mdc` (`alwaysApply: false`), with the bodies under
  `.vanguard/skills/`. Neither is copied back into the PR diff.
- **Egress.** `agent` honours `HTTPS_PROXY` and reaches only `api2.cursor.sh` and
  `agentn.*.api5.cursor.sh`. Both are covered by the `cursor.sh` allowlist entry.

## Limitations

- **No cost.** Stage cost is 0, so the run cost cap (`maxCostUsd`) and the per-stage caps never stop a
  cursor stage. Only the stage timeout does. `$or-est` shows `n/a`.
- **No max turns.** The CLI has no turn cap, so `maxTurns` is not enforced.
- **Not proxied.** Under `--llm-proxy` the Cursor key is still injected into the sandbox. The run still
  needs a primary-sidecar credential (Claude, z.ai or OpenRouter), even when every stage is cursor.
- **Hub live view.** The view reads Claude session files, so cursor stages do not stream there.

## Verified

Checked with CLI 2026.10.16-e3cb207 in the sandbox image, using a team key whose admin disabled "Run
Everything". The real `CursorProvider` ran with the prompt on stdin. It edited a file and ran a shell
command without `--force`. A second call with `--resume` in the same container recalled the first. The
`opus`/`haiku`/`claude-sonnet-5-5` requests ran on Auto Intelligence, Auto Cost and Auto Balance. The
recorded stream is the test fixture (`src/agents/cursor-stream.fixture.ndjson`). A full
`vanguard run --provider cursor --egress` on a GitHub issue ran with no Claude credential. Implementer,
reviewer and simplifier all completed, the gate passed, and it opened the PR in 210 s.
