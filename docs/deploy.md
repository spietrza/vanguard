# Deploying the Vanguard watch loop

Run `vanguard watch` always-on so the factory pulls ready Linear or GitHub issues by itself, runs them, and opens PRs. Optionally run `vanguard watch-prs` as a second loop so Vanguard reviews external PRs by label. This guide gives three concrete recipes: Synology (step by step, the one that was actually deployed), Hetzner native Docker, and Hetzner with Coolify. All three are the same idea: Docker on Linux, one controller container that starts sibling sandboxes.

## Architecture (docker-out-of-docker)

Vanguard runs as one long-lived **controller** container. It talks to the host Docker daemon through the mounted socket and starts a **sibling** sandbox container (plus optional egress and llm-proxy sidecars) for each run.

```
host docker daemon
 ├─ vanguard-watch        controller: node + docker CLI + git + gh + linear, runs `vanguard watch`
 ├─ vanguard-watch-prs    optional controller profile, runs `vanguard watch-prs`
 ├─ vanguard-gc           controller image again, loops: refresh target-repo + gc every 4h
 ├─ vg-<uuid>             per-run sandbox (the agent), started as a sibling
 ├─ vg-llm-<id>           per-run llm-proxy sidecar (holds the Anthropic — or, for Codex, the OpenAI — token; sandbox gets a nonce)
 └─ vg-egr-<id>           per-run egress proxy sidecar (CONNECT allowlist)
```

This works without path tricks because the controller copies the worktree into each sandbox with `docker cp` (it reads the source from its own filesystem) and injects secrets over tmpfs. It never bind-mounts the worktree, so there is no "host path must match" problem. One requirement stands: the **sandbox image must exist on the host daemon** that the controller drives.

