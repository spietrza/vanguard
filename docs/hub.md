# Vanguard Hub

`vanguard hub` serves the same Inspector UI the Tauri desktop app ships (`apps/desktop`) over plain
HTTP/SSE, backed by a real `.vanguard/` directory. Useful when you want the cockpit without installing
a native app, or running it on a server. See `src/hub/*.ts` and `src/cli/hub.ts` for the implementation.

## Quick start

```bash
pnpm build:ui && pnpm hub --repo /path/to/your/repo
```

This opens a browser at the printed launch URL, `http://127.0.0.1:7777/#token=…`. The fragment holds
the per-launch token the UI needs; the served page itself carries none, so open that exact URL (from
the terminal, or `docker logs` in container mode) rather than the bare address.

### Prerequisites

- Node 24 and pnpm; `pnpm install` at the repo root (the UI bundle is a separate pnpm project that
  `pnpm build:ui` installs and builds).
- `gh auth login` — the Task board, Remote and cloning private repositories go through `gh`.
- For runs started from the hub: Docker with the sandbox image (`docker/build.sh` builds
  `vanguard-sandbox:latest`; the egress proxy sidecar uses the same image, so a missing image
  surfaces as "Failed to start egress enclave"), and the provider credential exported in the shell
  that starts the hub — `CLAUDE_CODE_OAUTH_TOKEN` for Claude (`claude setup-token`), or the
  provider's own variable. The hub passes its environment to the run; a launcher without a shell
  (an IDE "launch" entry, a Compose file without `environment:`) has no token, and the first run
  fails at start.
- A project is a git work tree. Its `.vanguard/app.json` (task source, labels, provider, budget) is
  what the Settings screen edits; a repo without one works with the defaults.

## Three ways to use it

1. **Local factory.** Add the project, open the Task board, click **New Run** on an issue. The
   pipeline runs in the sandbox on this machine; the Runs screen shows the live transcript and, when
   it ends, every stage's record, diff, transcript, proof of work and visual proof. The PR lands on
   GitHub/GitLab like any other Vanguard run.
2. **Observe the CI factory.** Keep running Vanguard in GitHub Actions (see
   [onboarding-another-repo.md](onboarding-another-repo.md); the callers must pass
   `upload-run-records: true`) and use the hub read-only: Remote lists the repo's CI runs,
   **Fetch records** imports a run's `vanguard-runs` artifact into `.vanguard/remote-runs/<id>`, and
   the records open like local ones. No token, no Docker, no sandbox on this machine. The Task board
   header counts the factory's work from issue labels — `Running N` (claimed or running) and
   `Waiting K` (labelled `ready for agent`/`ready for spec`, not yet picked up) — so it shows the CI
   backlog too. A `+` (`12+`) means the board holds only its first page of issues and the count is a
   lower bound.
