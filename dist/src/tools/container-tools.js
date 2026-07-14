/**
 * container-tools.ts — the agent's interface to its per-ticket Docker sandbox.
 *
 * These tools give an OpenClaw agent full write access INSIDE a container it
 * owns for the current Linear issue (edit code, run commands/tests, run the app,
 * clone more repos), while the host filesystem stays untouched. The container is
 * the write-isolation boundary: the agent's native write/shell tools are denied,
 * so the ONLY way it can mutate anything is through these tools, and everything
 * they touch lives in the container.
 *
 * The container for the active issue is resolved from the active-session
 * registry + the container registry, spawned/revived on first use, and its
 * sliding TTL is reset on every call.
 */
import { jsonResult } from "openclaw/plugin-sdk/core";
import { getCurrentSession, getActiveSessionByAgentId, getIssueIdentifierForAgentRun, } from "../pipeline/active-session.js";
import { getContainerRecord, touchContainer } from "../infra/container-registry.js";
import { ensureContainerAlive, execInContainer, writeFileToContainer, readFileFromContainer, codeSearchInContainer, containerGitStatus, cloneRepo, repoWorkdir, WORK_ROOT, } from "../infra/container-runner.js";
/** Cap tool output so a runaway command can't flood the agent's context. */
const MAX_OUTPUT = 24_000;
function clip(s) {
    if (s.length <= MAX_OUTPUT)
        return s;
    return `…(${s.length - MAX_OUTPUT} chars truncated)…\n${s.slice(-MAX_OUTPUT)}`;
}
/**
 * Resolve the container for the active issue, spawning/reviving it as needed.
 * Returns the live container name + the issue identifier, or an error string.
 */
function resolveContainer(api, ctx) {
    const pluginConfig = api.pluginConfig;
    const boundIdentifier = getIssueIdentifierForAgentRun(ctx.sessionId, ctx.sessionKey, ctx.agentId);
    const session = (boundIdentifier ? null : ctx.agentId ? getActiveSessionByAgentId(ctx.agentId) : null) ??
        (boundIdentifier ? null : getCurrentSession()) ??
        null;
    const identifier = boundIdentifier ?? session?.issueIdentifier;
    if (!identifier) {
        return { error: "No active Linear issue for this session — cannot resolve a container." };
    }
    const rec = getContainerRecord(identifier);
    if (!rec) {
        return { error: `No container is registered for ${identifier}. It should have been created at dispatch.` };
    }
    const name = ensureContainerAlive(identifier, rec.repos, rec.branch, pluginConfig, api.logger);
    if (!name) {
        return { error: `Could not start the container for ${identifier}.` };
    }
    touchContainer(identifier);
    return { containerName: name, identifier };
}
/**
 * Build the per-ticket container toolset for the agent.
 * @param api - the plugin API
 * @param rawCtx - the tool execution context (carries agentId/session)
 * @returns the container_* agent tools
 */
