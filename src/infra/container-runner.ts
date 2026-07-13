/**
 * container-runner.ts — persistent per-issue Docker containers for coding work.
 *
 * Replaces git worktrees. Each Linear issue gets ONE long-lived container
 * (created on first engagement, reused on resume, reaped after a TTL):
 *
 *   - `/root/repos` (all repos) is bind-mounted READ-ONLY at `/repos-ro`.
 *   - target repo(s) are `git clone --shared`d writable into `/work/<name>`
 *     (alternates → instant, tiny; hardlinks can't cross the RO-mount/overlay
 *     filesystem boundary, so `--shared` not `--local`).
 *   - `.claw` artifacts live on a host-mounted dir so they survive the container
 *     for resume/summary.
 *   - codex runs via `docker exec … codex exec --dangerously-bypass-approvals-
 *     and-sandbox` — the container IS the sandbox (codex's own sandbox can't
 *     init inside Docker), and the flag also skips the trust prompt.
 *
 * STOP kills the running codex process (pkill) but LEAVES the container so the
 * next message continues in the same warm workspace. Fresh / the 24h reaper
 * `docker rm -f` it.
 *
 * All dynamic values reach the shell via ENV VARS (never interpolated into a
 * script string), so a hostile issue title / prompt can't inject commands.
 * Container names are derived deterministically from the issue identifier, so
 * STOP/destroy need no registry.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import type { LinearAgentApi, ActivityContent } from "../api/linear-api.js";
import { InactivityWatchdog } from "../agent/watchdog.js";
import { createProgressEmitter, formatActivityLogLine, type CliResult, type OnProgressUpdate } from "../tools/cli-shared.js";
import { mapCodexEventToActivity } from "../tools/codex-tool.js";

export const CONTAINER_PREFIX = "openclaw-linear";
export const ISSUE_LABEL = "openclaw.linear.issue";
export const CREATED_LABEL = "openclaw.linear.createdAt";
export const WORK_ROOT = "/work";
export const REPOS_RO_MOUNT = "/repos-ro";
export const CLAW_MOUNT = "/work/.claw";
/** Default container time-to-live from creation (24h) — reaped after. */
export const CONTAINER_TTL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Deterministic, docker-safe container name for an issue identifier. */
export function containerNameForIssue(issueIdentifier: string): string {
  const safe = issueIdentifier.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[-.]+/, "");
  return `${CONTAINER_PREFIX}-${safe || "issue"}`;
}

/** In-container writable working dir for a cloned repo. */
export function repoWorkdir(repoName: string): string {
  return `${WORK_ROOT}/${repoName}`;
}

/**
 * Extract a GitHub token from a git-credentials file so `gh` works in the
 * container (git push uses the mounted file; gh needs GH_TOKEN).
 * @param path - path to the git-credentials file
 * @returns the token, or undefined
 */
