import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { InactivityWatchdog, resolveWatchdogConfig } from "./watchdog.js";
import { bindAgentRunToIssue, unbindAgentRunFromIssue } from "../pipeline/active-session.js";
import { bindActiveCodexRun, buildLinearCodexSessionKey, drainCodexControls, isCodexHarnessSteeringEnabled, unbindActiveCodexRun, } from "./codex-steering.js";
function resolveAgentDirs(agentId, config) {
    const home = homedir();
    const agentList = config?.agents?.list;
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
/** Format structured tool data as readable activity content with a safe size cap. */
export function formatToolActivityValue(value, maxChars) {
    let text;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                text = JSON.stringify(JSON.parse(trimmed), null, 2);
            }
            catch {
                text = trimmed;
            }
        }
        else {
            text = trimmed;
        }
    }
    else if (value === undefined) {
        text = "";
    }
    else {
        try {
            text = JSON.stringify(value, null, 2);
        }
        catch {
            text = String(value);
        }
    }
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}\n…(${text.length - maxChars} more characters)`;
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
const runsByAbortKey = new Map();
/**
 * Abort every in-flight embedded agent run registered under `abortKey`.
 * @param abortKey - the group the runs were registered under (issue id)
 * @returns the number of runs that were aborted
 */
export function abortRunsFor(abortKey) {
    const set = runsByAbortKey.get(abortKey);
    if (!set)
        return 0;
    let n = 0;
    for (const controller of set) {
        try {
            controller.abort();
            n++;
        }
        catch { /* already settled */ }
    }
    runsByAbortKey.delete(abortKey);
    return n;
}
export async function runAgent(params) {
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
            params.api.logger.warn(`Agent ${params.agentId} killed by watchdog, retrying (attempt ${attempt + 1}/${maxAttempts})`);
            // Emit Linear activity about the retry if streaming
            if (params.streaming) {
                params.streaming.linearApi.emitActivity(params.streaming.agentSessionId, {
                    type: "error",
                    body: `Agent killed by inactivity watchdog — no I/O for the configured threshold. Retrying...`,
                }).catch(() => { });
            }
        }
    }
    finally {
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
function buildDateContext() {
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
async function runAgentOnce(params) {
    const { api, agentId, sessionId, streaming, readOnly, toolsDeny, abortKey, extraSystemPrompt } = params;
    // Inject current timestamp into every LLM request
    const message = `${buildDateContext()}\n\n${params.message}`;
    const pluginConfig = api.pluginConfig;
    const wdConfig = resolveWatchdogConfig(agentId, pluginConfig);
    const timeoutMs = params.timeoutMs ?? wdConfig.maxTotalMs;
    api.logger.info(`Dispatching agent ${agentId} for session ${sessionId} (timeout=${Math.round(timeoutMs / 1000)}s, inactivity=${Math.round(wdConfig.inactivityMs / 1000)}s${readOnly ? ", mode=READ_ONLY" : ""})`);
    // Try embedded runner first (has streaming callbacks)
    if (streaming) {
        try {
            return await runEmbedded(api, agentId, sessionId, message, timeoutMs, streaming, wdConfig.inactivityMs, readOnly, toolsDeny, abortKey, extraSystemPrompt);
        }
        catch (err) {
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
export const READ_ONLY_DENY = [
    // group:fs = read + write + edit + apply_patch — but we need read,
    // so deny the write-capable members individually.
    "write", "edit", "apply_patch",
    // Full groups that are entirely write/side-effect oriented:
    "group:runtime", // exec, bash, process
    "group:messaging", // message
    "group:ui", // browser, canvas
    "group:automation", // cron, gateway
    "group:nodes", // nodes
    // Individual tools not covered by a group:
    "sessions_spawn", "sessions_send", // agent orchestration
    "tts", // audio file generation
    "image", // image file generation
];
async function runEmbedded(api, agentId, sessionId, message, timeoutMs, streaming, inactivityMs, readOnly, toolsDeny, abortKey, extraSystemPrompt) {
    // Load config so we can resolve agent dirs and providers correctly.
    const origConfig = await api.runtime.config.loadConfig();
    let config = origConfig;
    let configAny = config;
    // ── Read-only enforcement ──────────────────────────────────────────
    // Clone the config and inject a tools.deny policy that strips every
    // write-capable tool.  The deny list is merged with any existing deny
    // entries so we don't clobber operator-level restrictions.
    if (readOnly) {
        configAny = JSON.parse(JSON.stringify(configAny));
        config = configAny;
        if (!configAny.tools)
            configAny.tools = {};
        const existing = Array.isArray(configAny.tools.deny) ? configAny.tools.deny : [];
        configAny.tools.deny = [...new Set([...existing, ...READ_ONLY_DENY])];
        api.logger.info(`Read-only mode: tools.deny = [${configAny.tools.deny.join(", ")}]`);
    }
    // ── Additional toolsDeny entries ─────────────────────────────────────
    if (toolsDeny?.length) {
        if (config === origConfig) {
            configAny = JSON.parse(JSON.stringify(origConfig));
            config = configAny;
        }
        if (!configAny.tools)
            configAny.tools = {};
        const existing = Array.isArray(configAny.tools.deny) ? configAny.tools.deny : [];
        configAny.tools.deny = [...new Set([...existing, ...toolsDeny])];
    }
    // Resolve workspace and agent dirs from config (ext API ignores agentId).
    const dirs = resolveAgentDirs(agentId, configAny);
    const { workspaceDir, agentDir } = dirs;
    const runId = randomUUID();
    // Build session file path under the correct agent's sessions directory.
    const sessionsDir = join(agentDir, "sessions");
    try {
        mkdirSync(sessionsDir, { recursive: true });
    }
    catch { }
    const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
    // Resolve model/provider from config — default is anthropic which requires
    // a separate API key. Our agents use openrouter.
    const agentList = configAny?.agents?.list;
    const agentEntry = agentList?.find((a) => a.id === agentId);
    const modelRef = agentEntry?.model?.primary ??
        configAny?.agents?.defaults?.model?.primary ??
        `${api.runtime.agent.defaults.provider}/${api.runtime.agent.defaults.model}`;
    // Parse "provider/model-id" format (e.g. "openrouter/moonshotai/kimi-k2.5")
    const slashIdx = modelRef.indexOf("/");
    let provider = slashIdx > 0 ? modelRef.slice(0, slashIdx) : api.runtime.agent.defaults.provider;
    let model = slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
    // The Codex app-server harness is deliberately opt-in. It is separate from
    // workerBackend="codex" (the existing codex exec/container backend) because
    // enabling it changes which runtime owns embedded agent turns.
    const pluginConfig = api.pluginConfig;
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
    let activityQueue = Promise.resolve();
    const emit = (content, opts) => {
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
        if (!set) {
            set = new Set();
            runsByAbortKey.set(abortKey, set);
        }
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
    const pendingTools = new Map();
    const completedResults = new Map();
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
    const composedSystemPrompt = [extraSystemPrompt, readOnly ? readOnlyNotice : undefined]
        .filter(Boolean)
        .join("\n\n");
    let codexBinding;
    const linearSessionId = streaming.agentSessionId;
    const codexSessionKey = buildLinearCodexSessionKey(agentId, linearSessionId);
    if (codexHarnessEnabled && abortKey) {
        const sessionEntry = {
            sessionId,
            updatedAt: Date.now(),
            sessionFile,
            chatType: "direct",
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
        }
        else {
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
    let result;
    try {
        result = await api.runtime.agent.runEmbeddedPiAgent({
            sessionId,
            ...(codexHarnessEnabled ? {
                sessionKey: codexSessionKey,
                agentHarnessRuntimeOverride: "codex",
                messageChannel: "linear",
                messageProvider: "linear",
                chatType: "direct",
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
            // Stream reasoning/thinking to Linear
            onReasoningStream: (payload) => {
                watchdog.tick();
                const text = payload.text?.trim();
                if (text && text.length > 10) {
                    emit({ type: "thought", body: text.slice(0, 500) });
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
                if (stream !== "tool")
                    return;
                const phase = String(data.phase ?? "");
                const toolName = String(data.name ?? "tool");
                const toolCallId = String(data.toolCallId ?? "");
                const meta = typeof data.meta === "string" ? data.meta : "";
                const rawArgs = data.args ?? data.input;
                // Transient live card. The persistent completion carries args + result.
                if (phase === "start") {
                    const parameter = formatToolActivityValue(rawArgs ?? meta, 4_000) || undefined;
                    if (toolCallId)
                        pendingTools.set(toolCallId, { name: toolName, parameter });
                    emit({ type: "action", action: toolName, parameter }, { ephemeral: true });
                }
                if (phase === "result") {
                    const pending = toolCallId ? pendingTools.get(toolCallId) : undefined;
                    const queued = completedResults.get(toolName) ?? [];
                    const completed = queued.shift();
                    if (queued.length)
                        completedResults.set(toolName, queued);
                    else
                        completedResults.delete(toolName);
                    if (toolCallId)
                        pendingTools.delete(toolCallId);
                    const isError = completed?.isError ?? Boolean(data.isError);
                    const rawResult = completed?.result ?? data.result ?? meta ?? (isError ? "failed" : "completed");
                    const formattedResult = formatToolActivityValue(rawResult, 12_000) || (isError ? "failed" : "completed");
                    emit({
                        type: "action",
                        action: pending?.name ?? toolName,
                        parameter: pending?.parameter,
                        result: isError ? `Failed\n\n${formattedResult}` : formattedResult,
                    });
                }
            },
            // Partial assistant text (for long responses)
            onPartialReply: (_payload) => {
                watchdog.tick();
                // We don't emit every partial chunk to avoid flooding Linear.
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
    }
    finally {
        await activityQueue;
        if (codexBinding)
            await drainCodexControls(codexBinding);
        watchdog.stop();
        if (codexBinding)
            unbindActiveCodexRun(codexBinding.issueId, runId);
        if (abortKey) {
            const set = runsByAbortKey.get(abortKey);
            if (set) {
                set.delete(controller);
                if (set.size === 0)
                    runsByAbortKey.delete(abortKey);
            }
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
async function runSubprocess(api, agentId, sessionId, message, timeoutMs) {
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
    if (extracted)
        return { success: true, output: extracted };
    return { success: true, output: raw };
}
/**
 * Extract text from subprocess --json output. Handles:
 * - Log noise before the JSON blob (plugin init lines)
 * - Both envelope shapes: `{ payloads }` (flat) and `{ result: { payloads } }` (nested)
 */
function extractJsonFromOutput(raw) {
    // The subprocess stdout may contain plugin init log lines before the JSON
    // result blob. Try parsing the whole thing first; if that fails, scan lines
    // backwards for a `{` that starts a valid JSON envelope with payloads.
    const candidates = [raw];
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
                const text = payloads.map((p) => p.text).filter(Boolean).join("\n\n");
                if (text)
                    return text;
            }
        }
        catch {
            // Not valid JSON at this position — try next candidate
        }
    }
    return null;
}
