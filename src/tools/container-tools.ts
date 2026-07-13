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

import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { getCurrentSession, getActiveSessionByAgentId, getActiveSessionByIdentifier } from "../pipeline/active-session.js";
import { getContainerRecord, touchContainer } from "../infra/container-registry.js";
import {
  ensureContainerAlive,
  execInContainer,
  writeFileToContainer,
  readFileFromContainer,
  containerGitStatus,
  cloneRepo,
  repoWorkdir,
  WORK_ROOT,
} from "../infra/container-runner.js";

/** Cap tool output so a runaway command can't flood the agent's context. */
const MAX_OUTPUT = 24_000;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `…(${s.length - MAX_OUTPUT} chars truncated)…\n${s.slice(-MAX_OUTPUT)}`;
}

/**
 * Resolve the container for the active issue, spawning/reviving it as needed.
 * Returns the live container name + the issue identifier, or an error string.
 */
function resolveContainer(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): { containerName: string; identifier: string } | { error: string } {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const session =
    (ctx.agentId ? getActiveSessionByAgentId(ctx.agentId) : null) ??
    getCurrentSession() ??
    null;
  const identifier = session?.issueIdentifier;
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
export function createContainerTools(api: OpenClawPluginApi, rawCtx: Record<string, unknown>): AnyAgentTool[] {
  const ctx = rawCtx as OpenClawPluginToolContext;

  const execTool: AnyAgentTool = {
    name: "container_exec",
    label: "Container: run command",
    description:
      "Run a shell command inside this ticket's dedicated container. Use for building, running tests, " +
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
    execute: async (_id: string, params: { command?: string; workdir?: string; timeoutSec?: number }) => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
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
  } as unknown as AnyAgentTool;

  const writeTool: AnyAgentTool = {
    name: "container_write_file",
    label: "Container: write file",
    description:
      "Create or overwrite a file inside this ticket's container. Parent directories are created. " +
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
    execute: async (_id: string, params: { path?: string; content?: string }) => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
      if (!params.path) return jsonResult({ success: false, error: "path is required" });
      const r = writeFileToContainer(c.containerName, params.path, params.content ?? "");
      return jsonResult({ success: r.exitCode === 0, exitCode: r.exitCode, stderr: clip(r.stderr) });
    },
  } as unknown as AnyAgentTool;

  const readTool: AnyAgentTool = {
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
    execute: async (_id: string, params: { path?: string }) => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
      if (!params.path) return jsonResult({ success: false, error: "path is required" });
      const r = readFileFromContainer(c.containerName, params.path);
      return jsonResult({ success: r.exitCode === 0, content: clip(r.stdout), ...(r.exitCode !== 0 ? { error: clip(r.stderr) } : {}) });
    },
  } as unknown as AnyAgentTool;

  const patchTool: AnyAgentTool = {
    name: "container_apply_patch",
    label: "Container: apply patch",
    description:
      "Apply a unified diff inside a repo in this ticket's container (git apply). Good for multi-hunk edits.",
    promptSnippet: "container_apply_patch — git apply a unified diff in the container",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name (the diff is applied from /work/<repo>)." },
        patch: { type: "string", description: "A unified diff (git apply format)." },
      },
      required: ["repo", "patch"],
    },
    execute: async (_id: string, params: { repo?: string; patch?: string }) => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
      if (!params.repo || !params.patch) return jsonResult({ success: false, error: "repo and patch are required" });
      const tmp = `/tmp/${_id.replace(/[^a-zA-Z0-9]/g, "")}.patch`;
      const w = writeFileToContainer(c.containerName, tmp, params.patch);
      if (w.exitCode !== 0) return jsonResult({ success: false, error: `could not stage patch: ${clip(w.stderr)}` });
      const r = execInContainer(c.containerName, `git apply --whitespace=fix "${tmp}"; rm -f "${tmp}"`, repoWorkdir(params.repo));
      return jsonResult({ success: r.exitCode === 0, exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr) });
    },
  } as unknown as AnyAgentTool;

  const statusTool: AnyAgentTool = {
    name: "container_status",
    label: "Container: git status",
    description: "Show git status (dirty flag + last commit) for each repo cloned in this ticket's container.",
    promptSnippet: "container_status — git status of the container's repos",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
      const rec = getContainerRecord(c.identifier);
      const repos = rec?.repos ?? [];
      const status = repos.map((repo) => {
        try {
          const s = containerGitStatus(c.containerName, repo);
          return { repo, hasChanges: s.hasChanges, lastCommit: s.lastCommit };
        } catch (err) {
          return { repo, error: String(err).slice(0, 200) };
        }
      });
      return jsonResult({ success: true, repos: status });
    },
  } as unknown as AnyAgentTool;

  const cloneTool: AnyAgentTool = {
    name: "container_clone_repo",
    label: "Container: clone another repo",
    description:
      "Clone an ADDITIONAL littledata repo into this ticket's container for cross-repo work. " +
      "The repo must exist in the read-only repos mirror. It lands at /work/<repo>.",
    promptSnippet: "container_clone_repo — add another repo to the container for cross-repo work",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name (directory name in the repos mirror)." },
      },
      required: ["repo"],
    },
    execute: async (_id: string, params: { repo?: string }) => {
      const c = resolveContainer(api, ctx);
      if ("error" in c) return jsonResult({ success: false, error: c.error });
      if (!params.repo) return jsonResult({ success: false, error: "repo is required" });
      const rec = getContainerRecord(c.identifier);
      const branch = rec?.branch ?? "main";
      const r = cloneRepo(c.containerName, params.repo, branch);
      return jsonResult({ success: r.status === 0, exitCode: r.status ?? -1, stderr: clip(r.stderr), path: repoWorkdir(params.repo) });
    },
  } as unknown as AnyAgentTool;

  return [execTool, writeTool, readTool, patchTool, statusTool, cloneTool];
}
