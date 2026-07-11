# Base image for per-session Codex coding workers.
# Contains: Node 22, git, GitHub CLI (gh), ripgrep, and the Codex CLI.
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

WORKDIR /work
