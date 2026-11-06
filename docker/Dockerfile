# Vanguard sandbox image: node + git + the claude and linear CLIs, non-root user.
# Single stage so the global npm bins and their node_modules stay consistent (the linear-cli
# launcher resolves a sibling binary, which breaks when bins are copied across build stages).
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf
# Exact CLI versions, never `latest`, so a rebuild cannot silently pull a new (or hijacked) release.
# Bump: `npm view <pkg> version`, update the default here (or pass --build-arg), rebuild, run build.sh.
ARG CLAUDE_CLI_VERSION=2.1.260
ARG LINEAR_CLI_VERSION=3.1.0
ARG CODEX_CLI_VERSION=0.167.0

# xz-utils + ca-certificates: the linear-cli npm package downloads and untars an .xz release binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client xz-utils \
 && rm -rf /var/lib/apt/lists/*

# claude/codex run the agent (selectable via --provider/--review-provider); linear lets the agent use
# the linear-cli skill; pnpm and bun let it install deps and run the project's typecheck/tests from
# inside the sandbox before finishing. bun is required for bun-workspace monorepos (e.g. ModelBox),
# whose `bun install` / `bun run *` scripts pnpm cannot drive — without it the agent cannot build or
# verify and ends up confabulating completion. Codex authenticates with CODEX_API_KEY: in direct mode
# it is forwarded into the sandbox when codex is selected; under --llm-proxy the key is held by a
# trusted sidecar and the sandbox receives only a per-run nonce.
RUN npm install -g \
    @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    @schpet/linear-cli@${LINEAR_CLI_VERSION} \
    @openai/codex@${CODEX_CLI_VERSION} \
    pnpm \
    bun

# Cursor CLI (`agent`, --provider cursor) is opt-in: ~550 MB unpacked, so it is installed only when a
# version is given, e.g. CURSOR_CLI_VERSION=2026.10.16-e3cb207 (the id cursor.com/install pins).
# Declared here, not at the top, so setting it leaves the layers above cached.
# Cursor publishes no checksums, so the tarball is verified against a per-arch sha256 pinned here. The
# defaults are for 2026.10.16-e3cb207; another version must pass its own CURSOR_CLI_SHA256_X64/_ARM64.
# Bump: download linux/{x64,arm64}/agent-cli-package.tar.gz for the new id once, `sha256sum` each.
ARG CURSOR_CLI_VERSION=
ARG CURSOR_CLI_SHA256_X64=3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552
ARG CURSOR_CLI_SHA256_ARM64=4cf077f150eb8d1e270bf1dea69700184c39a4847fe192d523f5bb34d4b62597
# Root-owned under /opt with the bin on /usr/local/bin: `sh -lc` resets PATH from /etc/profile, so the
# installer's ~/.local/bin would not be found. curl is pulled in only for this download.
RUN if [ -n "${CURSOR_CLI_VERSION}" ]; then \
      case "$(uname -m)" in \
        x86_64) arch=x64; sha="${CURSOR_CLI_SHA256_X64}" ;; \
        aarch64|arm64) arch=arm64; sha="${CURSOR_CLI_SHA256_ARM64}" ;; \
        *) echo "cursor: unsupported arch $(uname -m)" >&2; exit 1 ;; \
      esac \
      && apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL -o /tmp/cursor-agent.tar.gz \
         "https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/linux/${arch}/agent-cli-package.tar.gz" \
      && echo "${sha}  /tmp/cursor-agent.tar.gz" | sha256sum -c - \
      && mkdir -p /opt/cursor-agent \
      && tar --strip-components=1 -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
      && rm /tmp/cursor-agent.tar.gz \
      && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
      && agent --version; \
    fi

RUN groupadd -g 10001 agent \
 && useradd -m -u 10001 -g agent -s /bin/bash agent \
 && mkdir -p /workspace /home/agent/.claude \
 && chown -R agent:agent /workspace /home/agent

USER agent
WORKDIR /workspace
ENV HOME=/home/agent
CMD ["sleep", "infinity"]
