# Vanguard Hub

`vanguard hub` serves the same Inspector UI the Tauri desktop app ships (`apps/desktop`) over plain
HTTP/SSE, backed by a real `.vanguard/` directory. Useful when you want the cockpit without installing
a native app, or running it on a server. See `src/hub/*.ts` and `src/cli/hub.ts` for the implementation.

## Quick start

```bash
pnpm build:ui && pnpm hub --repo /path/to/your/repo
```

This opens a browser at the printed URL.

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
   Reaching it under a hostname other than loopback needs that hostname allowed:
   `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (or `--allowed-host hub.example.com`).

## Modes

- **Local mode** — no authentication, binds `127.0.0.1` by default. Intended for running on your own
  machine, reachable only from itself.
- **Container mode** — binds `0.0.0.0` because Docker port-mapping requires it. Set
  `VANGUARD_HUB_ALLOWED_HOSTS=hub.example.com` (every hostname the browser uses, including a
  non-default port) — only loopback Hosts are allowed by default, so any other `Host` gets a 403.

Local mode has no authentication — on a VPS put it behind Tailscale or an authenticating reverse proxy,
never a published port.

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
marker, and the token's header/query-parameter names** — a zero-import module copied verbatim into
`apps/desktop/src/hub-wire.ts` by `pnpm gen:wire`
(drift caught by `src/wire.test.ts`). The server (`src/hub/server.ts`, `events.ts`, `static.ts`) and the
browser (`apps/desktop/src/transport.ts`) both call its `encodeResult`/`encodeError`/`decodeResponse`/
`encodeEvent`/`decodeEvent`/`HUB_MARKER`/`HUB_TOKEN_HEADER`/`HUB_TOKEN_QUERY_PARAM` instead of
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
| `VANGUARD_HUB_ALLOWED_HOSTS` | — (comma-separated exact Host values, added to loopback Hosts on the bound port) |
| `VANGUARD_HUB_CLONE_HOSTS` | — (comma-separated hosts, added to `github.com`/`gitlab.com`) |

## Add project: existing folder or clone a URL

The **Add project** dialog has two modes:

- **Existing folder** — browse (`browse_dirs`, confined to the browse root) to a directory that's
  already a git work tree and add it, exactly as before.
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
| `--allowed-host <host[:port]>` (repeatable) | `VANGUARD_HUB_ALLOWED_HOSTS` (comma-separated, additive) | loopback Hosts on the bound port |
| `--host <addr>` | `VANGUARD_HUB_HOST` | `127.0.0.1` |
| `--port <n>` | `VANGUARD_HUB_PORT` | `7777` (1-65535; an invalid explicit `--port` is a startup error) |
| `--ui-dir <dir>` | `VANGUARD_HUB_UI_DIR` | `<pkg>/apps/desktop/dist` |
| `--no-open` | — | opens the printed URL in a browser unless passed |

A missing or unbuilt `--ui-dir` fails at startup, naming `pnpm --dir apps/desktop build`
(run `pnpm build:ui`) rather than failing on the first request. Binding a non-loopback host
prints the no-auth warning above and disables `add_project`/`browse_dirs`/`clone_project` unless
`VANGUARD_HUB_ALLOW_ADD=1`. `SIGINT`/`SIGTERM` close the listener, every connected SSE client,
and the project file watchers.

The SPA receives a fresh per-launch token. RPC requests require `x-vanguard-hub-token`; SSE requests
require the `token` query parameter. Host checks also protect the SPA response against DNS rebinding.
The token stops a page on another origin from driving the hub; it is not authentication — anyone who
can fetch `GET /` (any local process, anyone the proxy lets through) reads it out of the HTML, so it
does not replace authentication at the reverse proxy. Because `/events` carries it as a query
parameter, it lands in reverse-proxy access logs; it is regenerated on every hub launch, so a logged
value stops working once the hub restarts (and an already-open page must be reloaded to pick up the
new one).
