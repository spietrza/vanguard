# Template: the Vanguard CONTROLLER image. It runs `vanguard watch` and starts sibling sandbox
# containers via the host docker socket (docker-out-of-docker). This is NOT the sandbox image
# (that is docker/Dockerfile -> vanguard-sandbox). Validate on your host/arch before relying on it.
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
# Bump: `docker buildx imagetools inspect node:24-bookworm-slim` and copy the index Digest.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# docker CLI (control sibling sandboxes), git, gh (GitHub source + PRs), xz (linear-cli install).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg xz-utils docker.io \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Exact versions (bump: `npm view <pkg> version`). linear-cli stays on 2.x: src/tasks/linear-cli.ts is
# verified against the 2.0 command surface.
RUN npm install -g pnpm@10.32.1 @schpet/linear-cli@2.0.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Assemble the skills the factory injects into every sandbox: linear-cli (read Linear) + this repo's
# code-review and simplify skills (so the review/simplify stages are skill-driven out of the box).
# The skill is pinned to a commit (tag v3.1.0, matching the sandbox's LINEAR_CLI_VERSION), not HEAD.
# Bump: `git ls-remote https://github.com/schpet/linear-cli refs/tags/vX.Y.Z` and copy the sha.
ARG LINEAR_CLI_SKILL_SHA=02571d34be662e5487204841fb80bf23ed79b4f0
RUN git init -q /opt/linear-cli \
 && git -C /opt/linear-cli fetch -q --depth 1 https://github.com/schpet/linear-cli "${LINEAR_CLI_SKILL_SHA}" \
 && git -C /opt/linear-cli checkout -q FETCH_HEAD \
 && mkdir -p /opt/skills \
 && cp -r /opt/linear-cli/skills/. /opt/skills/ \
 && cp -r /app/skills/. /opt/skills/
ENV SKILLS_DIR=/opt/skills

ENTRYPOINT ["node", "dist/cli/index.js"]
