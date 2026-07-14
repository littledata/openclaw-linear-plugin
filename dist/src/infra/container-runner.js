/**
 * container-runner.ts — persistent per-issue Docker containers for coding work.
 *
 * Replaces git worktrees. Each Linear issue gets ONE long-lived container
 * (created on first engagement, reused on resume, reaped after a TTL):
 *
 *   - target repo(s) are cloned directly from GitHub into `/work/<name>` with a
 *     short-lived coding-App installation token. Legacy local-mirror mode is
 *     retained for migration compatibility.
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
import { formatCodexCommandOutput, mapCodexEventToActivity } from "../tools/codex-tool.js";
import { listContainerRecords, removeContainerRecord, selectIdleExpired } from "./container-registry.js";
import { getGitHubAppTokenForRepositories, githubAuthenticationEnvironment, invalidateGitHubAppToken, } from "./github-app-auth.js";
import { resolveGitHubDefaultBranch, resolveGitHubRepository } from "./multi-repo.js";
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
        `${spec.clawHostDir}:${CLAW_MOUNT}`,
    ];
    if (spec.repositorySource !== "github-app" && spec.reposRoot) {
        args.splice(args.length - 2, 0, "-v", `${spec.reposRoot}:${REPOS_RO_MOUNT}:ro`);
    }
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
    '    git -C "/work/$r" update-ref refs/openclaw/base HEAD',
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
    '  git -C "/work/$REPO" update-ref refs/openclaw/base HEAD',
    "fi",
].join("\n");
/** Clone or refresh one GitHub repository without persisting its token. */
export const PROVISION_GITHUB_REPO_SCRIPT = [
    "set -eu",
    'git config --global user.email "agent@littledata.io"',
    'git config --global user.name "Littledata Agent"',
    'mkdir -p "$(dirname "$REPO_DIR")" /work/.claw',
    'if [ ! -d "$REPO_DIR/.git" ]; then',
    '  git clone "$REMOTE_URL" "$REPO_DIR"',
    '  DEFAULT_REF="origin/$DEFAULT_BRANCH"',
    '  if ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/$DEFAULT_REF"; then',
    '    DEFAULT_REF=$(git -C "$REPO_DIR" symbolic-ref --short refs/remotes/origin/HEAD)',
    "  fi",
    '  if git -C "$REPO_DIR" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then',
    '    git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"',
    '    if ! git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"; then',
    '      LOCAL_TREE=$(git -C "$REPO_DIR" rev-parse HEAD^{tree})',
    '      REMOTE_TREE=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH^{tree}")',
    '      [ "$LOCAL_TREE" = "$REMOTE_TREE" ] || exit 1',
    '      git -C "$REPO_DIR" reset --hard "origin/$BRANCH"',
    "    fi",
    "  else",
    '    git -C "$REPO_DIR" checkout -B "$BRANCH" "$DEFAULT_REF"',
    "  fi",
    '  BASE=$(git -C "$REPO_DIR" merge-base HEAD "$DEFAULT_REF" 2>/dev/null || git -C "$REPO_DIR" rev-parse "$DEFAULT_REF")',
    '  git -C "$REPO_DIR" update-ref refs/openclaw/base "$BASE"',
    "else",
    '  git -C "$REPO_DIR" remote set-url origin "$REMOTE_URL"',
    '  git -C "$REPO_DIR" fetch --prune origin',
    '  DEFAULT_REF="origin/$DEFAULT_BRANCH"',
    '  if ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/$DEFAULT_REF"; then',
    '    DEFAULT_REF=$(git -C "$REPO_DIR" symbolic-ref --short refs/remotes/origin/HEAD)',
    "  fi",
    '  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then',
    '    git -C "$REPO_DIR" checkout "$BRANCH"',
    '  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then',
    '    git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"',
    "  else",
    '    git -C "$REPO_DIR" checkout -B "$BRANCH" "$DEFAULT_REF"',
    "  fi",
    '  if [ -z "$(git -C "$REPO_DIR" status --porcelain)" ] && git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then',
    '    if ! git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"; then',
    '      LOCAL_TREE=$(git -C "$REPO_DIR" rev-parse HEAD^{tree})',
    '      REMOTE_TREE=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH^{tree}")',
    '      [ "$LOCAL_TREE" = "$REMOTE_TREE" ] || exit 1',
    '      git -C "$REPO_DIR" reset --hard "origin/$BRANCH"',
    "    fi",
    "  fi",
    '  if ! git -C "$REPO_DIR" show-ref --verify --quiet refs/openclaw/base; then',
    '    BASE=$(git -C "$REPO_DIR" merge-base HEAD "$DEFAULT_REF" 2>/dev/null || git -C "$REPO_DIR" rev-parse "$DEFAULT_REF")',
    '    git -C "$REPO_DIR" update-ref refs/openclaw/base "$BASE"',
    "  fi",
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
/** Git status + commits since the repo was provisioned. */
export const GIT_STATUS_SCRIPT = [
    'cd "$REPO_DIR"',
    'printf "PORCELAIN<<\\n"',
    "git status --porcelain",
    'printf ">>\\nLASTCOMMIT="',
    "git log --oneline -1 2>/dev/null || true",
    'printf "\\nCOMMITMESSAGE<<\\n"',
    "git log -1 --pretty=%B 2>/dev/null || true",
    'printf ">>\\n"',
    'BASE=$(git rev-parse refs/openclaw/base 2>/dev/null || git merge-base HEAD refs/remotes/origin/HEAD 2>/dev/null || true)',
    'AHEAD=0; if [ -n "$BASE" ]; then AHEAD=$(git rev-list --count "$BASE"..HEAD 2>/dev/null || echo 0); fi',
    'printf "\\nCOMMITS_AHEAD=%s\\n" "$AHEAD"',
].join("; ");
/**
 * Shell script to publish committed work and open (or locate) its PR. Reads
 * REPO_DIR, BRANCH, BASE, TITLE, BODY from env; requires GH_TOKEN. A dirty tree
 * is rejected because coding/self-review fixes must be explicit commits. Prints
 * the newly-created or existing PR URL on success.
 */
export const OPEN_PR_SCRIPT = [
    "set -eu",
    'cd "$REPO_DIR"',
    'if [ -n "$(git status --porcelain)" ]; then echo "working tree is not clean; the coding agent must commit before publication" >&2; exit 3; fi',
    'git remote set-url origin "$REMOTE_URL"',
    'git push -u origin "$BRANCH" 1>&2',
    'if ! gh pr create --repo "$REPOSITORY" --head "$BRANCH" ${BASE:+--base "$BASE"} --title "$TITLE" --body "$BODY"; then',
    '  gh pr view "$BRANCH" --repo "$REPOSITORY" --json url --jq .url',
    "fi",
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
        const repositories = Array.isArray(repository) ? repository : [repository];
        const token = await getGitHubAppTokenForRepositories(role, repositories, pluginConfig);
        const result = redactToken(dockerSync(buildArgs(githubEnvironmentArgs(token)), { timeoutMs }), token);
        if (result.status === 0 || !isAuthenticationFailure(result) || attempt === 1)
            return result;
        for (const scopedRepository of repositories)
            invalidateGitHubAppToken(role, scopedRepository);
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
export async function startOrReuseContainer(spec, logger, pluginConfig) {
    const name = containerNameForIssue(spec.issueIdentifier);
    if (isContainerRunning(name)) {
        logger.info(`[container] reusing warm container ${name}`);
        // Ensure the (possibly new) target repos exist in the warm container too.
        await provisionRepos(name, spec.targetRepos, spec.branch, logger, pluginConfig);
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
    const provisioned = await provisionRepos(name, spec.targetRepos, spec.branch, logger, pluginConfig);
    if (spec.targetRepos.length && !provisioned.length) {
        // Empty container: every clone failed (e.g. the repo name has no matching
        // /repos-ro/<name>). Don't leave a hollow container to run codex in — tear it
        // down and fail loudly so the dispatch surfaces a real error.
        destroyContainer(name);
        throw new Error(`no repos could be provisioned in ${name} (requested: ${spec.targetRepos.join(", ")}) — ` +
            `check the GitHub App installation and repository configuration`);
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
        repositorySource: pluginConfig?.repositorySource === "github-app" ? "github-app" : "local",
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
export async function ensureContainerAlive(identifier, repos, branch, pluginConfig, logger) {
    const name = containerNameForIssue(identifier);
    if (isContainerRunning(name))
        return name;
    if (containerExists(name)) {
        // Stopped (e.g. host reboot, OOM of the payload, or an exec killed by a
        // gateway restart). Restart it — the cloned repos + any commits survive.
        const started = dockerSync(["start", name], { timeoutMs: 30_000 });
        if (started.status === 0 && isContainerRunning(name)) {
            logger.info(`[container] restarted stopped container ${name}`);
            await provisionRepos(name, repos, branch, logger, pluginConfig); // idempotent refresh
            return name;
        }
        logger.warn(`[container] failed to restart ${name} (exit ${started.status}) — recreating`);
        destroyContainer(name);
    }
    try {
        const spec = buildContainerSpec(identifier, repos, branch, pluginConfig, Date.now());
        const res = await startOrReuseContainer(spec, logger, pluginConfig);
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
export async function provisionRepos(name, repos, branch, logger, pluginConfig) {
    if (!repos.length)
        return [];
    const successfulRemoteRepos = new Set();
    if (pluginConfig?.repositorySource === "github-app") {
        for (const repo of repos) {
            const repository = resolveGitHubRepository(repo, pluginConfig);
            const r = await runAuthenticatedDockerOperation("coding", repository, pluginConfig, (authenticationArgs) => [
                "exec",
                ...authenticationArgs,
                "-e", `BRANCH=${branch}`,
                "-e", `REPO_DIR=${repoWorkdir(repo)}`,
                "-e", `REMOTE_URL=https://github.com/${repository}.git`,
                "-e", `DEFAULT_BRANCH=${resolveGitHubDefaultBranch(repo, pluginConfig)}`,
                name,
                "sh", "-c", PROVISION_GITHUB_REPO_SCRIPT,
            ], 10 * 60_000);
            if (r.status !== 0) {
                logger.warn(`[container] GitHub provision on ${name}/${repo} exit ${r.status}: ${r.stderr.slice(0, 500)}`);
            }
            else {
                successfulRemoteRepos.add(repo);
            }
        }
    }
    else {
        const r = dockerSync(["exec", "-e", `REPOS=${repos.join(" ")}`, "-e", `BRANCH=${branch}`, name, "sh", "-c", PROVISION_SCRIPT], { timeoutMs: 120_000 });
        if (r.status !== 0)
            logger.warn(`[container] provision on ${name} exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    }
    // Verify what actually landed — `set -eu` aborts the whole script on the first
    // failed clone, so a non-zero status doesn't tell us which repos made it.
    const present = repos.filter((repo) => {
        if (pluginConfig?.repositorySource === "github-app" && !successfulRemoteRepos.has(repo)) {
            return false;
        }
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
export async function cloneRepo(name, repo, branch, pluginConfig) {
    if (pluginConfig?.repositorySource === "github-app") {
        const provisioned = await provisionRepos(name, [repo], branch, { warn: () => { } }, pluginConfig);
        return provisioned.includes(repo)
            ? { status: 0, stdout: repoWorkdir(repo), stderr: "" }
            : { status: 1, stdout: "", stderr: `repository ${repo} was not cloned or checked out` };
    }
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
 * Run an arbitrary command with a short-lived GitHub App token available only
 * to that `docker exec`. The token and PEM are never written into the container.
 * @param role - coding or reviewer identity
 * @param name - container name
 * @param repoNames - configured repository keys to scope the token to
 * @param command - shell command
 * @param cwd - in-container working directory
 * @param timeoutMs - maximum runtime
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns captured command result with credentials redacted
 */
export async function execAuthenticatedInContainer(role, name, repoNames, command, cwd, timeoutMs, pluginConfig) {
    const repositories = repoNames.map((repo) => resolveGitHubRepository(repo, pluginConfig));
    const r = await runAuthenticatedDockerOperation(role, repositories, pluginConfig, (authenticationArgs) => [
        "exec",
        ...authenticationArgs,
        "-w", cwd,
        "-e", `AGENT_CMD=${command}`,
        name,
        "sh", "-c", 'eval "$AGENT_CMD"',
    ], timeoutMs);
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
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
/** Parse the output produced by {@link GIT_STATUS_SCRIPT}. */
export function parseContainerGitStatus(output) {
    const porcelain = /PORCELAIN<<\n([\s\S]*?)\n?>>/.exec(output)?.[1] ?? "";
    const lastCommit = /LASTCOMMIT=(.*)$/m.exec(output)?.[1]?.trim() ?? "";
    const lastCommitMessage = /COMMITMESSAGE<<\n([\s\S]*?)\n?>>/.exec(output)?.[1]?.trim() ?? "";
    const parsedAhead = Number(/COMMITS_AHEAD=(\d+)/.exec(output)?.[1] ?? "0");
    const commitsAhead = Number.isFinite(parsedAhead) ? parsedAhead : 0;
    const hasUncommitted = porcelain.trim().length > 0;
    return {
        hasChanges: hasUncommitted || commitsAhead > 0,
        hasUncommitted,
        lastCommit,
        lastCommitMessage,
        commitsAhead,
    };
}
/** Read git status for a repo inside the container. */
export function containerGitStatus(name, repoName) {
    const r = dockerSync(["exec", "-e", `REPO_DIR=${repoWorkdir(repoName)}`, name, "sh", "-c", GIT_STATUS_SCRIPT]);
    return parseContainerGitStatus(r.stdout);
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
 * @returns the new or existing PR URL, or null when the repo had no commits.
 *   Throws on a dirty worktree or genuine publication failure.
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
    // Benign "nothing to PR" outcomes → skip, not an error. An existing PR is
    // resolved by OPEN_PR_SCRIPT and therefore returns its URL above.
    if (/no commits between|nothing to compare/i.test(combined))
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
    let installationToken = "";
    let authenticationArgs = [];
    if (opts.pluginConfig?.repositorySource === "github-app" &&
        opts.githubRole &&
        opts.githubRepositories?.length) {
        const repositories = opts.githubRepositories.map((repo) => resolveGitHubRepository(repo, opts.pluginConfig));
        try {
            installationToken = await getGitHubAppTokenForRepositories(opts.githubRole, repositories, opts.pluginConfig);
            authenticationArgs = githubEnvironmentArgs(installationToken);
        }
        catch (err) {
            return {
                success: false,
                output: `Could not authenticate the ${opts.githubRole} GitHub App for this turn: ${String(err)}`,
                error: "github_authentication_failed",
            };
        }
    }
    const args = ["exec", ...authenticationArgs, "-e", `PROMPT=${prompt}`, containerName, "sh", "-c", inner];
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
        rl.on("line", (rawLine) => {
            const line = installationToken ? rawLine.replaceAll(installationToken, "[REDACTED]") : rawLine;
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
                const trunc = formatCodexCommandOutput(cmd, out, 500);
                commands.push(`\`${String(cmd).slice(0, 150)}\` → exit ${exitCode}${trunc ? "\n```\n" + trunc + "\n```" : ""}`);
            }
            for (const activity of mapCodexEventToActivity(event)) {
                if (linearApi && agentSessionId) {
                    linearApi.emitActivity(agentSessionId, activity, event?.type === "item.started" && event?.item?.type === "command_execution"
                        ? { ephemeral: true }
                        : undefined).catch(() => { });
                }
                progress.push(formatActivityLogLine(activity));
            }
        });
        child.stderr?.on("data", (chunk) => {
            watchdog.tick();
            const text = chunk.toString();
            stderrOut += installationToken ? text.replaceAll(installationToken, "[REDACTED]") : text;
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
