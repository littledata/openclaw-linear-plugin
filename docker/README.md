# Per-session container execution (opt-in)

`executionMode: "container"` runs each dispatch in its own Docker container that
**clones the repo fresh**, instead of a `git worktree` off a shared local clone.
This removes the shared `.git`/refs store, so concurrent dispatches on the same
repo no longer serialize or race — the fix for multi-user parallelism.

## Build the base image
```
docker build -f docker/worker.Dockerfile -t openclaw-linear-worker:latest .
```
Contains: Node 22, git, GitHub CLI (`gh`), ripgrep, Codex CLI. **No auth is baked
in** — it is mounted/passed read-only at run time.

## How it works
- `src/infra/container-runner.ts` builds the `docker run` invocation
  (`buildDockerRunArgs`) and the static in-container script (`WORKER_SCRIPT`).
- Dynamic values (remote URL, branch, prompt, model, effort) are passed as **env
  vars**, never interpolated into the shell script → injection-safe.
- Auth is mounted read-only: `~/.codex` (Codex ChatGPT OAuth), `~/.git-credentials`
  (git push), and `GH_TOKEN` for `gh pr create`.

## Remaining wiring (needs a live dispatch to validate)
1. Derive each repo's remote URL from the `repos[].github` config field
   (`owner/repo` + `hostname`) → `https://{hostname}/{github}.git`.
2. In `src/tools/codex-tool.ts`, when `pluginConfig.executionMode === "container"`,
   call the container runner instead of the local `codex exec`; stream its JSONL
   output through the existing `mapCodexEventToActivity` mapper.
3. Skip host worktree creation in `webhook.ts`/`pipeline.ts` for container mode.
4. Add resource limits (`--memory`, `--cpus`) and an egress policy as needed.

Default stays `worktree` so existing behavior is unchanged.
