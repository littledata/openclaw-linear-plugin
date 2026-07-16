/**
 * Relays a spawned specialist's visible activity into the parent Linear
 * AgentSession. Spawned OpenClaw sessions do not inherit the parent's embedded
 * streaming callbacks, so their tool cards and assistant messages need a
 * gateway-level bridge keyed by the child session/run identifiers.
 */
import { formatToolActivityParameter, formatToolActivityResult, formatToolActivityTitle, } from "../agent/agent.js";
const MESSAGE_DEDUPE_MS = 5 * 60_000;
const MAX_DEDUPE_ENTRIES = 500;
const MAX_COMPLETED_TOOL_IDS = 1_000;
/** Extract only user-visible assistant text; thinking/reasoning blocks are excluded. */
export function extractVisibleAssistantText(message) {
    if (!message || typeof message !== "object")
        return [];
    const record = message;
    if (record.role !== "assistant")
        return [];
    if (typeof record.content === "string") {
        const text = record.content.trim();
        return text ? [text] : [];
    }
    if (!Array.isArray(record.content))
        return [];
    return record.content
        .filter((block) => !!block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string")
        .map((block) => String(block.text).trim())
        .filter(Boolean);
}
/**
 * Gateway-level relay for child tool calls and visible assistant messages.
 * Every method is best-effort: Linear telemetry must never block coding work.
 */
export class SubagentActivityRelay {
    linearApi;
    logger;
    bindings = new Map();
    pendingTools = new Map();
    completedToolIds = new Set();
    messageFingerprints = new Map();
    /**
     * @param linearApi - Linear activity API
     * @param logger - best-effort diagnostic logger
     */
    constructor(linearApi, logger) {
        this.linearApi = linearApi;
        this.logger = logger;
    }
    /** Bind every known child identity (session key, session id, run id). */
    bind(keys, binding) {
        for (const key of keys) {
            if (key)
                this.bindings.set(key, binding);
        }
    }
    /** Drop child identities and any pending tool records associated with them. */
    unbind(keys) {
        const bindings = new Set(keys.map((key) => (key ? this.bindings.get(key) : undefined)).filter(Boolean));
        for (const key of keys) {
            if (key)
                this.bindings.delete(key);
        }
        if (!bindings.size)
            return;
        for (const [key, pending] of this.pendingTools) {
            if (bindings.has(pending.binding))
                this.pendingTools.delete(key);
        }
    }
    /** Emit the transient start card for a mapped child tool call. */
    async toolStarted(event, ctx) {
        const binding = this.resolveBinding(event, ctx);
        if (!binding || !this.linearApi)
            return;
        const action = formatToolActivityTitle(event.toolName);
        const parameter = this.withSpecialist(binding, formatToolActivityParameter(event.toolName, event.params));
        const key = this.toolKey(event, ctx);
        if (key) {
            this.pendingTools.set(key, { binding, toolName: event.toolName, action, parameter });
        }
        await this.emit(binding.agentSessionId, { type: "action", action, parameter }, { ephemeral: true });
    }
    /** Emit the persistent completion card for a mapped child tool call. */
    async toolFinished(event, ctx) {
        const binding = this.resolveBinding(event, ctx);
        if (!binding || !this.linearApi)
            return;
        const key = this.toolKey(event, ctx);
        if (key && this.completedToolIds.has(key))
            return;
        const pending = key ? this.pendingTools.get(key) : undefined;
        if (key) {
            this.pendingTools.delete(key);
            this.rememberCompletedTool(key);
        }
        const isError = typeof event.error === "string" && event.error.length > 0;
        await this.emit(binding.agentSessionId, {
            type: "action",
            action: pending?.action ?? formatToolActivityTitle(event.toolName),
            parameter: pending?.parameter ??
                this.withSpecialist(binding, formatToolActivityParameter(event.toolName, event.params)),
            result: formatToolActivityResult(pending?.toolName ?? event.toolName, event.result ?? event.error ?? (isError ? "failed" : "completed"), isError),
        });
    }
    /** Relay visible child assistant prose as a specialist-labelled thought. */
    async assistantText(text, identities) {
        const binding = this.resolveBindingFromKeys(identities);
        const body = text.trim();
        if (!binding || !this.linearApi || !body)
            return;
        const fingerprint = `${binding.agentSessionId}:${binding.agentId}:${body}`;
        const now = Date.now();
        const seenAt = this.messageFingerprints.get(fingerprint);
        if (seenAt && now - seenAt < MESSAGE_DEDUPE_MS)
            return;
        this.messageFingerprints.set(fingerprint, now);
        this.trimMessageFingerprints(now);
        await this.emit(binding.agentSessionId, {
            type: "thought",
            body: `${binding.agentLabel} — ${body}`,
        });
    }
    /** Relay visible text blocks from a persisted child assistant message. */
    async assistantMessage(message, identities) {
        for (const text of extractVisibleAssistantText(message)) {
            await this.assistantText(text, identities);
        }
    }
    resolveBinding(event, ctx) {
        return this.resolveBindingFromKeys([
            ctx.sessionKey,
            ctx.sessionId,
            ctx.runId,
            event.runId,
        ]);
    }
    resolveBindingFromKeys(keys) {
        for (const key of keys) {
            const binding = key ? this.bindings.get(key) : undefined;
            if (binding)
                return binding;
        }
        return undefined;
    }
    toolKey(event, ctx) {
        const callId = event.toolCallId;
        if (!callId)
            return undefined;
        const owner = ctx.sessionKey ?? ctx.sessionId ?? ctx.runId ?? event.runId ?? "child";
        return `${owner}:${callId}`;
    }
    withSpecialist(binding, parameter) {
        return parameter
            ? `Specialist: ${binding.agentLabel}\n\n${parameter}`
            : `Specialist: ${binding.agentLabel}`;
    }
    rememberCompletedTool(key) {
        this.completedToolIds.add(key);
        if (this.completedToolIds.size <= MAX_COMPLETED_TOOL_IDS)
            return;
        const oldest = this.completedToolIds.values().next().value;
        if (oldest)
            this.completedToolIds.delete(oldest);
    }
    trimMessageFingerprints(now) {
        for (const [key, seenAt] of this.messageFingerprints) {
            if (now - seenAt >= MESSAGE_DEDUPE_MS)
                this.messageFingerprints.delete(key);
        }
        while (this.messageFingerprints.size > MAX_DEDUPE_ENTRIES) {
            const oldest = this.messageFingerprints.keys().next().value;
            if (!oldest)
                break;
            this.messageFingerprints.delete(oldest);
        }
    }
    async emit(agentSessionId, content, opts) {
        try {
            await this.linearApi?.emitActivity(agentSessionId, content, opts);
        }
        catch (error) {
            this.logger?.warn(`[subagent-activity] could not emit Linear activity: ${error}`);
        }
    }
}