export function readGhTokenFromCredentials(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    // https://<user>:<token>@github.com  (or https://<token>@github.com)
    const m = /https:\/\/(?:[^:@/]+:)?([^@/\s]+)@github\.com/.exec(content);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export interface ContainerStartSpec {
  issueIdentifier: string;
  image: string;
  /** Repo names (keys in config) to clone writable at start. */
  targetRepos: string[];
  branch: string;
  /** Host path holding all repos (bind-mounted read-only). */
  reposRoot: string;
  /** Host dir mounted at /work/.claw for durable artifacts. */
  clawHostDir: string;
  codexAuthFile?: string;
  gitCredentialsFile?: string;
  ghToken?: string;
  memory?: string;
  cpus?: string;
  createdAtMs: number;
}

/**
 * Build the `docker run -d` argv for a persistent worker container. The
 * container just `sleep infinity`s; repos are provisioned by a follow-up exec.
 * @param spec - the container start spec
 * @returns argv for `docker`
 */
export function buildRunArgs(spec: ContainerStartSpec): string[] {
  const name = containerNameForIssue(spec.issueIdentifier);
  const args: string[] = [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${ISSUE_LABEL}=${spec.issueIdentifier}`,
    "--label",
    `${CREATED_LABEL}=${spec.createdAtMs}`,
    "-v",
    `${spec.reposRoot}:${REPOS_RO_MOUNT}:ro`,
    "-v",
    `${spec.clawHostDir}:${CLAW_MOUNT}`,
  ];
  if (spec.codexAuthFile) args.push("-v", `${spec.codexAuthFile}:/root/.codex/auth.json:ro`);
  if (spec.gitCredentialsFile) args.push("-v", `${spec.gitCredentialsFile}:/root/.git-credentials:ro`);
  if (spec.ghToken) args.push("-e", `GH_TOKEN=${spec.ghToken}`);
  if (spec.memory) args.push("--memory", spec.memory);
  if (spec.cpus) args.push("--cpus", spec.cpus);
  args.push(spec.image, "sleep", "infinity");
  return args;
}

/**
 * Shell script that provisions the target repos inside the container.
 * Reads REPOS (space-separated) and BRANCH from env — never interpolated.
 * Uses `git clone --shared` (alternates; hardlinks can't cross the RO/overlay
 * filesystem boundary).
 */
export const PROVISION_SCRIPT = [
  "set -eu",
  "git config --global credential.helper store",
  'git config --global user.email "agent@littledata.io"',
  'git config --global user.name "Littledata Agent"',
  "mkdir -p /work/.claw",
  "for r in $REPOS; do",
  '  if [ ! -d "/work/$r/.git" ]; then',
  '    git clone --shared "/repos-ro/$r" "/work/$r"',
  '    git -C "/work/$r" checkout -B "$BRANCH"',
  "  fi",
  "done",
].join("\n");

/**
 * Shell script to clone ONE additional repo on demand (cross-repo work).
 * Reads REPO and BRANCH from env.
 */
export const CLONE_ONE_SCRIPT = [
  "set -eu",
  'if [ ! -d "/work/$REPO/.git" ]; then',
  '  git clone --shared "/repos-ro/$REPO" "/work/$REPO"',
  '  git -C "/work/$REPO" checkout -B "$BRANCH"',
  "fi",
].join("\n");

/**
 * Build the in-container codex command string (values are trusted: config/derived).
 * `--skip-git-repo-check` lets `-C /work` (the multi-repo parent, not itself a git
 * repo) work for cross-repo runs; harmless when workdir IS a single repo.
 */
export function buildCodexInner(workdir: string, model?: string, effort?: string): string {
  const parts = ["codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json --ephemeral"];
  if (model) parts.push(`-m ${model}`);
  if (effort) parts.push(`-c model_reasoning_effort=${effort}`);
  parts.push(`-C ${workdir}`);
  parts.push('"$PROMPT"'); // prompt arrives via -e PROMPT (injection-safe)
  return parts.join(" ");
}

/** Git status + last-commit check inside a repo (porcelain). */
export const GIT_STATUS_SCRIPT = 'cd "$REPO_DIR" && printf "PORCELAIN<<\\n"; git status --porcelain; printf ">>\\nLASTCOMMIT="; git log --oneline -1 2>/dev/null || true';

/**
 * Shell script to commit pending work, push the branch, and open a PR. Reads
 * REPO_DIR, BRANCH, BASE, TITLE, BODY from env; requires GH_TOKEN. Commits any
 * uncommitted changes (no-op if the agent already committed), pushes, then opens
 * the PR. Prints the PR URL on success; `gh` prints "No commits between …" to
 * stderr when the repo is unchanged (handled by the caller as a skip).
 */
export const OPEN_PR_SCRIPT = [
  "set -u",
  'cd "$REPO_DIR"',
  "git add -A",
  'git commit -m "$TITLE" >/dev/null 2>&1 || true', // no-op if nothing staged
  'git push -u origin "$BRANCH" 1>&2 || true',
  'gh pr create --head "$BRANCH" ${BASE:+--base "$BASE"} --title "$TITLE" --body "$BODY"',
].join("\n");

interface ContainerRow {
  name: string;
  createdAtMs: number;
}

/** Parse `docker ps` rows of the form `<name>|<createdAtMs>`. */
export function parseContainerRows(output: string): ContainerRow[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, created] = l.split("|");
      return { name: name?.trim() ?? "", createdAtMs: Number(created) };
    })
    .filter((r) => r.name);
}

/** Select container names whose TTL has elapsed (or whose createdAt is unparseable). */
export function selectExpired(rows: ContainerRow[], now: number, ttlMs: number): string[] {
  return rows
    .filter((r) => !Number.isFinite(r.createdAtMs) || now - r.createdAtMs > ttlMs)
    .map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Docker command helpers (impure)
// ---------------------------------------------------------------------------

interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function dockerSync(args: string[], opts?: { timeoutMs?: number }): DockerResult {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** True if a container with this name is currently running. */
export function isContainerRunning(name: string): boolean {
  const r = dockerSync(["ps", "--filter", `name=^${name}$`, "--filter", "status=running", "-q"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** True if a container with this name exists in any state. */
export function containerExists(name: string): boolean {
  const r = dockerSync(["ps", "-a", "--filter", `name=^${name}$`, "-q"]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** `docker rm -f` a container (best-effort). */
export function destroyContainer(name: string): void {
  dockerSync(["rm", "-f", name], { timeoutMs: 30_000 });
}

export interface StartResult {
  name: string;
  reused: boolean;
}

/**
 * Create the issue's container (or reuse the running one). Provisions the
 * target repos on first create.
 * @param spec - the container start spec
 * @param logger - logger
 * @returns the container name + whether it was reused
 */
export function startOrReuseContainer(
  spec: ContainerStartSpec,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): StartResult {
  const name = containerNameForIssue(spec.issueIdentifier);

  if (isContainerRunning(name)) {
    logger.info(`[container] reusing warm container ${name}`);
    // Ensure the (possibly new) target repos exist in the warm container too.
    provisionRepos(name, spec.targetRepos, spec.branch, logger);
    return { name, reused: true };
  }
  if (containerExists(name)) {
    logger.info(`[container] removing stale (stopped) container ${name}`);
    destroyContainer(name);
  }

  mkdirSync(spec.clawHostDir, { recursive: true });
  const run = dockerSync(buildRunArgs(spec), { timeoutMs: 60_000 });
  if (run.status !== 0) {
    throw new Error(`docker run failed for ${name}: ${run.stderr.slice(0, 500)}`);
  }
  const provisioned = provisionRepos(name, spec.targetRepos, spec.branch, logger);
  if (spec.targetRepos.length && !provisioned.length) {
    // Empty container: every clone failed (e.g. the repo name has no matching
    // /repos-ro/<name>). Don't leave a hollow container to run codex in — tear it
    // down and fail loudly so the dispatch surfaces a real error.
    destroyContainer(name);
    throw new Error(
      `no repos could be provisioned in ${name} (requested: ${spec.targetRepos.join(", ")}) — ` +
        `check that each is a real repo under the read-only repos mount`,
    );
  }
  logger.info(`[container] created ${name} with repos=${provisioned.join(",")}`);
  return { name, reused: false };
}

/**
 * Clone/checkout the given repos inside a running container (idempotent).
 * Returns the names of repos that are actually present (have a .git dir) after
 * the attempt, so callers can detect a fully-empty provisioning.
 */
export function provisionRepos(
  name: string,
  repos: string[],
  branch: string,
  logger: { warn: (m: string) => void },
): string[] {
  if (!repos.length) return [];
  const r = dockerSync(
    ["exec", "-e", `REPOS=${repos.join(" ")}`, "-e", `BRANCH=${branch}`, name, "sh", "-c", PROVISION_SCRIPT],
    { timeoutMs: 120_000 },
  );
  if (r.status !== 0) logger.warn(`[container] provision on ${name} exit ${r.status}: ${r.stderr.slice(0, 300)}`);
  // Verify what actually landed — `set -eu` aborts the whole script on the first
  // failed clone, so a non-zero status doesn't tell us which repos made it.
  const present = repos.filter((repo) => {
    const check = dockerSync(["exec", name, "test", "-d", `${repoWorkdir(repo)}/.git`]);
    return check.status === 0;
  });
  if (present.length < repos.length) {
    const missing = repos.filter((repo) => !present.includes(repo));
    logger.warn(`[container] provision on ${name}: missing repos ${missing.join(",")}`);
  }
  return present;
}

/** Clone one more repo into a warm container on demand (cross-repo). */
export function cloneRepo(name: string, repo: string, branch: string): DockerResult {
  return dockerSync(
    ["exec", "-e", `REPO=${repo}`, "-e", `BRANCH=${branch}`, name, "sh", "-c", CLONE_ONE_SCRIPT],
    { timeoutMs: 120_000 },
  );
}

export interface ContainerGitStatus {
  hasChanges: boolean;
  lastCommit: string;
}

/** Read git status for a repo inside the container. */
export function containerGitStatus(name: string, repoName: string): ContainerGitStatus {
  const r = dockerSync(["exec", "-e", `REPO_DIR=${repoWorkdir(repoName)}`, name, "sh", "-c", GIT_STATUS_SCRIPT]);
  const porcelain = /PORCELAIN<<\n([\s\S]*?)\n?>>/.exec(r.stdout)?.[1] ?? "";
  const lastCommit = /LASTCOMMIT=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? "";
  return { hasChanges: porcelain.trim().length > 0, lastCommit };
}

/**
 * Commit + push a repo's branch and open a PR from inside the container.
 * @returns the PR URL, or null when the repo had no changes (gh "no commits")
 *   or a PR already exists. Throws on a genuine failure.
 */
export function openPrInContainer(
  name: string,
  repoName: string,
  branch: string,
  title: string,
  body: string,
  base?: string,
): string | null {
  const env = [
    "-e", `REPO_DIR=${repoWorkdir(repoName)}`,
    "-e", `BRANCH=${branch}`,
    "-e", `TITLE=${title}`,
    "-e", `BODY=${body}`,
  ];
  if (base) env.push("-e", `BASE=${base}`);
  const r = dockerSync(["exec", ...env, name, "sh", "-c", OPEN_PR_SCRIPT], { timeoutMs: 120_000 });
  const combined = `${r.stdout}\n${r.stderr}`;
  const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(combined)?.[0];
  if (url) return url;
  // Benign "nothing to PR" outcomes → skip, not an error.
  if (/no commits between|already exists|nothing to compare/i.test(combined)) return null;
  throw new Error(`PR creation failed in ${name}/${repoName}: ${combined.slice(0, 400)}`);
}

/**
 * Kill the running codex process inside the container — keeps the container
 * warm for the next message. Returns true if a codex process was actually
 * killed (pkill exit 0).
 */
export function stopContainerRun(name: string): boolean {
  const r = dockerSync(["exec", name, "pkill", "-f", "codex exec"], { timeoutMs: 15_000 });
  return r.status === 0;
}

/** Reap containers whose TTL has elapsed. Returns removed names. */
export function reapExpiredContainers(now: number, ttlMs: number = CONTAINER_TTL_MS): string[] {
  const r = dockerSync([
    "ps", "-a",
    "--filter", `label=${ISSUE_LABEL}`,
    "--format", `{{.Names}}|{{.Label "${CREATED_LABEL}"}}`,
  ]);
  if (r.status !== 0) return [];
  const expired = selectExpired(parseContainerRows(r.stdout), now, ttlMs);
  for (const name of expired) destroyContainer(name);
  return expired;
}

// ---------------------------------------------------------------------------
// Codex-in-container streaming (impure)
// ---------------------------------------------------------------------------

export interface ExecCodexOpts {
  containerName: string;
  /** In-container working dir: a single repo (/work/<name>) or /work for cross-repo. */
  workdir: string;
  prompt: string;
  model?: string;
  effort?: string;
  timeoutMs: number;
  inactivityMs: number;
  linearApi?: LinearAgentApi;
  agentSessionId?: string;
  onUpdate?: OnProgressUpdate;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Run codex inside the container via `docker exec`, streaming its JSONL events
 * to the Linear session (reusing the host mapper). Killable via
 * stopContainerRun (STOP) — pkill closes stdout and this resolves.
 * @param opts - exec options
 * @returns the codex result (success + collected output)
 */
export async function execCodexInContainer(opts: ExecCodexOpts): Promise<CliResult> {
  const { containerName, workdir, prompt, model, effort, timeoutMs, inactivityMs, linearApi, agentSessionId, onUpdate, logger } = opts;
  const inner = buildCodexInner(workdir, model, effort);
  const args = ["exec", "-e", `PROMPT=${prompt}`, containerName, "sh", "-c", inner];
  const progressHeader = `[container:${containerName}] ${workdir}\n$ ${inner.slice(0, 300)}\n\nPrompt: ${prompt.slice(0, 300)}`;

  if (linearApi && agentSessionId) {
    await linearApi.emitActivity(agentSessionId, {
      type: "thought",
      body: `Starting Codex in container: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
    }).catch(() => {});
  }

  return new Promise<CliResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let killed = false;
    let killedByWatchdog = false;

    const timer = setTimeout(() => {
      killed = true;
      stopContainerRun(containerName);
      child.kill("SIGKILL");
    }, timeoutMs);

    const watchdog = new InactivityWatchdog({
      inactivityMs,
      label: `container-codex:${containerName}`,
      logger,
      onKill: () => {
        killedByWatchdog = true;
        killed = true;
        clearTimeout(timer);
        stopContainerRun(containerName);
        child.kill("SIGKILL");
      },
    });
    watchdog.start();

    const messages: string[] = [];
    const commands: string[] = [];
    let stderrOut = "";
    const progress = createProgressEmitter({ header: progressHeader, onUpdate });
    progress.emitHeader();

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      watchdog.tick();
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        messages.push(line);
        return;
      }
      const item = event?.item;
      if (event?.type === "item.completed" && (item?.type === "agent_message" || item?.type === "message")) {
        const text = item.text ?? item.content ?? "";
        if (text) messages.push(text);
      }
      if (event?.type === "item.completed" && item?.type === "command_execution") {
        const cmd = item.command ?? "unknown";
        const exitCode = item.exit_code ?? "?";
        const out = item.aggregated_output ?? item.output ?? "";
        const trunc = out.length > 500 ? out.slice(0, 500) + "..." : out;
        commands.push(`\`${String(cmd).slice(0, 150)}\` → exit ${exitCode}${trunc ? "\n```\n" + trunc + "\n```" : ""}`);
      }
      for (const activity of mapCodexEventToActivity(event)) {
        if (linearApi && agentSessionId) {
          linearApi.emitActivity(agentSessionId, activity).catch(() => {});
        }
        progress.push(formatActivityLogLine(activity));
      }
    });

    child.stderr?.on("data", (chunk) => {
      watchdog.tick();
      stderrOut += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      watchdog.stop();
      rl.close();
      const parts: string[] = [];
      if (messages.length) parts.push(messages.join("\n\n"));
      if (commands.length) parts.push(commands.join("\n\n"));
      const output = parts.join("\n\n") || stderrOut || "(no output)";

      if (killed) {
        const reason = killedByWatchdog
          ? `Codex killed by inactivity watchdog (no I/O for ${Math.round(inactivityMs / 1000)}s)`
          : `Codex timed out after ${Math.round(timeoutMs / 1000)}s`;
        logger.warn(reason);
        resolve({ success: false, output: `${reason}. Partial output:\n${output}`, error: killedByWatchdog ? "inactivity_timeout" : "timeout" });
        return;
      }
      if (code !== 0) {
        logger.warn(`[container] codex exit ${code} in ${containerName}`);
        resolve({ success: false, output: `Codex failed (exit ${code}):\n${output}`, error: `exit ${code}` });
        return;
      }
      resolve({ success: true, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      watchdog.stop();
      rl.close();
      logger.error(`[container] docker exec spawn error: ${err}`);
      resolve({ success: false, output: `Failed to start codex in container: ${err.message}`, error: err.message });
    });
  });
}
