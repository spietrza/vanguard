# The Vanguard HUB image. Serves the desktop Inspector UI (apps/desktop) over plain HTTP/SSE via
# `vanguard hub` (src/hub/*.ts, src/cli/hub.ts) for local/VPS use without Tauri. Runs agent sandboxes
# via the host docker socket (docker-out-of-docker), same as docker/runner.Dockerfile.
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
# Bump: `docker buildx imagetools inspect node:24-bookworm-slim` and copy the index Digest.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# docker CLI (sibling-sandbox execution), git, gh (Remote-run listing + CI artifact import), xz (linear-cli install).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg xz-utils docker.io \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.32.1

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
 && pnpm --dir apps/desktop install --frozen-lockfile && pnpm --dir apps/desktop build

ENV VANGUARD_HUB_HOST=0.0.0.0 \
    VANGUARD_HUB_PORT=7777 \
    VANGUARD_HUB_UI_DIR=/app/apps/desktop/dist \
    VANGUARD_HUB_CONFIG_DIR=/config

EXPOSE 7777

HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:7777/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js", "hub", "--no-open"]