export function createContainerTools(api, rawCtx) {
    const ctx = rawCtx;
    const execTool = {
        name: "container_exec",
        label: "Container: run command",
        description: "Run a shell command inside this ticket's dedicated container. Use for building, running tests, " +
            "running the app, git, grep/find, installing deps — anything. The container is your sandbox: it " +
            "persists across turns and is the ONLY place you can write. Returns exit code, stdout, stderr.",
        promptSnippet: "container_exec — run a shell command in the ticket's container sandbox",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command line to run (sh -c). Pipes/quotes/redirects are preserved." },
                workdir: { type: "string", description: "Working directory inside the container (default: /work, or /work/<repo>)." },
                timeoutSec: { type: "number", description: "Max runtime in seconds (default 600)." },
            },
            required: ["command"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            const command = params.command ?? "";
            const cwd = params.workdir || WORK_ROOT;
            const timeoutMs = Math.min(Math.max((params.timeoutSec ?? 600) * 1000, 1000), 3_600_000);
            api.logger.info(`container_exec [${c.identifier}] ${cwd}$ ${command.slice(0, 200)}`);
            const r = execInContainer(c.containerName, command, cwd, timeoutMs);
            return jsonResult({
                success: r.exitCode === 0,
                exitCode: r.exitCode,
                stdout: clip(r.stdout),
                stderr: clip(r.stderr),
            });
        },
    };
    const writeTool = {
        name: "container_write_file",
        label: "Container: write file",
        description: "Create or overwrite a file inside this ticket's container. Parent directories are created. " +
            "Prefer this (or container_apply_patch) over shell heredocs for edits.",
        promptSnippet: "container_write_file — create/overwrite a file in the container",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Absolute path inside the container, e.g. /work/<repo>/src/x.ts." },
                content: { type: "string", description: "Full file contents." },
            },
            required: ["path", "content"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            if (!params.path)
                return jsonResult({ success: false, error: "path is required" });
            const r = writeFileToContainer(c.containerName, params.path, params.content ?? "");
            return jsonResult({ success: r.exitCode === 0, exitCode: r.exitCode, stderr: clip(r.stderr) });
        },
    };
    const readTool = {
        name: "container_read_file",
        label: "Container: read file",
        description: "Read a file from inside this ticket's container.",
        promptSnippet: "container_read_file — read a file from the container",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Absolute path inside the container." },
            },
            required: ["path"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            if (!params.path)
                return jsonResult({ success: false, error: "path is required" });
            const r = readFileFromContainer(c.containerName, params.path);
            return jsonResult({ success: r.exitCode === 0, content: clip(r.stdout), ...(r.exitCode !== 0 ? { error: clip(r.stderr) } : {}) });
        },
    };
    const patchTool = {
        name: "container_apply_patch",
        label: "Container: apply patch",
        description: "Apply a unified diff inside a repo in this ticket's container (git apply). Good for multi-hunk edits.",
        promptSnippet: "container_apply_patch — git apply a unified diff in the container",
        parameters: {
            type: "object",
            properties: {
                repo: { type: "string", description: "Repo name (the diff is applied from /work/<repo>)." },
                patch: { type: "string", description: "A unified diff (git apply format)." },
            },
            required: ["repo", "patch"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            if (!params.repo || !params.patch)
                return jsonResult({ success: false, error: "repo and patch are required" });
            const tmp = `/tmp/${_id.replace(/[^a-zA-Z0-9]/g, "")}.patch`;
            const w = writeFileToContainer(c.containerName, tmp, params.patch);
            if (w.exitCode !== 0)
                return jsonResult({ success: false, error: `could not stage patch: ${clip(w.stderr)}` });
            const r = execInContainer(c.containerName, `git apply --whitespace=fix "${tmp}"; rm -f "${tmp}"`, repoWorkdir(params.repo));
            return jsonResult({ success: r.exitCode === 0, exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr) });
        },
    };
    const statusTool = {
        name: "container_status",
        label: "Container: git status",
        description: "Show git status (dirty flag + last commit) for each repo cloned in this ticket's container.",
        promptSnippet: "container_status — git status of the container's repos",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            const rec = getContainerRecord(c.identifier);
            const repos = rec?.repos ?? [];
            const status = repos.map((repo) => {
                try {
                    const s = containerGitStatus(c.containerName, repo);
                    return { repo, hasChanges: s.hasChanges, commitsAhead: s.commitsAhead, lastCommit: s.lastCommit };
                }
                catch (err) {
                    return { repo, error: String(err).slice(0, 200) };
                }
            });
            return jsonResult({ success: true, repos: status });
        },
    };
    const cloneTool = {
        name: "container_clone_repo",
        label: "Container: clone another repo",
        description: "Clone an ADDITIONAL littledata repo into this ticket's container for cross-repo work. " +
            "The repo must exist in the read-only repos mirror. It lands at /work/<repo>.",
        promptSnippet: "container_clone_repo — add another repo to the container for cross-repo work",
        parameters: {
            type: "object",
            properties: {
                repo: { type: "string", description: "Repo name (directory name in the repos mirror)." },
            },
            required: ["repo"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            if (!params.repo)
                return jsonResult({ success: false, error: "repo is required" });
            const rec = getContainerRecord(c.identifier);
            const branch = rec?.branch ?? "main";
            const r = cloneRepo(c.containerName, params.repo, branch);
            return jsonResult({ success: r.status === 0, exitCode: r.status ?? -1, stderr: clip(r.stderr), path: repoWorkdir(params.repo) });
        },
    };
    const searchTool = {
        name: "container_search_code",
        label: "Container: semantic code search",
        description: "AST-aware SEMANTIC code search (CocoIndex) over a repo in this ticket's container. " +
            "Use it to find code by concept/description when you don't know exact names — it beats grep for " +
            "'where is X handled?'. Returns matches with file paths and line ranges. The first search in a " +
            "container is slow (it builds the index once); later searches are fast.",
        promptSnippet: "container_search_code — semantic (meaning-based) code search over the container's repos",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural-language description of the code you're looking for." },
                repo: { type: "string", description: "Repo name to search (defaults to the ticket's primary repo)." },
                limit: { type: "number", description: "Max results (default 10)." },
            },
            required: ["query"],
        },
        execute: async (_id, params) => {
            const c = resolveContainer(api, ctx);
            if ("error" in c)
                return jsonResult({ success: false, error: c.error });
            if (!params.query)
                return jsonResult({ success: false, error: "query is required" });
            const rec = getContainerRecord(c.identifier);
            const repo = params.repo || rec?.repos?.[0];
            if (!repo)
                return jsonResult({ success: false, error: "no repo to search" });
            const limit = Math.min(Math.max(params.limit ?? 10, 1), 100);
            api.logger.info(`container_search_code [${c.identifier}] ${repo}: ${params.query.slice(0, 120)}`);
            const r = codeSearchInContainer(c.containerName, repoWorkdir(repo), params.query, limit);
            if (r.exitCode === 127) {
                // ccc not in the image (pre-rebuild) — tell the agent to fall back to grep.
                return jsonResult({ success: false, error: "semantic search unavailable in this container; use container_exec with rg/grep instead" });
            }
            return jsonResult({ success: r.exitCode === 0, results: clip(r.stdout), ...(r.exitCode !== 0 ? { error: clip(r.stderr) } : {}) });
        },
    };
    return [execTool, writeTool, readTool, patchTool, statusTool, cloneTool, searchTool];
}
