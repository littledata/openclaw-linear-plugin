# Base image for per-ticket coding worker containers.
# Contains: Node 22, git, GitHub CLI (gh), ripgrep, the Codex CLI, and the
# CocoIndex code-search CLI (`ccc`) for AST-aware semantic code search.
# Auth (ChatGPT OAuth ~/.codex, git credentials, gh token) is mounted/passed at
# `docker run` time by the plugin — never baked into the image.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.144.1 \
 && npm cache clean --force

# CocoIndex code search (`ccc`): local (no-API-key) AST semantic search over the
# cloned repos. Heavy deps (torch/transformers) live here so runtime is fast;
# the embedding model downloads lazily on first `ccc index`. Installed to
# /usr/local/bin so `ccc` is on PATH for any user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip pipx \
 && rm -rf /var/lib/apt/lists/* \
 && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install 'cocoindex-code[full]' \
 && rm -rf /root/.cache/pip

WORKDIR /work
