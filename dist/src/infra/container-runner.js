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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InactivityWatchdog } from "../agent/watchdog.js";
import { createProgressEmitter, formatActivityLogLine } from "../tools/cli-shared.js";
import { mapCodexEventToActivity } from "../tools/codex-tool.js";
import { listContainerRecords, removeContainerRecord, selectIdleExpired } from "./container-registry.js";
import { getGitHubAppToken, githubAuthenticationEnvironment, invalidateGitHubAppToken, } from "./github-app-auth.js";
import { resolveGitHubRepository } from "./multi-repo.js";
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
export function containerNameForIssue(issueIdentifier) {
    const safe = issueIdentifier.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[-.]+/, "");
    return `${CONTAINER_PREFIX}-${safe || "issue"}`;
}
/** In-container writable working dir for a cloned repo. */
export function repoWorkdir(repoName) {
    return `${WORK_ROOT}/${repoName}`;
}
/**
 * Build the `docker run -d` argv for a persistent worker container. The
 * container just `sleep infinity`s; repos are provisioned by a follow-up exec.
 * @param spec - the container start spec
 * @returns argv for `docker`
 */
export function buildRunArgs(spec) {
    const name = containerNameForIssue(spec.issueIdentifier);
    const args = [
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
    if (spec.codexAuthFile)
        args.push("-v", `${spec.codexAuthFile}:/root/.codex/auth.json:ro`);
    if (spec.memory)
        args.push("--memory", spec.memory);
    if (spec.cpus)
        args.push("--cpus", spec.cpus);
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
/** Fetch and check out the exact head of a linked GitHub PR for read-only review. */
export const CHECKOUT_PR_SCRIPT = [
    "set -eu",
    'git -C "$REPO_DIR" fetch --force "$REMOTE_URL" "pull/$PR_NUMBER/head"',
    'git -C "$REPO_DIR" checkout -B "review/pr-$PR_NUMBER" FETCH_HEAD',
    'git -C "$REPO_DIR" reset --hard FETCH_HEAD',
].join("\n");
/** Publish a persistent GitHub PR review comment from inside the ticket sandbox. */
export const PUBLISH_PR_REVIEW_SCRIPT = [
    "set -eu",
    'cd "$REPO_DIR"',
    'gh pr review "$PR_URL" "$REVIEW_EVENT" --body "$REVIEW_BODY"',
    'HEAD_SHA=$(gh pr view "$PR_URL" --json headRefOid --jq .headRefOid)',
    'gh api --method POST "repos/$REPOSITORY/check-runs" -f name="OpenClaw Review" -f head_sha="$HEAD_SHA" -f status=completed -f conclusion="$CHECK_CONCLUSION" -f "output[title]=$CHECK_TITLE" -f "output[summary]=$REVIEW_BODY" >/dev/null',
].join("\n");
/**
 * Build the in-container codex command string (values are trusted: config/derived).
 * `--skip-git-repo-check` lets `-C /work` (the multi-repo parent, not itself a git
 * repo) work for cross-repo runs; harmless when workdir IS a single repo.
 */
export function buildCodexInner(workdir, model, effort) {
    const parts = ["codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json --ephemeral"];
    if (model)
        parts.push(`-m ${model}`);
    if (effort)
        parts.push(`-c model_reasoning_effort=${effort}`);
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
    "set -eu",
    'cd "$REPO_DIR"',
    "git add -A",
    'git commit -m "$TITLE" >/dev/null 2>&1 || true', // no-op if nothing staged
    'git remote set-url origin "$REMOTE_URL"',
    'git push -u origin "$BRANCH" 1>&2',
    'gh pr create --repo "$REPOSITORY" --head "$BRANCH" ${BASE:+--base "$BASE"} --title "$TITLE" --body "$BODY"',
].join("\n");
/** Parse `docker ps` rows of the form `<name>|<createdAtMs>`. */
export function parseContainerRows(output) {
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
export function selectExpired(rows, now, ttlMs) {
    return rows
        .filter((r) => !Number.isFinite(r.createdAtMs) || now - r.createdAtMs > ttlMs)
        .map((r) => r.name);
}
function dockerSync(args, opts) {
    const r = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: opts?.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function githubEnvironmentArgs(token) {
    return Object.entries(githubAuthenticationEnvironment(token)).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}
function isAuthenticationFailure(result) {
    return /bad credentials|authentication failed|could not read username|http 401|401 unauthorized|token (?:has )?expired/i.test(`${result.stdout}\n${result.stderr}`);
}
function redactToken(result, token) {
    return {
        ...result,
        stdout: result.stdout.replaceAll(token, "[REDACTED]"),
        stderr: result.stderr.replaceAll(token, "[REDACTED]"),
    };
}
async function runAuthenticatedDockerOperation(role, repository, pluginConfig, buildArgs, timeoutMs) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await getGitHubAppToken(role, repository, pluginConfig);
        const result = redactToken(dockerSync(buildArgs(githubEnvironmentArgs(token)), { timeoutMs }), token);
        if (result.status === 0 || !isAuthenticationFailure(result) || attempt === 1)
            return result;
        invalidateGitHubAppToken(role, repository);
    }
    return { status: 1, stdout: "", stderr: "GitHub authentication retry failed" };
}
/** True if a container with this name is currently running. */
export function isContainerRunning(name) {
    const r = dockerSync(["ps", "--filter", `name=^${name}$`, "--filter", "status=running", "-q"]);
    return r.status === 0 && r.stdout.trim().length > 0;
}
/** True if a container with this name exists in any state. */
export function containerExists(name) {
    const r = dockerSync(["ps", "-a", "--filter", `name=^${name}$`, "-q"]);
    return r.status === 0 && r.stdout.trim().length > 0;
}
/** `docker rm -f` a container (best-effort). */
export function destroyContainer(name) {
    dockerSync(["rm", "-f", name], { timeoutMs: 30_000 });
}
/**
 * Create the issue's container (or reuse the running one). Provisions the
 * target repos on first create.
 * @param spec - the container start spec
 * @param logger - logger
 * @returns the container name + whether it was reused
 */
export function startOrReuseContainer(spec, logger) {
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
        throw new Error(`no repos could be provisioned in ${name} (requested: ${spec.targetRepos.join(", ")}) — ` +
            `check that each is a real repo under the read-only repos mount`);
    }
    logger.info(`[container] created ${name} with repos=${provisioned.join(",")}`);
    return { name, reused: false };
}
/**
 * Build a container start spec from plugin config + host defaults. Centralizes the
 * config plumbing so both the initial dispatch and a later revive use identical
 * settings.
 * @param identifier - the Linear issue identifier
 * @param targetRepos - repo names to clone writable
 * @param branch - the working branch
 * @param pluginConfig - the plugin config (image/reposRoot/memory/cpus overrides)
 * @param createdAtMs - creation timestamp (for the TTL label)
 * @returns a fully-populated ContainerStartSpec
 */
export function buildContainerSpec(identifier, targetRepos, branch, pluginConfig, createdAtMs) {
    const home = process.env.HOME ?? homedir();
    const containersBase = pluginConfig?.containersBaseDir ?? join(home, ".openclaw", "containers");
    const hostRoot = join(containersBase, identifier.replace(/[^a-zA-Z0-9_.-]/g, "-"));
    return {
        issueIdentifier: identifier,
        image: pluginConfig?.workerImage ?? "openclaw-linear-worker:latest",
        targetRepos,
        branch,
        reposRoot: pluginConfig?.reposRoot ?? join(home, "repos"),
        clawHostDir: join(hostRoot, ".claw"),
        codexAuthFile: join(home, ".codex", "auth.json"),
        memory: pluginConfig?.containerMemory ?? "6g",
        cpus: pluginConfig?.containerCpus ?? "3",
        createdAtMs,
    };
}
/**
 * Ensure the issue's container is up and provisioned before running work in it.
 * Handles the three post-crash states: running (reuse), stopped (`docker start`
 * to preserve the cloned repos), or gone (recreate from a fresh spec). Returns
 * the live container name, or null if it couldn't be revived.
 * @param identifier - the Linear issue identifier
 * @param repos - target repo names
 * @param branch - the working branch
 * @param pluginConfig - the plugin config
 * @param logger - logger
 * @returns the running container name, or null on failure
 */
export function ensureContainerAlive(identifier, repos, branch, pluginConfig, logger) {
    const name = containerNameForIssue(identifier);
    if (isContainerRunning(name))
        return name;
    if (containerExists(name)) {
        // Stopped (e.g. host reboot, OOM of the payload, or an exec killed by a
        // gateway restart). Restart it — the cloned repos + any commits survive.
        const started = dockerSync(["start", name], { timeoutMs: 30_000 });
        if (started.status === 0 && isContainerRunning(name)) {
            logger.info(`[container] restarted stopped container ${name}`);
            provisionRepos(name, repos, branch, logger); // idempotent — no-op if already cloned
            return name;
        }
        logger.warn(`[container] failed to restart ${name} (exit ${started.status}) — recreating`);
        destroyContainer(name);
    }
    try {
        const spec = buildContainerSpec(identifier, repos, branch, pluginConfig, Date.now());
        const res = startOrReuseContainer(spec, logger);
        logger.info(`[container] revived ${res.name} (recreated)`);
        return res.name;
    }
    catch (err) {
        logger.warn(`[container] could not revive ${name}: ${err}`);
        return null;
    }
}
/**
 * Clone/checkout the given repos inside a running container (idempotent).
 * Returns the names of repos that are actually present (have a .git dir) after
 * the attempt, so callers can detect a fully-empty provisioning.
 */
export function provisionRepos(name, repos, branch, logger) {
    if (!repos.length)
        return [];
    const r = dockerSync(["exec", "-e", `REPOS=${repos.join(" ")}`, "-e", `BRANCH=${branch}`, name, "sh", "-c", PROVISION_SCRIPT], { timeoutMs: 120_000 });
    if (r.status !== 0)
        logger.warn(`[container] provision on ${name} exit ${r.status}: ${r.stderr.slice(0, 300)}`);
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
export function cloneRepo(name, repo, branch) {
    return dockerSync(["exec", "-e", `REPO=${repo}`, "-e", `BRANCH=${branch}`, name, "sh", "-c", CLONE_ONE_SCRIPT], { timeoutMs: 120_000 });
}
/**
 * Check out a linked GitHub PR head in an already-provisioned repo.
 * The PR URL and number are passed through environment variables, never shell
 * interpolation. Returns a normal Docker command result for explicit gating.
 * @param name - ticket container name
 * @param repo - configured repository key
 * @param pullRequestUrl - canonical GitHub pull request URL
 * @param pullRequestNumber - GitHub pull request number
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns Docker checkout result
 */
export async function checkoutPullRequestInContainer(name, repo, pullRequestUrl, pullRequestNumber, pluginConfig) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(pullRequestUrl.trim());
    if (!match || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return { status: 2, stdout: "", stderr: `invalid GitHub pull request: ${pullRequestUrl}` };
    }
    const repository = `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
    const expectedRepository = resolveGitHubRepository(repo, pluginConfig);
    if (repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        return {
            status: 2,
            stdout: "",
            stderr: `pull request repository ${repository} does not match configured repository ${expectedRepository}`,
        };
    }
    const remoteUrl = `https://github.com/${repository}.git`;
    return runAuthenticatedDockerOperation("reviewer", repository, pluginConfig, (authenticationArgs) => [
        "exec",
        ...authenticationArgs,
        "-e", `REPO_DIR=${repoWorkdir(repo)}`,
        "-e", `REMOTE_URL=${remoteUrl}`,
        "-e", `PR_NUMBER=${pullRequestNumber}`,
        name,
        "sh", "-c", CHECKOUT_PR_SCRIPT,
    ], 120_000);
}
/**
 * Publish a review comment on a linked PR using the container's authenticated
 * GitHub CLI. Keeping this inside the ticket container uses the same credentials
 * and repository context as implementation/review work.
 * @param name - ticket container name
 * @param repo - configured repository key
 * @param pullRequestUrl - canonical GitHub pull request URL
 * @param body - review body
 * @param passed - whether to approve or request changes
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns Docker publication result
 */
export async function publishPullRequestReviewInContainer(name, repo, pullRequestUrl, body, passed, pluginConfig) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(pullRequestUrl.trim());
    if (!match) {
        return { status: 2, stdout: "", stderr: `invalid GitHub pull request: ${pullRequestUrl}` };
    }
    const repository = `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
    const expectedRepository = resolveGitHubRepository(repo, pluginConfig);
    if (repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        return {
            status: 2,
            stdout: "",
            stderr: `pull request repository ${repository} does not match configured repository ${expectedRepository}`,
        };
    }
    return runAuthenticatedDockerOperation("reviewer", repository, pluginConfig, (authenticationArgs) => [
        "exec",
        ...authenticationArgs,
        "-e", `REPO_DIR=${repoWorkdir(repo)}`,
        "-e", `PR_URL=${pullRequestUrl.trim()}`,
        "-e", `REPOSITORY=${repository}`,
        "-e", `REVIEW_BODY=${body}`,
        "-e", `REVIEW_EVENT=${passed ? "--approve" : "--request-changes"}`,
        "-e", `CHECK_CONCLUSION=${passed ? "success" : "failure"}`,
        "-e", `CHECK_TITLE=${passed ? "Review passed" : "Changes requested"}`,
        name,
        "sh", "-c", PUBLISH_PR_REVIEW_SCRIPT,
    ], 120_000);
}
/**
 * Run an arbitrary shell command inside the container and capture its output.
 * The command is passed via env + `eval` (never interpolated into the script
 * text), so quoting/pipes/redirects are preserved and a hostile string can't
 * break out of the intended shell — and the container is the sandbox regardless.
 * @param name - container name
 * @param command - the shell command line to run
 * @param cwd - working directory inside the container (default /work)
 * @param timeoutMs - max runtime (default 10 min)
 * @returns exit code + captured stdout/stderr
 */
export function execInContainer(name, command, cwd = WORK_ROOT, timeoutMs = 600_000) {
    const r = dockerSync(["exec", "-w", cwd, "-e", `AGENT_CMD=${command}`, name, "sh", "-c", 'eval "$AGENT_CMD"'], { timeoutMs });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
/**
 * Write a file inside the container (content base64-piped so any bytes/quotes
 * survive). Creates parent directories.
 * @param name - container name
 * @param filePath - absolute path inside the container
 * @param content - file contents
 * @returns exit code + captured output
 */
export function writeFileToContainer(name, filePath, content) {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const r = dockerSync([
        "exec",
        "-e",
        `FP=${filePath}`,
        "-e",
        `B64=${b64}`,
        name,
        "sh",
        "-c",
        'mkdir -p "$(dirname "$FP")" && printf %s "$B64" | base64 -d > "$FP"',
    ], { timeoutMs: 60_000 });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
/**
 * Read a file from inside the container.
 * @param name - container name
 * @param filePath - absolute path inside the container
 * @returns exit code + file contents (in stdout)
 */
export function readFileFromContainer(name, filePath) {
    const r = dockerSync(["exec", "-e", `FP=${filePath}`, name, "sh", "-c", 'cat "$FP"'], { timeoutMs: 60_000 });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
/**
 * Shell script for `ccc` semantic code search. Keeps the repo pristine: the
 * index lives in `.cocoindex_code/` which `ccc` auto-gitignores, and we also add
 * it to the repo's LOCAL git exclude so it never appears in status/commits even
 * if `.gitignore` isn't honored. Query + limit arrive via env (never interpolated).
 */
const CODE_SEARCH_SCRIPT = [
    'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"',
    'command -v ccc >/dev/null 2>&1 || { echo "ccc (cocoindex-code) is not installed in this container" >&2; exit 127; }',
    'if [ -d .git ]; then grep -qx ".cocoindex_code/" .git/info/exclude 2>/dev/null || echo ".cocoindex_code/" >> .git/info/exclude; fi',
    // Incremental index (first run downloads the embedding model + full index).
    'ccc index >/dev/null 2>&1 || true',
    'ccc search "$CCC_QUERY" --limit "$CCC_LIMIT"',
].join("\n");
/**
 * Run a CocoIndex semantic code search inside a repo in the container.
 * @param name - container name
 * @param repoDir - the in-container repo directory (e.g. /work/<repo>)
 * @param query - natural-language query
 * @param limit - max results
 * @param timeoutMs - max runtime (first index can be slow — model download + full index)
 * @returns exit code + search results (stdout)
 */
export function codeSearchInContainer(name, repoDir, query, limit = 10, timeoutMs = 900_000) {
    const r = dockerSync(["exec", "-w", repoDir, "-e", `CCC_QUERY=${query}`, "-e", `CCC_LIMIT=${limit}`, name, "sh", "-c", CODE_SEARCH_SCRIPT], { timeoutMs });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
/** Read git status for a repo inside the container. */
export function containerGitStatus(name, repoName) {
    const r = dockerSync(["exec", "-e", `REPO_DIR=${repoWorkdir(repoName)}`, name, "sh", "-c", GIT_STATUS_SCRIPT]);
    const porcelain = /PORCELAIN<<\n([\s\S]*?)\n?>>/.exec(r.stdout)?.[1] ?? "";
    const lastCommit = /LASTCOMMIT=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? "";
    return { hasChanges: porcelain.trim().length > 0, lastCommit };
}
/**
 * Commit + push a repo's branch and open a PR from inside the container.
 * @param name - ticket container name
 * @param repoName - configured repository key
 * @param branch - branch to push
 * @param title - pull request title and fallback commit message
 * @param body - pull request body
 * @param pluginConfig - OpenClaw plugin configuration
 * @param base - optional base branch
 * @returns the PR URL, or null when the repo had no changes (gh "no commits")
 *   or a PR already exists. Throws on a genuine failure.
 */
export async function openPrInContainer(name, repoName, branch, title, body, pluginConfig, base) {
    const repository = resolveGitHubRepository(repoName, pluginConfig);
    const env = [
        "-e", `REPO_DIR=${repoWorkdir(repoName)}`,
        "-e", `BRANCH=${branch}`,
        "-e", `TITLE=${title}`,
        "-e", `BODY=${body}`,
        "-e", `REPOSITORY=${repository}`,
        "-e", `REMOTE_URL=https://github.com/${repository}.git`,
    ];
    if (base)
        env.push("-e", `BASE=${base}`);
    const r = await runAuthenticatedDockerOperation("coding", repository, pluginConfig, (authenticationArgs) => ["exec", ...authenticationArgs, ...env, name, "sh", "-c", OPEN_PR_SCRIPT], 120_000);
    const combined = `${r.stdout}\n${r.stderr}`;
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(combined)?.[0];
    if (url)
        return url;
    // Benign "nothing to PR" outcomes → skip, not an error.
    if (/no commits between|already exists|nothing to compare/i.test(combined))
        return null;
    throw new Error(`PR creation failed in ${name}/${repoName}: ${combined.slice(0, 400)}`);
}
/**
 * Kill the running codex process inside the container — keeps the container
 * warm for the next message. Returns true if a codex process was actually
 * killed (pkill exit 0).
 */
