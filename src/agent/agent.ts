import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi, ActivityContent, ActivityEmitOptions } from "../api/linear-api.js";
import { InactivityWatchdog, resolveWatchdogConfig } from "./watchdog.js";
import { bindAgentRunToIssue, unbindAgentRunFromIssue } from "../pipeline/active-session.js";
import {
  bindActiveCodexRun,
  buildLinearCodexSessionKey,
  drainCodexControls,
  isCodexHarnessSteeringEnabled,
  unbindActiveCodexRun,
  type ActiveCodexRunBinding,
} from "./codex-steering.js";

// ---------------------------------------------------------------------------
// Agent directory resolution (config-based, not ext API which ignores agentId)
// ---------------------------------------------------------------------------

interface AgentDirs {
  workspaceDir: string;
  agentDir: string;
}

function resolveAgentDirs(agentId: string, config: Record<string, any>): AgentDirs {
  const home = homedir();
  const agentList = config?.agents?.list as Array<Record<string, any>> | undefined;
  const agentEntry = agentList?.find((a) => a.id === agentId);

  // Workspace: agent-specific override → agents.defaults.workspace → fallback
  const workspaceDir = agentEntry?.workspace
    ?? config?.agents?.defaults?.workspace
    ?? join(home, ".openclaw", "workspace");

  // Agent runtime dir: always ~/.openclaw/agents/{agentId}/agent
  // (matches OpenClaw's internal structure)
  const agentDir = join(home, ".openclaw", "agents", agentId, "agent");
  mkdirSync(agentDir, { recursive: true });

  return { workspaceDir, agentDir };
}

export interface AgentRunResult {
  success: boolean;
  output: string;
  watchdogKilled?: boolean;
}

export interface AgentStreamCallbacks {
  linearApi: LinearAgentApi;
  agentSessionId: string;
}