> **Warning: the Docker socket is host root.** The controller (`vanguard-watch`, `vanguard-watch-prs`, `vanguard-gc`) and the hub (`docker/hub.Dockerfile`) mount `/var/run/docker.sock` by design, because that is how they start sibling sandboxes. Anything that can talk to that socket can start a privileged container with the host filesystem mounted, so a compromised controller or hub process is equivalent to root on the host. The sandboxes themselves never get the socket. Treat these containers as host-privileged: run them on a box dedicated to Vanguard, keep the hub off the public internet, and keep their images pinned. To narrow the blast radius, run the daemon in [rootless mode](https://docs.docker.com/engine/security/rootless/) (a socket compromise is then bounded by an unprivileged user), or put a socket proxy such as [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) in front of the daemon and point `DOCKER_HOST` at it with only the API sections the controller uses (containers, images, networks, exec, POST) enabled. A proxy limits which endpoints are reachable, not what a created container may mount, so it reduces exposure rather than removing it; rootless mode is the stronger option.

## What you need on the host

1. Docker. Synology: Container Manager. Hetzner: `apt install docker.io` or Docker CE.
2. Two images on the host daemon, matching the host CPU architecture: `vanguard-sandbox:latest` and `vanguard-runner:latest`. Build them on the host, or build elsewhere and transfer (see Synology below). Synology and most Hetzner cloud boxes are `x86_64`/`amd64`. An Apple Silicon Mac builds `arm64` by default, which will not run on an amd64 host, so build with `--platform linux/amd64`.
3. A git clone of the target repo the agent edits, mounted into the controller at `/work/repo`.
4. Secrets in the environment: `CLAUDE_CODE_OAUTH_TOKEN` (subscription, the default here), `GH_TOKEN` for git push, PRs, labels, and PR reviews, and `LINEAR_API_KEY` only when running the Linear source.

## Auth: subscription, not API credit

Vanguard reads auth from the environment. `authFromEnv()` prefers `CLAUDE_CODE_OAUTH_TOKEN` (subscription) over `ANTHROPIC_API_KEY` (pay per use). Run on the subscription token: set `CLAUDE_CODE_OAUTH_TOKEN` and leave `ANTHROPIC_API_KEY` unset. With `--llm-proxy` the real token never enters the sandbox at all: a trusted sidecar holds it (and the Codex/OpenAI key too when Codex is used) and the sandbox sees only a per-run nonce.

1Password is a local-dev convenience and is not part of Vanguard. On a server you populate the env some other way. The simplest is a root-only `.env` (chmod 600) next to the compose file.

Secrets are passed at **runtime only**: compose reads that `.env` to fill the `${VAR}` references in `environment:` (or use `env_file:`), and plain `docker run` takes `-e VAR` / `--env-file`. Never put them in a Dockerfile `ARG`/`ENV` or in an image layer. The runner and hub images are built with `COPY . .`, so the repo-root `.dockerignore` keeps `.env*`, `.git`, `.vanguard`, `node_modules`, local tool state, build output and `docker/target-repo` out of the image; the sandbox build context (`docker/`) sends nothing. Keep the `.env` and the target-repo clone in those excluded places, or outside the checkout entirely.

---

## Recipe A: Synology (step by step)

Validated on DSM 7.3.2, x86_64, 5.6 GB RAM, Container Manager (Docker 24 + compose v2).

### 1. SSH access

Synology allows SSH only for users in the **administrators** group, and key auth needs a home directory.

1. Control Panel, Terminal & SNMP, enable SSH (note the port, e.g. 50022).
2. Control Panel, User & Group: the SSH user must be in **administrators**.
3. Control Panel, User & Group, Advanced, User Home: enable the user home service so `/var/services/homes/<user>` exists.
4. Install your public key and fix permissions (Synology rejects keys when the home or `.ssh` is group-writable):

```bash
cat ~/.ssh/id_ed25519.pub | ssh -p 50022 <user>@<nas-ip> \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~ ~/.ssh && chmod 600 ~/.ssh/authorized_keys'
```

The Docker socket is root-owned, so docker commands need `sudo`. The docker binary is at `/usr/local/bin/docker`.

### 2. Build the images for amd64 and transfer them

Synology cannot build these comfortably, and an Apple Silicon Mac builds the wrong arch. Build amd64 on your dev machine, then stream them over:

```bash
docker buildx build --platform linux/amd64 -t vanguard-sandbox:latest -f docker/Dockerfile --load docker/
docker buildx build --platform linux/amd64 -t vanguard-runner:latest  -f docker/runner.Dockerfile --load .

docker save vanguard-sandbox:latest vanguard-runner:latest | gzip -1 \
  | ssh -p 50022 <user>@<nas-ip> 'cat > /tmp/vg-images.tgz'
ssh -p 50022 <user>@<nas-ip> 'sudo /usr/local/bin/docker load -i /tmp/vg-images.tgz && rm /tmp/vg-images.tgz'
```

### 3. Deploy directory and secrets

```bash
ssh -p 50022 <user>@<nas-ip> 'sudo mkdir -p /volume1/docker/vanguard/target-repo'
```

Write `/volume1/docker/vanguard/.env` (root, chmod 600). Use the subscription token and disable `--cpus` (the Synology kernel has no CPU CFS scheduler, so `docker run --cpus` is fatal). `LINEAR_API_KEY` is needed for the default Linear compose mode; GitHub-only mode can omit it.

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
LINEAR_API_KEY=lin_api_...
GH_TOKEN=ghp_...
# Optional for GitHub Actions revise flow: fine-grained, repo-scoped PAT with Contents: Read and write.
# Expose this as VANGUARD_PUSH_TOKEN in vanguard-revise.yml so revision pushes use a PAT and trigger CI.
VANGUARD_PUSH_TOKEN=<your-fine-grained-pat>
VANGUARD_SANDBOX_CPUS=0        # required: kernel without CFS scheduler
VANGUARD_SANDBOX_PIDS=0        # silences a harmless pids-limit warning
VANGUARD_SANDBOX_MEMORY_MB=1536
# VANGUARD_VERIFY_CMD=pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
# VANGUARD_VISUAL_PROOF_CMD=pnpm exec playwright test --project=chromium
```

### 4. Clone the target repo (the NAS has no git, so use the runner image)

```bash
ssh -p 50022 <user>@<nas-ip> "sudo /usr/local/bin/docker run --rm --entrypoint sh \
  -v /volume1/docker/vanguard/target-repo:/repo vanguard-runner:latest -c \
  'git clone https://github.com/OWNER/REPO.git /repo && \
   git -C /repo config credential.\"https://github.com\".helper \"!gh auth git-credential\"'"
```

The credential helper lets `git push` authenticate with `GH_TOKEN` non-interactively at PR time.

### 5. compose.yaml

Copy `docker/compose.yaml` from this repo to `/volume1/docker/vanguard/compose.yaml`. It defines two services: `vanguard-watch` (the loop) and `vanguard-gc` (self-maintenance). The shipped command runs **Linear Loop v1.1** by default:

```yaml
command:
  - watch
  - --loop-v1
  - --source=linear
  - --label=vanguard
```

This expects a Linear `vanguard` label, a spec state with type `triage` and display name `Spec`, a `Needs Info` state, and a Todo/unstarted agent state. If your workspace uses different state names, uncomment and edit the `--spec-state`, `--spec-state-name`, `--needs-info-state`, and `--agent-state` lines in the compose file. Set `--team` if the Linear token can see multiple teams.

For **GitHub Loop v1.1**, switch the command to repo-scoped routing:

```yaml
command:
  - watch
  - --loop-v1
  - --source=github
  - --github-repo=OWNER/REPO
```

GitHub mode watches the `ready for spec`, `ready for agent`, and `needs info` labels in that repo. It does **not** need `--label=vanguard` by default; add `--label=vanguard` only if you want an extra ownership filter on top of the routing labels.

Set the `gc --remote OWNER/REPO` slug to match your repo. Keep `VANGUARD_MAX_SANDBOXES: "1"` on a small NAS.

The same compose file also ships an optional **external PR review loop** under the `pr-review` profile. It watches PRs carrying the trigger label, posts a non-blocking Vanguard review, and marks the PR with `vanguard:reviewed`. Run its preflight first:

```bash
ssh -p 50022 <user>@<nas-ip> 'cd /volume1/docker/vanguard && sudo /usr/local/bin/docker compose --profile pr-review run --rm vanguard-watch-prs doctor-prs --github-repo=OWNER/REPO --label "ready for vanguard review" --repo=/work/repo'
```

Then start only the PR-review controller:

```bash
ssh -p 50022 <user>@<nas-ip> 'cd /volume1/docker/vanguard && sudo /usr/local/bin/docker compose --profile pr-review up -d vanguard-watch-prs'
ssh -p 50022 <user>@<nas-ip> 'sudo /usr/local/bin/docker logs -f vanguard-vanguard-watch-prs-1'
```

This service is separate from `vanguard-watch`; keep it disabled if you only want Vanguard to implement tickets. Before enabling it, create the labels from `docker/compose.yaml` in the target repo: `ready for vanguard review`, `vanguard:reviewing`, and `vanguard:reviewed`.

### 6. Start and verify

```bash
ssh -p 50022 <user>@<nas-ip> 'cd /volume1/docker/vanguard && sudo /usr/local/bin/docker compose up -d'
ssh -p 50022 <user>@<nas-ip> 'sudo /usr/local/bin/docker logs -f vanguard-vanguard-watch-1'
```

You should see `watch[linear]: polling every 120s`, followed by terse operator lines such as `spec: poll -> 1 ready` and `spec TES-123: claim -> triage`. For the PR review loop, you should see `watch-prs[github]: polling every 120s`. To prove the full Loop v1.1 chain in Linear, create a Linear issue in your team, add the `vanguard` label, and move it to the **Spec** state. The spec pass posts a `<tech_spec>` comment and advances the issue to Todo; the next poll runs the agent pass and opens a draft PR. To skip the spec pass for a fully-scoped ticket, put the issue directly in Todo with acceptance criteria or an existing Vanguard spec comment.

For GitHub smoke tests, create an issue in `OWNER/REPO` with `ready for spec`. The watcher should post a `<tech_spec>` comment and relabel to `ready for agent`; the next poll should open a draft PR. A fully-scoped issue can start directly with `ready for agent`. `needs info` means the issue is parked until a human adds detail and moves it back. See the [GitHub Loop v1.1 smoke test](smoke-tests/github-loop-v1-1.md) for the controlled two-pass `--once` runbook.

Stop with `sudo /usr/local/bin/docker compose down`.

---

## Recipe B: Hetzner native Docker

A Hetzner CX/CPX/CCX box is simpler than Synology: it is amd64, has git, and its kernel has the CFS scheduler, so no `VANGUARD_SANDBOX_CPUS` override is needed.

```bash
apt update && apt install -y docker.io docker-compose-plugin git
git clone https://github.com/OWNER/REPO.git /opt/vanguard && cd /opt/vanguard
git clone https://github.com/OWNER/REPO.git docker/target-repo   # the repo the agent edits (mounted, never baked)
# secrets next to docker/compose.yaml, read by compose at runtime; .dockerignore keeps them out of the image
printf 'CLAUDE_CODE_OAUTH_TOKEN=...\nLINEAR_API_KEY=...\nGH_TOKEN=...\n# VANGUARD_VERIFY_CMD=pnpm install --frozen-lockfile && pnpm typecheck && pnpm test\n' > docker/.env && chmod 600 docker/.env
docker compose -f docker/compose.yaml up -d --build         # builds runner; build the sandbox too
docker build -t vanguard-sandbox:latest docker/             # sandbox image on the same daemon
docker compose -f docker/compose.yaml logs -f vanguard-watch
```

Put the box behind a firewall. With `--llm-proxy` and `--egress` the sandboxes already reach only the allowlist and never hold the LLM token. Firecracker microVM isolation (a later option) needs a Dedicated/AX bare-metal box with `/dev/kvm`; Docker is fine on shared cloud.

---

## Recipe C: Hetzner with Coolify

Coolify deploys a Docker Compose resource straight from a Git repo, which fits Vanguard well. This recipe is the shape to follow; verify it against your Coolify version, because the docker-out-of-docker socket mount is the part Coolify is strict about.

1. In Coolify, add a new resource of type **Docker Compose**, pointed at this repo, with the compose path `docker/compose.yaml`.
2. Set the secrets as **environment variables** in the Coolify UI: `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GH_TOKEN`. Coolify injects them into the compose `${VAR}` references.
3. The controller needs the host Docker socket. Confirm Coolify allows the `/var/run/docker.sock` bind mount in the compose (some hardened setups block host mounts; you may need to allow it for this resource). Without the socket the controller cannot start sandboxes.
4. The **sandbox image must be present on the same Docker host** Coolify uses. Coolify builds `vanguard-runner` from the Dockerfile, but not the sandbox. Build or load `vanguard-sandbox:latest` on that host once (SSH in and `docker build -t vanguard-sandbox:latest docker/`, or `docker load`).
5. Make `docker/target-repo` and `.vanguard/runs` **persistent volumes** in Coolify so the clone and the run records survive redeploys. Seed `docker/target-repo` with a clone the first time (a one-off `docker run` like the Synology step, or an init command).
6. Deploy. Watch the logs in Coolify for the `watch[...]: polling` line. To run the optional PR-review loop, enable the compose profile `pr-review` or create a second compose resource for `vanguard-watch-prs`, then preflight it with `doctor-prs`.

Caveats: Coolify redeploys may recreate the controller, which is fine (the watch loop is stateless beyond the mounted volumes). The `vanguard-gc` service runs the same as anywhere. If Coolify refuses the socket mount, fall back to Recipe B (plain compose over SSH) on the same Hetzner box; Coolify can still manage other apps alongside it.

---

## Garbage collection and self-maintenance

The `vanguard-gc` service in `docker/compose.yaml` loops every 4 hours: `git -C /work/repo pull --ff-only` (so PRs branch off the latest main instead of a staling clone) and `vanguard gc` (reap stale sandbox containers, prune worktree admin entries, delete merged remote `vanguard/*` branches). Running it in-stack means no DSM Task Scheduler, cron, or systemd timer is needed, and it survives reboots via the restart policy.

If you prefer an external scheduler instead of the in-stack service, `vanguard gc` flags:

| Flag | Default | Description |
|---|---|---|
| `--repo <path>` | cwd | Git repo to prune worktrees and reap branches in |
| `--max-age-hours <n>` | 6 | Only reap resources older than n hours |
| `--remote <owner/repo>` | none | Also delete merged remote `vanguard/*` branches (needs `gh`) |
| `--abandoned` | off | Also delete branches whose PR is closed unmerged |
| `--dry-run` | off | Report what would be reaped without removing anything |

A cron line, for reference: `0 */4 * * * vanguard gc --remote owner/repo --repo /work/repo`. On Synology you would put this in Control Panel, Task Scheduler instead; the in-stack `vanguard-gc` service is simpler and is what this repo ships.

## Operational notes

- Run records and metrics land in `<repo>/.vanguard/runs/` (a mounted volume): per-stage transcript, a git bundle of the changes, the diff, and a `run_complete` metric line. `vanguard stats --repo /work/repo` rolls them up across the fleet.
- RAM is the real cap. Each sandbox is roughly 1.5 to 2 GB plus small sidecars. Keep `VANGUARD_MAX_SANDBOXES` at 1 on a 5 to 6 GB host.
- Updating the deployed code: rebuild `vanguard-runner` for amd64, transfer and load it (Synology) or rebuild on the box (Hetzner), then `docker compose up -d --force-recreate`. The `vanguard-gc` pull keeps the edited repo current on its own.