export function stopContainerRun(name) {
    const r = dockerSync(["exec", name, "pkill", "-f", "codex exec"], { timeoutMs: 15_000 });
    return r.status === 0;
}
/**
 * Reap containers idle past the TTL (SLIDING — reset on every container tool use,
 * tracked in the container registry), plus orphan labeled containers that have no
 * registry record and are older than the TTL by creation. Returns removed names.
 * @param now - current time in ms
 * @param ttlMs - idle time-to-live in ms
 * @returns the container names removed
 */
export function reapExpiredContainers(now, ttlMs = CONTAINER_TTL_MS) {
    const removed = [];
    // 1. Idle-expired registered containers (sliding TTL on lastUsed).
    const records = listContainerRecords();
    const knownNames = new Set(records.map((rec) => rec.containerName));
    for (const rec of selectIdleExpired(records, now, ttlMs)) {
        destroyContainer(rec.containerName);
        removeContainerRecord(rec.issueIdentifier);
        removed.push(rec.containerName);
    }
    // 2. Orphans: labeled worker containers with no registry record, expired by
    //    creation time (stale from before the registry, or a lost record).
    const r = dockerSync([
        "ps", "-a",
        "--filter", `label=${ISSUE_LABEL}`,
        "--format", `{{.Names}}|{{.Label "${CREATED_LABEL}"}}`,
    ]);
    if (r.status === 0) {
        const orphanRows = parseContainerRows(r.stdout).filter((row) => !knownNames.has(row.name));
        for (const name of selectExpired(orphanRows, now, ttlMs)) {
            destroyContainer(name);
            removed.push(name);
        }
    }
    return removed;
}
/**
 * Run codex inside the container via `docker exec`, streaming its JSONL events
 * to the Linear session (reusing the host mapper). Killable via
 * stopContainerRun (STOP) — pkill closes stdout and this resolves.
 * @param opts - exec options
 * @returns the codex result (success + collected output)
 */
