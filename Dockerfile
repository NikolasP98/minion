FROM node:22-bookworm@sha256:ecabd1cb6956d7acfffe8af6bbfbe2df42362269fd28c227f36367213d0bb777

ENV PATH="/usr/local/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Install runtime packages and clean up in single layer
# - sqlite3: for cookie/session database queries
# - jq: for JSON processing in scripts
# - ffmpeg: for video-frames skill (optional but commonly used)
# - gosu: for privilege dropping in entrypoint
# - unzip: required for Bun installation
ARG MINION_DOCKER_APT_PACKAGES=""
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    sqlite3 \
    jq \
    ffmpeg \
    gosu \
    poppler-utils \
    unzip \
    $MINION_DOCKER_APT_PACKAGES && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install Bun globally - pinned version with SHA256 checksum verification
ARG BUN_VERSION=1.3.12
ARG BUN_X64_SHA256=11dc3ee11bc1695e149737c6ca3d5619302cf4346e6b8a6ec7988967ef01ddc5
ARG BUN_AARCH64_SHA256=c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b
ENV BUN_INSTALL=/usr/local
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) bun_arch="linux-x64";     bun_sha256="${BUN_X64_SHA256}" ;; \
        arm64) bun_arch="linux-aarch64"; bun_sha256="${BUN_AARCH64_SHA256}" ;; \
        *) echo "Unsupported arch: $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${bun_arch}.zip" -o /tmp/bun.zip; \
    echo "${bun_sha256}  /tmp/bun.zip" | sha256sum -c; \
    unzip /tmp/bun.zip -d /tmp/bun-extract; \
    mv "/tmp/bun-extract/bun-${bun_arch}/bun" /usr/local/bin/bun; \
    chmod +x /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-extract

# Install CLI tools from GitHub releases (consolidated into single layer)
# - gh: GitHub CLI
# - obsidian-cli: Obsidian vault management
# - gogcli: Google services CLI (Gmail/GCal/GDrive)
ARG GH_CLI_VERSION=2.64.0
ARG OBSIDIAN_CLI_VERSION=0.2.3
ARG GOGCLI_VERSION=0.9.0
ARG TARGETARCH
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" | \
    tar -xzf - --strip-components=2 -C /usr/local/bin "gh_${GH_CLI_VERSION}_linux_${TARGETARCH}/bin/gh" && \
    curl -fsSL "https://github.com/yakitrak/obsidian-cli/releases/download/v${OBSIDIAN_CLI_VERSION}/obsidian-cli_${OBSIDIAN_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" | \
    tar -xzf - -C /usr/local/bin obsidian-cli && \
    curl -fsSL "https://github.com/steipete/gogcli/releases/download/v${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION}_linux_${TARGETARCH}.tar.gz" | \
    tar -xzf - -C /usr/local/bin gog && \
    chmod +x /usr/local/bin/gh /usr/local/bin/obsidian-cli /usr/local/bin/gog

# Install uv (Python package manager) and nano-pdf
ENV UV_INSTALL_DIR="/usr/local/bin"
ENV UV_TOOL_DIR="/usr/local/share/uv-tools"
ENV UV_TOOL_BIN_DIR="/usr/local/bin"
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    /usr/local/bin/uv tool install nano-pdf

# Install bun global packages
# - mcporter: Model Context Protocol tools
# - qmd: Optional memory search backend (users opt-in via config: memory.backend = "qmd")
RUN bun install -g mcporter && \
    bun install -g github:tobi/qmd

# Copy dependency manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV MINION_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Copy entrypoint and default config, set permissions (before switching to non-root)
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/default-config.json /app/docker/default-config.json
RUN chmod +x /app/docker/entrypoint.sh && \
    chown -R node:node /app

# Note: Container starts as root to allow entrypoint to fix mounted directory permissions
# The entrypoint script will drop privileges to 'node' user (uid 1000) before running the app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:18789/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

# Start gateway server with pre-baked config.
# Binds to LAN (0.0.0.0) - auth is enforced via MINION_GATEWAY_TOKEN env var.
CMD ["node", "minion.mjs", "gateway", "--bind", "lan", "--port", "18789"]
