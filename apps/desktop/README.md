# Vanguard Inspector

A local **Tauri 2** cockpit over [Vanguard](../../README.md) — watch, inspect, drive, and remotely
observe agent Runs. Rust backend · React 19 · Tailwind v4 · [chunks-ui](https://github.com/) · TypeScript.

## Run

```bash
cd apps/desktop
pnpm install
pnpm start        # = tauri dev  (also runnable from repo root: `pnpm start`)
```

First launch compiles the Rust crate (a few minutes), then opens the window. Add a project pointing at any
repo that contains a `.vanguard/` directory. Launch from a terminal so the app inherits your shell
environment (LLM/platform credentials) — see **Launching runs** below.

Gates: `cd src-tauri && cargo test` · `pnpm vitest run` · `pnpm build`.

## Driving the UI with an agent

The frontend is a plain Vite + React app that can run in any browser with a mocked backend — no Rust build,
no macOS, no `tauri-driver`. When `import.meta.env.DEV` is true and `window.__TAURI_INTERNALS__` is absent
(plain browser), `main.tsx` dynamically imports `src/dev/mockBackend.ts` which installs typed fixture data
via `@tauri-apps/api/mocks`. The `import.meta.env.DEV` guard lets Rollup statically eliminate the import
branch in production builds, so the mock chunk is never emitted into `dist/`.

**Start the dev server:**

```bash
pnpm --dir apps/desktop dev   # vite → http://localhost:1420, mocks auto-install
```

**Then drive it via Playwright MCP:**

```
browser_navigate       http://localhost:1420
browser_snapshot                      # a11y tree — read structure, find elements
browser_take_screenshot               # see pixels
browser_click / browser_type          # interact; click the left rail to change screen
```

The app renders with populated fixture data (two projects, three runs with full transcript/diff/proof,
board tasks, capabilities, flows). Navigate screens by clicking the rail icons exactly as a user would —
no URL routing needed.

## Hub mode

This same frontend also runs with no Tauri runtime at all, served by `vanguard hub` over plain
HTTP/SSE (see `../../docs/hub.md`). `src/transport.ts` is the seam: every `invoke`/`listen` call goes
through `invoke()`/`subscribe()`, which pick Tauri's IPC or the hub's `POST /rpc/<cmd>` + `/events` SSE
stream depending on `window.__VANGUARD_HUB__ === true` — the marker the hub injects into `index.html`
itself; its absence selects Tauri, the branch `vitest` and `dev/mockBackend.ts` always exercise.

The hub requires a **per-launch token** on every `/rpc/<cmd>` and on `/events`. It is never part of
`index.html`: the hub prints and opens a launch URL that carries it in the fragment
(`http://127.0.0.1:7777/#token=…`, never sent to the server). `transport.ts` moves it into
`sessionStorage` (key `vanguard-hub-token`), strips it from the address bar, and sends it from there
— so a reload keeps working, but a new tab opened on the bare URL has no token until it is given the
launch URL. **The page must be served by the hub**: `VITE_VANGUARD_HUB=1` on Vite's own dev server
(`http://localhost:1420`) is a dead end, since its same-origin `/rpc/<cmd>` goes to the dev server
(which proxies nothing to the hub). There is no escape hatch; to see a change against a real hub,
rebuild and let the hub serve it (first recipe below). The token is minted per launch, so restarting
the hub invalidates an already-open page — the UI says so; open the new launch URL to reconnect.

**Build the UI and run the hub against a real repo:**

```bash
pnpm --dir apps/desktop build          # emits apps/desktop/dist, which the hub serves
vanguard hub --repo /path/to/your/repo # from the repo root; prints the launch URL it opened
```

Reaching the hub under a hostname other than loopback or an IP literal needs that Host allowed —
`--allowed-host hub.example.com` (see `../../docs/hub.md`).

**What's absent in hub mode:**

- **Fleet** — dropped from the rail entirely. It spawns shell commands, which would be remote code
  execution on a reachable server; the hub's RPC dispatcher rejects the underlying commands too.
- **The native OS folder dialog** — there is no Tauri plugin in a browser. "Add a repo" opens
  `RepoPicker` instead, a modal that walks the filesystem via `browse_dirs` (confined server-side to
  the hub's browse root).

**Coverage guard:** `src/dev/mockBackend.test.ts` asserts that every `invoke` command string in
`src/ipc.ts` has a fixture. A new IPC command added without a matching case in `mockBackend.ts` fails
the test immediately.

## What it does (shipped)

- **Dashboard cockpit** — a card per project (runs, tasks, spend, failed, 24h velocity, relative
  last-activity) + a live summary strip (Projects / Running / Runs / Last 24h / Spend), polled every 5s.
- **Left rail** — Conductor-style project nav with live running-dots, add-project, ⌘K search, theme toggle.
- **Command palette (⌘K)** — jump to any project or action.
- **Run inspector** — breadcrumb nav (`Home / project / task`); a run's **Overview** (proof-of-work gate,
  per-stage cards with turns/duration/tokens/cost/model), **Spec** (source issue, best-effort via
  `gh`/`linear`), **Diff** (colored), **Transcript** (parsed agent stream + Show-raw toggle).
- **Watch mode** — a `notify` file-watcher on `.vanguard/` auto-refreshes the run list and open run as
  files change; in-flight runs surface as pulsing **running** rows with a **live transcript** (assistant
  markdown + tool calls + tokens), before their record even lands.
- **Launch (P1)** — a **New run** form (presets: Run issue / Watch fleet / GitLab MR) spawns a command in
  the project dir inheriting your env; streamed output panel + **Kill**. The launched run then shows live.
- **Remote runs (P4 slice)** — lists GitHub Actions runs via `gh run list`. **Fetch records** pulls a run's
  `vanguard-runs` artifact (`gh run download`) into the app config dir under
  `remote-runs/<owner-repo>/<run-id>/` and expands it into the same run rows as local runs; a row opens the
  same Overview / Diff / Transcript inspector. Already-downloaded runs carry a **cached** marker and open
  without `gh`. Needs the workflow's `upload-run-records` input on.
- **Per-project screens** (Inspector sub-nav) — **Runs · Board · Fleet · Remote · Workflow · Settings**:
  - **Task board** — tasks from the configured source (`linear`/`gh`) bucketed into lifecycle columns;
    card → **Task/spec detail** (source spec + run history + New Run). Best-effort (auth-dependent).
  - **Fleet** — Watch Loop start/stop, concurrency, Loop-v1, slot meter (spawns `vanguard watch`).
  - **Workflow** — visual block composer over `.vanguard/app.json` (blocks + inspector + Canvas/Source HCL).
  - **Settings** — the `.vanguard/app.json` config form (source, label, provider, verify, concurrency, budget).
- **Rich output** — markdown rendering, `highlight.js` code/JSON blocks, agent `<plan>`/`<findings>`/
  `<promise>` tags as colored callouts. Light + dark, persisted.

## Architecture

Typed JSON over Tauri IPC is the only boundary. `src/vanguard-output.d.ts` hand-mirrors the persisted
shapes (kept decoupled from Vanguard's build, per the design spec §4).

**Rust (`src-tauri/src/`)** — one module per concern, each with pure functions + unit tests, thin
`#[tauri::command]` wrappers in `lib.rs`:

| Module | Responsibility |
|---|---|
| `runs.rs` | Parse & group `.vanguard/runs` into summaries + run detail (diff/transcript/proof) |
| `active.rs` | Detect in-flight runs (fresh sessions); parse a session into a transcript + token totals |
| `projects.rs` | Persist the project list (OS app-config dir); aggregate per-project metrics + velocity |
| `watch.rs` | `notify` watcher per project → debounced `vanguard:changed` events |
| `spawn.rs` | Launch/kill runs (`sh -c` in the project dir, inherits env); stream output events |
| `spec.rs` | Best-effort fetch of a Task's source issue (`gh`/`linear`) |
| `remote.rs` | List GitHub Actions runs (`gh run list`); pull a run's record artifact into the local cache |

**React (`src/`)** — `App` (left-rail shell + ⌘K + theme), `features/dashboard`, `features/inspector`
(run list/detail/live/remote/launch/spec), `components/` (reusable `Markdown` / `CodeBlock` / `Callout` /
`AgentText`).

## Notes & limits

- **Credentials** are inherited from the operator environment; the app never stores or brokers them
  (design spec §12). A *bundled* `.app` launched from Finder has a minimal env — run from a terminal for
  now.
- **Task board "New Run" always uses the LLM proxy.** It goes through `sidecar.rs`'s `vanguard
  __sidecar` subprocess, the same `productionDeps()` dispatch the hub uses — see
  [Runs always use the LLM proxy](../../docs/hub.md#runs-always-use-the-llm-proxy) for which
  credentials that covers, which don't, and what a failed proxy sidecar looks like. **Launch** below is
  a different path and is not covered: it is an ordinary CLI invocation, so the CLI's own opt-in
  `--llm-proxy` (off by default) applies instead.
- **Launch command** is operator-supplied (a local run launcher, like a terminal) — spawned via `sh -c`
  in the project dir. Not untrusted input.
- **Spec / remote** fetches require an authed `gh` / `linear` on `PATH`; they fail gracefully otherwise.

## Remaining / to harden

Full-product design in `../../design/brief.md`; rendered mockups in `../../docs/design/screens/`.

- **Workflow editor** — currently a config-backed block composer; the full drag-graph + HCL/JSONC
  round-trip (spec §13) awaits the format spike ("spike both").
- **Task board / spec fetch** — best-effort via CLI (`gh`/`linear`); needs live verification against
  authed sources + refined state→column mapping.
- **Remote depth** — live log tail (`glab ci trace`), GitHub↔GitLab parity (spec §14).
- **Shell** — the design puts the per-project screens in the left rail (project switcher); the build
  hosts them as an Inspector sub-nav. Cosmetic alignment to the mockups is pending.
