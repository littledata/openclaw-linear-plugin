/**
 * container-runner.ts — per-session Docker isolation for Codex workers.
 *
 * Instead of a `git worktree` off a shared local base clone (which serializes
 * concurrent dispatches on the same repo through one .git/refs store), each
 * dispatch runs in its own container that clones the repo fresh. This removes
 * all shared git state, so N users can work the same repo in parallel.
 *
 * This module builds the (pure, unit-tested) `docker run` invocation. All
 * dynamic values are passed as ENV VARS — never interpolated into the shell
 * script — so a hostile issue title/prompt cannot inject shell commands.
 *
 * Auth is mounted read-only at run time, never baked into the image:
 *   - ~/.codex        → Codex ChatGPT OAuth
 *   - ~/.git-credentials → git push credentials (store helper)
 *   - gh via GH_TOKEN env for `gh pr create`
 */

/** Static in-container script. Reads REMOTE_URL/BRANCH/MODEL/EFFORT/PROMPT from env. */
export const WORKER_SCRIPT = [
  "set -euo pipefail",
  'git config --global credential.helper store',
  'git clone --depth 50 "$REMOTE_URL" /work/repo',
  "cd /work/repo",
  'git checkout -B "$BRANCH"',
  // MODEL/EFFORT are optional; only add the flags when the env var is non-empty.
  'codex exec --full-auto --json --ephemeral' +
    ' ${MODEL:+--model "$MODEL"}' +
    ' ${EFFORT:+-c model_reasoning_effort="$EFFORT"}' +
    ' -C /work/repo "$PROMPT"',
].join("\n");

export interface ContainerRunSpec {
  /** Docker image tag (e.g. openclaw-linear-worker:latest). */
  image: string;
  /** Git remote URL to clone (https, with creds supplied via mounts/env). */
  remoteUrl: string;
  /** Branch to create/checkout inside the clone. */
  branch: string;
  /** The Codex prompt (passed via env, never interpolated into the script). */
  prompt: string;
  /** Optional model override for `codex exec --model`. */
  model?: string;
  /** Optional `-c model_reasoning_effort` value. */
  reasoningEffort?: string;
  /** Host path to the Codex auth dir mounted read-only at /root/.codex. */
  codexAuthDir?: string;
  /** Host path to a git-credentials file mounted read-only. */
  gitCredentialsFile?: string;
  /** GitHub token exposed as GH_TOKEN for `gh` inside the container. */
  ghToken?: string;
  /** Extra `docker run` flags (e.g. resource limits). */
  extraDockerArgs?: string[];
  /** Container name (for later exec/kill/cleanup). */
  name?: string;
}

/**
 * Build the full `docker run` argv for a one-shot worker container.
 * Pure + deterministic → unit-testable without invoking Docker.
 * @param spec - the container run specification
 * @returns argv array to pass to spawn("docker", argv)
 */
export function buildDockerRunArgs(spec: ContainerRunSpec): string[] {
  const args: string[] = ["run", "--rm", "-i"];
  if (spec.name) args.push("--name", spec.name);

  // Dynamic values as env (injection-safe).
  args.push("-e", `REMOTE_URL=${spec.remoteUrl}`);
  args.push("-e", `BRANCH=${spec.branch}`);
  args.push("-e", `PROMPT=${spec.prompt}`);
  if (spec.model) args.push("-e", `MODEL=${spec.model}`);
  if (spec.reasoningEffort) args.push("-e", `EFFORT=${spec.reasoningEffort}`);
  if (spec.ghToken) args.push("-e", `GH_TOKEN=${spec.ghToken}`);

  // Read-only auth mounts.
  if (spec.codexAuthDir) args.push("-v", `${spec.codexAuthDir}:/root/.codex:ro`);
  if (spec.gitCredentialsFile) args.push("-v", `${spec.gitCredentialsFile}:/root/.git-credentials:ro`);

  if (spec.extraDockerArgs?.length) args.push(...spec.extraDockerArgs);

  args.push(spec.image, "bash", "-c", WORKER_SCRIPT);
  return args;
}