/** Format structured tool data as readable activity content with a safe size cap. */
export function formatToolActivityValue(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { text = JSON.stringify(JSON.parse(trimmed), null, 2); } catch { text = trimmed; }
    } else {
      text = trimmed;
    }
  } else if (value === undefined) {
    text = "";
  } else {
    try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(${text.length - maxChars} more characters)`;
}

function parseToolActivityObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.details && typeof record.details === "object" && !Array.isArray(record.details)) {
      return record.details as Record<string, unknown>;
    }
    const content = Array.isArray(record.content) ? record.content : [];
    const text = content.find((item) =>
      item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
    );
    if (text) {
      const textValue = (text as Record<string, unknown>).text;
      if (typeof textValue === "string") {
        try {
          const parsed = JSON.parse(textValue);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Fall through to the original result object.
        }
      }
    }
    return record;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Convert an internal tool identifier into its Linear activity title. */
export function formatToolActivityTitle(toolName: string): string {
  if (toolName === "container_exec") return "Shell";
  if (toolName === "container_search_code") return "Search Code";
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ") || "Tool";
}

/** Format tool arguments for the expandable Linear action parameter area. */
export function formatToolActivityParameter(
  toolName: string,
  rawArgs: unknown,
  meta = "",
): string | undefined {
  const args = parseToolActivityObject(rawArgs);
  if (toolName === "container_exec") {
    const command = args?.command;
    if (typeof command === "string") return formatToolActivityValue(command, 4_000) || undefined;
  }
  if (toolName === "container_search_code") {
    const query = args?.query;
    if (typeof query === "string") return formatToolActivityValue(query, 4_000) || undefined;
  }
  return formatToolActivityValue(rawArgs ?? meta, 4_000) || undefined;
}

/** Format a completed tool result for the Linear action output area. */
export function formatToolActivityResult(
  toolName: string,
  rawResult: unknown,
  isError: boolean,
): string {
  if (toolName === "container_exec") {
    const result = parseToolActivityObject(rawResult);
    if (result) {
      const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      const error = typeof result.error === "string" ? result.error.trim() : "";
      const shellOutput = stdout || stderr || error;
      if (shellOutput) {
        const formatted = formatToolActivityValue(shellOutput, 12_000);
        return isError ? `Failed\n\n${formatted}` : formatted;
      }
      if (typeof result.exitCode === "number") {
        return isError ? `Failed\n\nExit code ${result.exitCode}` : `Exit code ${result.exitCode}`;
      }
    }
  }

  const formatted = formatToolActivityValue(rawResult, 12_000) || (isError ? "failed" : "completed");
  return isError ? `Failed\n\n${formatted}` : formatted;
}

/**
 * Run an agent with automatic retry on watchdog kill.
 *
 * Tries embedded runner first (if streaming callbacks provided), falls back
 * to subprocess. If the inactivity watchdog kills the run, retries once.
 */
/**
 * Registry of in-flight embedded runs, keyed by an abort group (typically the
 * Linear issue id). Lets an external caller — e.g. the STOP-signal handler —
 * abort a running worker, which a tmux-only kill cannot reach.
 */
const runsByAbortKey = new Map<string, Set<AbortController>>();

/**
 * Abort every in-flight embedded agent run registered under `abortKey`.
 * @param abortKey - the group the runs were registered under (issue id)
 * @returns the number of runs that were aborted
 */
export function abortRunsFor(abortKey: string): number {
  const set = runsByAbortKey.get(abortKey);
  if (!set) return 0;
  let n = 0;
  for (const controller of set) {
    try { controller.abort(); n++; } catch { /* already settled */ }
  }
  runsByAbortKey.delete(abortKey);
  return n;
}

export async function runAgent(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  message: string;
  timeoutMs?: number;
  streaming?: AgentStreamCallbacks;
  /** Group key (issue id) so an external STOP can abort this run. */
  abortKey?: string;
  /** Issue identifier whose Docker sandbox this embedded run may access. */
  issueIdentifier?: string;
  /**
   * Read-only mode: agent keeps read tools (read, glob, grep, web_search,
   * web_fetch) but all write-capable tools are denied via config policy.
   * Subprocess fallback is blocked — only the embedded runner is safe.
   */
  readOnly?: boolean;
  /** Additional tools to deny (merged with config + readOnly denies) */
  toolsDeny?: string[];
  /**
   * Extra system prompt prepended to the agent's instructions. Used to bind a
   * specialist ROLE (e.g. Spine/Warden) and its skill to this run. Merged with
   * the read-only notice when readOnly is also set. Embedded runner only —
   * ignored on the subprocess fallback (which has no system-prompt injection).
   */
  extraSystemPrompt?: string;
}): Promise<AgentRunResult> {
  const maxAttempts = 2;
  if (params.issueIdentifier) {
    bindAgentRunToIssue(params.sessionId, params.agentId, params.issueIdentifier);
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await runAgentOnce(params);

      if (result.success || !result.watchdogKilled || attempt === maxAttempts - 1) {
        return result;
      }

      params.api.logger.warn(
        `Agent ${params.agentId} killed by watchdog, retrying (attempt ${attempt + 1}/${maxAttempts})`,
      );

      // Emit Linear activity about the retry if streaming
      if (params.streaming) {
        params.streaming.linearApi.emitActivity(params.streaming.agentSessionId, {
          type: "error",
          body: `Agent killed by inactivity watchdog — no I/O for the configured threshold. Retrying...`,
        }).catch(() => {});
      }
    }
  } finally {
    if (params.issueIdentifier) {
      unbindAgentRunFromIssue(params.sessionId, params.agentId);
    }
  }

  // Unreachable, but TypeScript needs it
  return { success: false, output: "Watchdog retry exhausted" };
}

// ---------------------------------------------------------------------------
// Date/time injection — every LLM request gets the current timestamp so models
// don't hallucinate the year (Kimi K2.5 thinks it's 2025).
// ---------------------------------------------------------------------------

function buildDateContext(): string {
  const now = new Date();
  const iso = now.toISOString();
  // Human-readable: "Tuesday, February 18, 2026, 11:42 PM CST"
  const human = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `[Current date/time: ${human} (${iso})]`;
}

/**
 * Single attempt to run an agent (no retry logic).
 */
async function runAgentOnce(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string;
  message: string;
  timeoutMs?: number;
  streaming?: AgentStreamCallbacks;
  readOnly?: boolean;
  toolsDeny?: string[];
  abortKey?: string;
  extraSystemPrompt?: string;
}): Promise<AgentRunResult> {
  const { api, agentId, sessionId, streaming, readOnly, toolsDeny, abortKey, extraSystemPrompt } = params;

  // Inject current timestamp into every LLM request
  const message = `${buildDateContext()}\n\n${params.message}`;

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const wdConfig = resolveWatchdogConfig(agentId, pluginConfig);
  const timeoutMs = params.timeoutMs ?? wdConfig.maxTotalMs;

  api.logger.info(`Dispatching agent ${agentId} for session ${sessionId} (timeout=${Math.round(timeoutMs / 1000)}s, inactivity=${Math.round(wdConfig.inactivityMs / 1000)}s${readOnly ? ", mode=READ_ONLY" : ""})`);

  // Try embedded runner first (has streaming callbacks)
  if (streaming) {
    try {
      return await runEmbedded(api, agentId, sessionId, message, timeoutMs, streaming, wdConfig.inactivityMs, readOnly, toolsDeny, abortKey, extraSystemPrompt);
    } catch (err) {
      // Read-only mode MUST NOT fall back to subprocess — subprocess runs a
      // full agent with no way to enforce the tool deny policy.
      // The opt-in Codex harness also fails closed: a subprocess fallback would
      // silently lose the stable session binding and all steering guarantees.
      if (readOnly || isCodexHarnessSteeringEnabled(pluginConfig)) {
        const mode = readOnly ? "read-only" : "Codex harness";
        api.logger.error(`Embedded runner failed in ${mode} mode, refusing subprocess fallback: ${err}`);
        return {
          success: false,
          output: readOnly
            ? "Read-only agent run failed (embedded runner unavailable)."
            : `Codex harness agent run failed: ${String(err)}`,
        };
      }
      api.logger.warn(`Embedded runner failed, falling back to subprocess: ${err}`);
    }
  }

  // Fallback: subprocess (no streaming)
  if (readOnly) {
    api.logger.error("Cannot run read-only agent via subprocess — no tool policy enforcement");
    return { success: false, output: "Read-only agent run requires the embedded runner." };
  }
  return runSubprocess(api, agentId, sessionId, message, timeoutMs);
}

/**
 * Embedded agent runner with real-time streaming to Linear and inactivity watchdog.
 */
// Tools denied in read-only mode.  Uses OpenClaw group:* shorthands where
// possible (see https://docs.openclaw.ai/tools).  Covers every built-in
// tool that can mutate the filesystem, execute commands, or produce
// side-effects beyond the Linear API calls the plugin makes after the run.
//
// NOT denied (read-only tools the triage agent keeps):
//   read, glob, grep/search          — codebase inspection
//   group:web (web_search, web_fetch) — external context
//   group:memory (memory_search/get)  — knowledge retrieval
//   sessions_list, sessions_history   — read-only introspection
export const READ_ONLY_DENY: string[] = [
  // group:fs = read + write + edit + apply_patch — but we need read,
  // so deny the write-capable members individually.
  "write", "edit", "apply_patch",
  // Full groups that are entirely write/side-effect oriented:
  "group:runtime",                          // exec, bash, process
  "group:messaging",                        // message
  "group:ui",                               // browser, canvas
  "group:automation",                       // cron, gateway
  "group:nodes",                            // nodes
  // Individual tools not covered by a group:
  "sessions_spawn", "sessions_send",        // agent orchestration
  "tts",                                    // audio file generation
  "image",                                  // image file generation
];

async function runEmbedded(
  api: OpenClawPluginApi,
  agentId: string,
  sessionId: string,
  message: string,
  timeoutMs: number,
  streaming: AgentStreamCallbacks,
  inactivityMs: number,
  readOnly?: boolean,
  toolsDeny?: string[],
  abortKey?: string,
  extraSystemPrompt?: string,
): Promise<AgentRunResult> {
  // Load config so we can resolve agent dirs and providers correctly.
  const origConfig = await api.runtime.config.loadConfig();
  let config = origConfig;
  let configAny = config as Record<string, any>;

  // ── Read-only enforcement ──────────────────────────────────────────
  // Clone the config and inject a tools.deny policy that strips every
  // write-capable tool.  The deny list is merged with any existing deny
  // entries so we don't clobber operator-level restrictions.
  if (readOnly) {
    configAny = JSON.parse(JSON.stringify(configAny));
    config = configAny as typeof config;
    if (!configAny.tools) configAny.tools = {};
    const existing: string[] = Array.isArray(configAny.tools.deny) ? configAny.tools.deny : [];
    configAny.tools.deny = [...new Set([...existing, ...READ_ONLY_DENY])];
    api.logger.info(`Read-only mode: tools.deny = [${configAny.tools.deny.join(", ")}]`);
  }

  // ── Additional toolsDeny entries ─────────────────────────────────────
  if (toolsDeny?.length) {
    if (config === origConfig) {
      configAny = JSON.parse(JSON.stringify(origConfig));
      config = configAny as typeof config;
    }
    if (!configAny.tools) configAny.tools = {};
    const existing: string[] = Array.isArray(configAny.tools.deny) ? configAny.tools.deny : [];
    configAny.tools.deny = [...new Set([...existing, ...toolsDeny])];
  }

  // Resolve workspace and agent dirs from config (ext API ignores agentId).
  const dirs = resolveAgentDirs(agentId, configAny);
  const { workspaceDir, agentDir } = dirs;
  const runId = randomUUID();

  // Build session file path under the correct agent's sessions directory.
  const sessionsDir = join(agentDir, "sessions");
  try { mkdirSync(sessionsDir, { recursive: true }); } catch {}
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);

  // Resolve model/provider from config — default is anthropic which requires
  // a separate API key. Our agents use openrouter.
  const agentList = configAny?.agents?.list as Array<Record<string, any>> | undefined;
  const agentEntry = agentList?.find((a) => a.id === agentId);
  const modelRef: string =
    agentEntry?.model?.primary ??
    configAny?.agents?.defaults?.model?.primary ??
    `${api.runtime.agent.defaults.provider}/${api.runtime.agent.defaults.model}`;

  // Parse "provider/model-id" format (e.g. "openrouter/moonshotai/kimi-k2.5")
  const slashIdx = modelRef.indexOf("/");
  let provider = slashIdx > 0 ? modelRef.slice(0, slashIdx) : api.runtime.agent.defaults.provider;
  let model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;

  // The Codex app-server harness is deliberately opt-in. It is separate from
  // workerBackend="codex" (the existing codex exec/container backend) because
  // enabling it changes which runtime owns embedded agent turns.
  const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  const codexHarnessEnabled = isCodexHarnessSteeringEnabled(pluginConfig);
  const configuredCodexModel = pluginConfig?.codexHarnessModel;
  if (codexHarnessEnabled && typeof configuredCodexModel === "string" && configuredCodexModel.trim()) {
    const normalized = configuredCodexModel.trim();
    const separator = normalized.indexOf("/");
    if (separator <= 0 || separator === normalized.length - 1) {
      throw new Error("codexHarnessModel must use provider/model format (for example openai/<codex-compatible-model>)");
    }
    provider = normalized.slice(0, separator);
    model = normalized.slice(separator + 1);
  }

  api.logger.info(`Embedded agent run: agent=${agentId} session=${sessionId} runId=${runId} provider=${provider} model=${model} workspaceDir=${workspaceDir} agentDir=${agentDir}`);

  // Serialize writes so an ephemeral start cannot race its completed card.
  let activityQueue: Promise<void> = Promise.resolve();
  const emit = (content: ActivityContent, opts?: ActivityEmitOptions) => {
    activityQueue = activityQueue
      .then(() => streaming.linearApi.emitActivity(streaming.agentSessionId, content, opts))
      .catch((err) => {
        api.logger.warn(`Activity emit failed: ${err}`);
      });
  };

  // --- Inactivity watchdog ---
  const controller = new AbortController();
  // Register so an external STOP (Linear stop signal) can abort this run.
  if (abortKey) {
    let set = runsByAbortKey.get(abortKey);
    if (!set) { set = new Set(); runsByAbortKey.set(abortKey, set); }
    set.add(controller);
  }
  const watchdog = new InactivityWatchdog({
    inactivityMs,
    label: `embedded:${agentId}:${sessionId}`,
    logger: api.logger,
    onKill: () => {
      // The AbortController wired to runEmbeddedPiAgent below is the
      // canonical way to stop an in-flight embedded run; no extra
      // host-side abort call is needed.
      controller.abort();
    },
  });

  const pendingTools = new Map<string, { name: string; parameter?: string }>();
  const completedResults = new Map<string, Array<{ result: unknown; isError: boolean }>>();

  watchdog.start();

  // Compose the extra system prompt: the specialist ROLE brief (if any) plus
  // the read-only notice (if readOnly). Either, both, or neither may apply.
  const readOnlyNotice = [
    "READ-ONLY MODE: You may read and search files but you MUST NOT",
    "write, edit, create, or delete any files. Do not use host bash/exec.",
    "Repository shell commands are allowed only through the container_* tools",
    "provided for this ticket's Docker sandbox.",
    "Your only output is your text response.",
  ].join(" ");
  const progressThoughtsEnabled = pluginConfig?.linearProgressThoughts !== false;
  const progressNotice = progressThoughtsEnabled
    ? [
        "LINEAR PROGRESS VISIBILITY: Before the first tool batch and whenever your investigation",
        "changes direction, write one brief commentary update explaining what you are checking,",
        "the relevant finding so far, and what comes next. Keep it to one or two sentences.",
        "Do not reveal private chain-of-thought and do not narrate every individual tool call.",
      ].join(" ")
    : undefined;
  const composedSystemPrompt = [extraSystemPrompt, readOnly ? readOnlyNotice : undefined, progressNotice]
    .filter(Boolean)
    .join("\n\n");

  let pendingAssistantCommentary = "";
  let lastEmittedCommentary = "";
  const flushAssistantCommentary = () => {
    const text = pendingAssistantCommentary.trim();
    pendingAssistantCommentary = "";
    if (!progressThoughtsEnabled || text.length <= 10 || text === lastEmittedCommentary) return;
    lastEmittedCommentary = text;
    emit({ type: "thought", body: formatToolActivityValue(text, 1_200) });
  };

  let codexBinding: ActiveCodexRunBinding | undefined;
  const linearSessionId = streaming.agentSessionId;
  const codexSessionKey = buildLinearCodexSessionKey(agentId, linearSessionId);
  if (codexHarnessEnabled && abortKey) {
    const sessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      chatType: "direct" as const,
      agentRuntimeOverride: "codex",
      providerOverride: provider,
      modelOverride: model,
    };
    const sessionRuntime = api.runtime.agent.session;
    const existingEntry = sessionRuntime?.getSessionEntry?.({
      agentId,
      sessionKey: codexSessionKey,
    });
    if (existingEntry && sessionRuntime?.patchSessionEntry) {
      await sessionRuntime.patchSessionEntry({
        agentId,
        sessionKey: codexSessionKey,
        fallbackEntry: sessionEntry,
        preserveActivity: true,
        update: () => sessionEntry,
      });
    } else {
      await sessionRuntime?.upsertSessionEntry?.({
        agentId,
        sessionKey: codexSessionKey,
        entry: sessionEntry,
      });
    }
    codexBinding = bindActiveCodexRun({
      issueId: abortKey,
      linearSessionId,
      agentId,
      openClawSessionId: sessionId,
      sessionKey: codexSessionKey,
      runId,
    });
  }

  let result: Awaited<ReturnType<typeof api.runtime.agent.runEmbeddedPiAgent>>;
  try {
    result = await api.runtime.agent.runEmbeddedPiAgent({
      sessionId,
      ...(codexHarnessEnabled ? {
        sessionKey: codexSessionKey,
        agentHarnessRuntimeOverride: "codex",
        messageChannel: "linear",
        messageProvider: "linear",
        chatType: "direct" as const,
      } : {}),
      sessionFile,
      workspaceDir,
      agentDir,
      prompt: message,
      agentId,
      runId,
      timeoutMs,
      config,
      provider,
      model,
      abortSignal: controller.signal,
      // Project the structured lifecycle below. OpenClaw's aggregate summaries
      // would otherwise create extra, uncorrelated Linear rows.
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      ...(composedSystemPrompt ? { extraSystemPrompt: composedSystemPrompt } : {}),

      // Stream the model's REASONING SUMMARY to Linear as chain-of-thought.
      // These are the provider's reasoning-summary blocks (not raw hidden CoT),
      // surfaced so developers can follow and intervene. Requires the codex config
      // to emit them (model_reasoning_summary != "none").
      onReasoningStream: (payload) => {
        watchdog.tick();
        const text = payload.text?.trim();
        if (text && text.length > 10) {
          emit({ type: "thought", body: formatToolActivityValue(text, 4_000) });
        }
      },

      // OpenClaw supplies the actual result immediately before the matching
      // `phase=result` event. The latter carries the toolCallId needed to pair it.
      onAgentToolResult: ({ toolName, result, isError }) => {
        watchdog.tick();
        const queued = completedResults.get(toolName) ?? [];
        queued.push({ result, isError });
        completedResults.set(toolName, queued);
      },

      // Raw agent events — capture tool starts/ends/updates
      onAgentEvent: (evt) => {
        watchdog.tick();
        const { stream, data } = evt;

        if (stream !== "tool") return;

        const phase = String(data.phase ?? "");
        const toolName = String(data.name ?? "tool");
        const toolCallId = String(data.toolCallId ?? "");
        const meta = typeof data.meta === "string" ? data.meta : "";
        const rawArgs = data.args ?? data.input;

        // Transient live card. The persistent completion carries args + result.
        if (phase === "start") {
          // Visible assistant commentary followed by a tool call is a progress
          // update, not the terminal answer. Emit it before the tool card.
          flushAssistantCommentary();
          const action = formatToolActivityTitle(toolName);
          const parameter = formatToolActivityParameter(toolName, rawArgs, meta);
          if (toolCallId) pendingTools.set(toolCallId, { name: action, parameter });
          emit({ type: "action", action, parameter }, { ephemeral: true });
        }

        if (phase === "result") {
          const pending = toolCallId ? pendingTools.get(toolCallId) : undefined;
          const queued = completedResults.get(toolName) ?? [];
          const completed = queued.shift();
          if (queued.length) completedResults.set(toolName, queued);
          else completedResults.delete(toolName);
          if (toolCallId) pendingTools.delete(toolCallId);

          const isError = completed?.isError ?? Boolean(data.isError);
          const rawResult = completed?.result ?? data.result ?? meta ?? (isError ? "failed" : "completed");
          emit({
            type: "action",
            action: pending?.name ?? formatToolActivityTitle(toolName),
            parameter: pending?.parameter,
            result: formatToolActivityResult(toolName, rawResult, isError),
          });
        }
      },

      // Partial assistant text (for long responses)
      onPartialReply: (payload) => {
        watchdog.tick();
        // Buffer visible assistant commentary. It becomes a Linear thought only
        // if another tool starts afterward; terminal answer text is therefore
        // left to the caller's response activity and is never duplicated here.
        const text = payload.text?.trim() ?? "";
        if (!text) return;
        if (payload.replace) pendingAssistantCommentary = text;
        else if (typeof payload.delta === "string") pendingAssistantCommentary += payload.delta;
        else pendingAssistantCommentary = text;
      },

      // Native Codex request_user_input is projected as an elicitation. The
      // next /steer message is consumed by OpenClaw's pending-input bridge as
      // the answer instead of being sent to turn/steer.
      onBlockReply: (payload) => {
        watchdog.tick();
        const text = payload.text?.trim();
        if (text && /^(?:agent|codex) needs input:/i.test(text)) {
          watchdog.pause();
          emit({ type: "elicitation", body: text });
        }
      },
    });

  } finally {
    await activityQueue;
    if (codexBinding) await drainCodexControls(codexBinding);
    watchdog.stop();
    if (codexBinding) unbindActiveCodexRun(codexBinding.issueId, runId);
    if (abortKey) {
      const set = runsByAbortKey.get(abortKey);
      if (set) { set.delete(controller); if (set.size === 0) runsByAbortKey.delete(abortKey); }
    }
  }

  // Extract output text from payloads
  const payloads = result.payloads ?? [];
  const outputText = payloads
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n");

  // Check if watchdog killed the run
  if (watchdog.wasKilled) {
    const silenceSec = Math.round(watchdog.silenceMs / 1000);
    api.logger.warn(`Embedded agent killed by watchdog: agent=${agentId} session=${sessionId} silence=${silenceSec}s`);
    return {
      success: false,
      output: outputText || `Agent killed by inactivity watchdog after ${silenceSec}s of silence.`,
      watchdogKilled: true,
    };
  }

  if (result.meta?.error) {
    api.logger.error(`Embedded agent error: ${result.meta.error.kind}: ${result.meta.error.message}`);
    return { success: false, output: outputText || result.meta.error.message };
  }

  api.logger.info(`Embedded agent completed: agent=${agentId} session=${sessionId} duration=${result.meta.durationMs}ms`);
  return { success: true, output: outputText || "(no output)" };
}

/**
 * Subprocess fallback (no streaming, used when no Linear session context).
 */
async function runSubprocess(
  api: OpenClawPluginApi,
  agentId: string,
  sessionId: string,
  message: string,
  timeoutMs: number,
): Promise<AgentRunResult> {
  const command = [
    "openclaw",
    "agent",
    "--agent",
    agentId,
    "--session-id",
    sessionId,
    "--message",
    message,
    "--timeout",
    String(Math.floor(timeoutMs / 1000)),
    "--json",
  ];

  const result = await api.runtime.system.runCommandWithTimeout(command, { timeoutMs });

  if (result.code !== 0) {
    const error = result.stderr || result.stdout || "no output";
    api.logger.error(`Agent ${agentId} failed (${result.code}): ${error}`);
    return { success: false, output: error };
  }

  const raw = result.stdout || "";
  api.logger.info(`Agent ${agentId} completed for session ${sessionId}`);

  // Extract clean text from --json output.
  // The subprocess stdout may contain plugin init log lines before the JSON blob.
  // Strip everything before the first `{` to isolate the JSON envelope.
  const extracted = extractJsonFromOutput(raw);
  if (extracted) return { success: true, output: extracted };

  return { success: true, output: raw };
}

/**
 * Extract text from subprocess --json output. Handles:
 * - Log noise before the JSON blob (plugin init lines)
 * - Both envelope shapes: `{ payloads }` (flat) and `{ result: { payloads } }` (nested)
 */
function extractJsonFromOutput(raw: string): string | null {
  // The subprocess stdout may contain plugin init log lines before the JSON
  // result blob. Try parsing the whole thing first; if that fails, scan lines
  // backwards for a `{` that starts a valid JSON envelope with payloads.
  const candidates: string[] = [raw];

  // Also try from each line that starts with `{` (the JSON blob typically
  // starts on its own line after log noise).
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("{")) {
      candidates.push(lines.slice(i).join("\n"));
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      // Try both envelope shapes: flat `{ payloads }` and nested `{ result: { payloads } }`
      const payloads = parsed?.payloads ?? parsed?.result?.payloads;
      if (Array.isArray(payloads) && payloads.length > 0) {
        const text = payloads.map((p: any) => p.text).filter(Boolean).join("\n\n");
        if (text) return text;
      }
    } catch {
      // Not valid JSON at this position — try next candidate
    }
  }
  return null;
}