export async function execCodexInContainer(opts) {
    const { containerName, workdir, prompt, model, effort, timeoutMs, inactivityMs, linearApi, agentSessionId, onUpdate, logger } = opts;
    const inner = buildCodexInner(workdir, model, effort);
    const args = ["exec", "-e", `PROMPT=${prompt}`, containerName, "sh", "-c", inner];
    const progressHeader = `[container:${containerName}] ${workdir}\n$ ${inner.slice(0, 300)}\n\nPrompt: ${prompt.slice(0, 300)}`;
    if (linearApi && agentSessionId) {
        await linearApi.emitActivity(agentSessionId, {
            type: "thought",
            body: `Starting Codex in container: "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"`,
        }).catch(() => { });
    }
    return new Promise((resolve) => {
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
        const messages = [];
        const commands = [];
        let stderrOut = "";
        const progress = createProgressEmitter({ header: progressHeader, onUpdate });
        progress.emitHeader();
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
            if (!line.trim())
                return;
            watchdog.tick();
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                messages.push(line);
                return;
            }
            const item = event?.item;
            if (event?.type === "item.completed" && (item?.type === "agent_message" || item?.type === "message")) {
                const text = item.text ?? item.content ?? "";
                if (text)
                    messages.push(text);
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
                    linearApi.emitActivity(agentSessionId, activity).catch(() => { });
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
            const parts = [];
            if (messages.length)
                parts.push(messages.join("\n\n"));
            if (commands.length)
                parts.push(commands.join("\n\n"));
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