3. **Self-hosted.** Build `docker/hub.Dockerfile`, run it on a VPS (Coolify, Hetzner) behind Tailscale
   or an authenticating reverse proxy, and reach it from a laptop or a phone. Agent code runs on
   that host, so it needs Docker and the token there. Local mode has no login of its own: never
   publish the port. `VANGUARD_HUB_ALLOW_ADD=1` enables Add project and Clone repository on a
   non-loopback bind (see [Modes](#modes) and [Coolify / Docker Compose](#coolify--docker-compose)).
   Reaching it under a hostname (rather than an IP address) needs that hostname allowed:
   `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (or `--allowed-host hub.example.com`).

## Runs always use the LLM proxy

This is not hub-specific: it is `productionDeps()`'s behavior (`src/sidecar/deps.ts`), so it applies to
**every** run started through the sidecar protocol — `vanguard __sidecar` — which both the hub's own
dispatch and the desktop app's Task-board **New Run** use identically (the desktop spawns the same
`vanguard __sidecar` subprocess; see `../apps/desktop/README.md`). A desktop **Launch** command, or
`vanguard run`/`vanguard watch` invoked directly from a terminal, is a different path — plain CLI
invocations, which keep the CLI's own opt-in `--llm-proxy` (off by default) instead of this rule.

Every run on that path runs with the LLM proxy whenever the run has a credential the proxy's
trusted sidecar can hold — a Claude subscription token or `ANTHROPIC_API_KEY`, or z.ai's / OpenRouter's
key when that provider implements. The sidecar on the host keeps the real credential and the sandbox
gets a per-run nonce instead, so agent code never sees the token. Unlike the CLI's opt-in
`--llm-proxy`, this path has **no switch to turn this off** — no flag, no env var, no
`.vanguard/app.json` setting.

Three kinds of run go without it. There the credential *is* in the sandbox, so the run view shows a
warning naming the provider rather than leaving the exposure silent:

- **Codex on a ChatGPT subscription** (`CODEX_AUTH_JSON`). The credential is forwarded into the
  sandbox verbatim — Codex talks to the ChatGPT backend directly with it, which the proxy does not
  cover. The run still starts; tracked in #585.
- **Codex or Cursor on their own API key** (`CODEX_API_KEY`/`OPENAI_API_KEY`, `CURSOR_API_KEY`). Such a
  run consumes no Anthropic-family credential, so the proxy's primary sidecar has nothing to hold and
  cannot start; exporting `CLAUDE_CODE_OAUTH_TOKEN` as well does not change that, because the run never
  uses it. The key is injected into the sandbox and the run starts.
- **Direct-mode-only providers** — Meridian ([MERIDIAN-provider.md](MERIDIAN-provider.md)) and repo
  custom providers (`.vanguard/app.json` `customProviders`). They point the Claude CLI at their own
  endpoint and authenticate on that host, exposing no upstream a sidecar could target, so their key
  is injected into the sandbox.

If the proxy's trusted sidecar itself fails to start — usually a missing or stale sandbox image, since
it runs inside `vanguard-sandbox:latest` like the egress enclave — the run fails fast rather than
silently falling back to direct mode or hanging. The run view shows: `Failed to start llm proxy
<id>: rebuild the sandbox image (docker/build.sh builds vanguard-sandbox:latest), or check
VANGUARD_SANDBOX_IMAGE if set.`

## Modes

- **Local mode** — no authentication, binds `127.0.0.1` by default. Intended for running on your own
  machine, reachable only from itself.
- **Container mode** — binds `0.0.0.0` because Docker port-mapping requires it. Reached under a
  hostname, set `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (every hostname the browser uses,
  including a non-default port).

Local mode has no authentication — on a VPS put it behind Tailscale or an authenticating reverse proxy,
never a published port.

### Allowed Hosts (DNS rebinding)

The hub checks the `Host` header of every request — before serving the SPA, which holds a live
token once opened — and answers `403` for anything it doesn't recognise, so a page on an attacker-controlled
domain cannot rebind that domain to the hub's address and drive it. Allowed by default, on any port:
`localhost`, and any **IP literal** (IPv4, or a bracketed IPv6 — `127.0.0.1`, `[::1]`, `0.0.0.0`, a LAN
address, a Tailscale address). DNS rebinding can only produce a *hostname*, never an IP literal, so
`--host 0.0.0.0` and the URL the CLI prints and opens work with no flag; the port isn't checked against
the socket the hub actually bound, so `docker run -p 8080:7777`, `ssh -L 8080:localhost:7777` and
`kubectl port-forward` work too — none of that changes the hostname a DNS-rebinding page could have
produced.

Any other hostname — a reverse proxy's public name, a container's service name — must be opted in
with `--allowed-host <host[:port]>` (repeatable) or `VANGUARD_HUB_ALLOWED_HOSTS` (comma-separated).
Each value is matched against the `Host` header exactly, case-insensitively, so include the port
whenever the browser's URL has a non-default one. It takes a bare `host[:port]`, with the port between
1 and 65535: a scheme, a path, a wildcard, an unbracketed IPv6 literal or a non-numeric/out-of-range
port is a startup error, not a silent 403. `--host <hostname>` (a non-loopback, non-IP-literal name) is
seeded into the allowlist automatically, on the bound port, so the URL the CLI prints and opens is
never refused.

A **Tailscale MagicDNS name** (`host.tailnet.ts.net`) is a hostname, not an IP literal, so it needs
`--allowed-host host.tailnet.ts.net` / `VANGUARD_HUB_ALLOWED_HOSTS=host.tailnet.ts.net` like any other
hostname. A bare **Tailscale IP** (`100.x.y.z`) is an IP literal and needs no flag.

> **Upgrading:** before this allowlist existed, any `Host` reached the hub. A deployment reached by
> hostname — a Tailscale MagicDNS name, a reverse proxy's public name, a container's service name —
> now needs `--allowed-host`/`VANGUARD_HUB_ALLOWED_HOSTS` added, or it 403s. One reached only by IP
> literal or `localhost` needs no change.

The same-origin check (`sameOriginOk` in `src/hub/server.ts`) compares the request's `Origin` header
against its own `Host` header, not scheme, so the hub works behind an HTTPS-terminating reverse proxy
when `--allowed-host <public-host[:port]>` permits the public Host and the proxy preserves that header (including any
non-default port). Only HTTP(S) origins are accepted; the browser's `https://` Origin matches
the public `Host` even though the proxy connects to the hub over HTTP.

## Wire format

The UI talks to the hub with `POST /rpc/<command>` (JSON body = the command's camelCase args, `{}` when
none) and listens on `GET /events` (SSE). A success answers `200 {"result": <value>}` (`null` for void
commands, `false` stays `false`); an error answers `400`/`404`/`500 {"error": {"message", "kind"}}` with
`kind` = `bad-request` or `internal`. `apps/desktop/src/transport.ts` unwraps `result` and rejects with
`error.message`, so both sides must keep this envelope.

**`src/hub-wire.ts` is the single source of truth for this envelope, the SSE frame shape, the hub
marker, the token's header name and the events-session path** — a zero-import module copied verbatim into
`apps/desktop/src/hub-wire.ts` by `pnpm gen:wire`
(drift caught by `src/wire.test.ts`). The server (`src/hub/server.ts`, `events.ts`, `static.ts`) and the
browser (`apps/desktop/src/transport.ts`) both call its `encodeResult`/`encodeError`/`decodeResponse`/
`encodeEvent`/`decodeEvent`/`HUB_MARKER`/`HUB_TOKEN_HEADER`/`HUB_EVENTS_SESSION_PATH` instead of
hand-rolling either side of the wire. A reconnecting
SSE client whose `Last-Event-ID` gap exceeds the replay ring gets a `stream-reset` frame instead of a
replay; `transport.ts` resyncs by re-running its snapshot fetches rather than trusting the stream alone.

## Env vars

| Variable | Default |
|---|---|
| `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `VANGUARD_HUB_PORT` | `7777` |
| `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `VANGUARD_HUB_CONFIG_DIR` | `$XDG_CONFIG_HOME/vanguard-hub` else `~/.config/vanguard-hub` |
| `VANGUARD_HUB_WATCH_POLL` | — |
| `VANGUARD_HUB_WATCH_INTERVAL_MS` | `2000` |
| `VANGUARD_HUB_BROWSE_ROOT` | `$HOME` |
| `VANGUARD_HUB_ALLOW_ADD` | — |
| `VANGUARD_HUB_ALLOWED_HOSTS` | — (comma-separated exact Host values, added to `localhost`/any IP literal on any port) |
| `VANGUARD_HUB_CLONE_HOSTS` | — (comma-separated hosts, added to `github.com`/`gitlab.com`) |
| `VANGUARD_CHAT_ALLOWED_ORIGINS` | — (comma-separated origins a project's `chatBaseUrl` may use; doc chat refuses any other origin than `https://api.anthropic.com`, since the inherited credential is sent there) |

## Add project: existing folder or clone a URL

The **Add project** dialog has two modes:

- **Existing folder** — browse (`browse_dirs`, confined to the browse root) to a directory that's
  already a git work tree and add it, exactly as before. `add_project` applies the same browse-root
  confinement, so a project outside the browse root cannot be added. To add one outside `$HOME`
  (the default root), start the hub with `VANGUARD_HUB_BROWSE_ROOT` set to a directory containing it.
- **Clone repository** — paste a repository URL, pick the parent folder with the same browser, and
  optionally override the folder name (default: the repo name from the URL). The hub clones it under
  the chosen parent and adds it, so a fresh install or a VPS hub with nothing to browse yet doesn't
  need a shell on the host first.

`clone_project { url, parentDir, name? } -> Project` (hub-only, `HUB_ONLY` in `src/wire.ts`) backs the
second mode:

- The URL must be `https://` or `ssh://`/`git@` to `github.com`, `gitlab.com`, or a host listed in
  `VANGUARD_HUB_CLONE_HOSTS` — no local paths, no `file://`.
- The target is resolved under the browse root, exactly like `browse_dirs`'s traversal guard (both
  sides realpath'd); a target outside the root, or an existing non-empty directory, is refused before
  anything is written.
- The clone runs via `gh repo clone` when the host is `github.com` and `gh` is authenticated (so
  private repos work with the host's own credentials), or plain `git clone` otherwise. Progress lines
  stream over the same SSE bus (`GET /events`) as a `vanguard:clone-progress` event (`{ line }`) so the
  dialog can show them live.
- On success it calls the same `add_project` path (allowlist + project store) and returns the new
  project's dashboard summary — the project appears without a page reload.
- On failure (bad URL, disallowed host, path outside the browse root, non-empty target, or `git`/`gh`
  itself failing) nothing is written and the error comes back as `bad-request` with git's message.

Gated exactly like `add_project`: loopback only, unless `VANGUARD_HUB_ALLOW_ADD=1` — a non-loopback
bind (server mode) must not let anyone clone onto the host.

## Coolify / Docker Compose

```yaml
services:
  vanguard-hub:
    build:
      context: .
      dockerfile: docker/hub.Dockerfile
    image: vanguard-hub:latest
    restart: unless-stopped
    mem_limit: 1024m
    ports:
      - "7777:7777"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock # sibling-sandbox execution; see risk note below
      - ./target-repo:/work/repo                  # the repo the hub serves + agent edits
      - vanguard-hub-config:/config                # VANGUARD_HUB_CONFIG_DIR
    environment:
      GH_TOKEN: ${GH_TOKEN}
      VANGUARD_MAX_SANDBOXES: "1"
      VANGUARD_HUB_ALLOWED_HOSTS: hub.example.com # every Host the browser uses; loopback only by default

volumes:
  vanguard-hub-config:
```

Mounting the Docker socket is equivalent to root on the host — a process with access to it can start a
privileged container and read or write anything the host can. Only do this when you trust everything
that runs in this container. If you only ever need read-only access to Docker endpoints, use
[`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) in front of the
socket instead of mounting it directly. The [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
is the usual reference for "don't mount the docker socket without justification."

## `gh` auth

The hub shells out to `gh` for the Remote screen (listing GitHub Actions runs) and CI-run import. It
needs a token with `actions:read` (fine-grained PAT) or classic `repo` scope. Run `gh auth login` or set
`GH_TOKEN`.

## CI run import

The reusable `implement.yml` and `revise.yml` workflows take an `upload-run-records` input (boolean,
off by default). When a caller passes `upload-run-records: true`, the job uploads `.vanguard/runs/` as
a `vanguard-runs` artifact kept for 14 days, with `**/*.bundle` excluded (git bundles are large and the
reader ignores them). The step runs under the same gate as `persist-metrics`: only once the run step
finished, pass or fail. This repo's own callers (`vanguard-implement.yml`, `vanguard-revise.yml`) opt
in; a client repo adds the input to its thin caller, see `docs/onboarding-another-repo.md` for the
input table and the "off by default, on purpose" notes.

What the artifact may contain, and what keeps it safe to publish: transcripts and `finalText` go
through `redactTokens`; a secret-blocked run, or a stage whose diff the secret scan flags, leaves no
`.diff`, `.bundle` or transcript (`diffOmitted` on the record says why); the scan exempts test paths,
so a credential added under `tests/` or `*.test.ts` is in the diff exactly as it would be in the PR.
Artifacts are downloadable by anyone with read access to the repository — on a public repo, any
signed-in GitHub user.

A `vanguard-runs` artifact is missing when the caller never opted in, when the run step did not reach
`success` or `failure` (blocked actor gate, failed build), or when the run wrote no record at all; the
empty-artifact case does not arise, because `if-no-files-found: ignore` skips the upload instead.

## Resource limits

Mirror `docker/compose.yaml`'s `mem_limit: 1024m` pattern. The hub runs agent sandboxes in the same
process as the HTTP server, so give the container the same RAM headroom, and keep
`VANGUARD_MAX_SANDBOXES=1` on a small host.

## CLI flags

```
vanguard hub [--repo <path>] [--host <addr>] [--port <n>] [--ui-dir <dir>] [--no-open] [--allowed-host <host[:port]>]
```

| Flag | Overrides | Default |
|---|---|---|
| `--repo <path>` | — | cwd; seeded into the project store on startup if it's a git work tree and not already present |
| `--allowed-host <host[:port]>` (repeatable) | `VANGUARD_HUB_ALLOWED_HOSTS` (comma-separated, additive) | `localhost` / any IP literal on any port |
| `--host <addr>` | `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `--port <n>` | `VANGUARD_HUB_PORT` | `7777` (1-65535; an invalid explicit `--port` is a startup error) |
| `--ui-dir <dir>` | `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `--no-open` | — | opens the printed launch URL (`/#token=…`) in a browser unless passed |

A missing or unbuilt `--ui-dir` fails at startup, naming `pnpm --dir apps/desktop build`
(run `pnpm build:ui`) rather than failing on the first request. Binding a non-loopback host
prints the no-auth warning above and disables `add_project`/`browse_dirs`/`clone_project` unless
`VANGUARD_HUB_ALLOW_ADD=1`. `SIGINT`/`SIGTERM` close the listener, every connected SSE client,
and the project file watchers.

Each launch mints a fresh token. RPC requests require `x-vanguard-hub-token` and a same-origin
`Origin` header (a request without one is rejected). The SSE stream never takes the token in its
URL: the UI first `POST`s `/events/session` with the header, and the hub answers with an HttpOnly,
`SameSite=Strict` cookie scoped to `/events` (an events-only secret, not the token) that the
`EventSource` sends on every connect and reconnect; a non-browser client can send the header on
`GET /events` instead. `/healthz` stays unauthenticated for container health checks and answers a
constant `{"ok":true}`. No route serves the token — not `index.html`, not `/healthz`. The CLI
prints and opens a launch URL carrying it in the fragment (`/#token=…`), which browsers never send to
the server; the UI moves it into `sessionStorage` and strips it from the address bar, so a reload
keeps working but a new tab on the bare URL needs the launch URL again. Behind a reverse proxy, append
the same `/#token=…` to the public URL. Reaching the port is therefore not enough to drive the hub,
but the token is a launch secret, not per-user authentication: it does not replace authentication at
the reverse proxy. It is regenerated on every hub launch, so an already-open page must be given the
new launch URL once the hub restarts.
