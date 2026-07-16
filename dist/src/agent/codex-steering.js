const activeByIssue = new Map();
/** Return whether the opt-in Codex harness steering integration is enabled. */
export function isCodexHarnessSteeringEnabled(config) {
    return config?.enableCodexHarnessSteering === true;
}
/** Build the stable OpenClaw session key shared by a Linear AgentSession's turns. */
export function buildLinearCodexSessionKey(agentId, linearSessionId) {
    return `agent:${agentId}:linear:direct:${linearSessionId}`;
}
/** Register an active Codex harness run so Linear prompts can target it. */
export function bindActiveCodexRun(binding) {
    const active = { ...binding, pendingControls: new Set() };
    activeByIssue.set(binding.issueId, active);
    return active;
}
/** Return the active binding for an issue, optionally fenced to a Linear session. */
export function getActiveCodexRun(issueId, linearSessionId) {
    const binding = activeByIssue.get(issueId);
    if (!binding)
        return null;
    if (linearSessionId && binding.linearSessionId !== linearSessionId)
        return null;
    return binding;
}
/** Remove a binding only when the completing run still owns it. */
export function unbindActiveCodexRun(issueId, runId) {
    if (activeByIssue.get(issueId)?.runId === runId)
        activeByIssue.delete(issueId);
}
/** Wait for steer commands that fell back to a deferred normal turn. */
export async function drainCodexControls(binding) {
    while (binding.pendingControls.size) {
        await Promise.allSettled([...binding.pendingControls]);
    }
}
function shouldSuppressControlReply(text) {
    const normalized = text.trim().toLowerCase();
    return normalized === "steered current session." ||
        normalized.includes("codex stop requested") ||
        normalized.includes("codex turn interrupted");
}
async function deliverControlReply(api, linearApi, linearSessionId, payload) {
    const body = payload.text?.trim();
    if (!body || shouldSuppressControlReply(body))
        return;
    await linearApi.emitActivity(linearSessionId, {
        type: "thought",
        body,
    }).catch((err) => api.logger.warn(`Could not project deferred Codex reply to Linear: ${err}`));
}
async function dispatchControlCommand(params) {
    const { api, linearApi, binding, command } = params;
    const ctx = api.runtime.channel.inbound.buildContext({
        channel: "linear",
        provider: "linear",
        surface: "linear-agent-session",
        messageId: `linear-control-${Date.now()}`,
        timestamp: Date.now(),
        from: `linear:${binding.linearSessionId}`,
        sender: {
            id: binding.linearSessionId,
            name: "Linear AgentSession user",
            displayLabel: "Linear AgentSession user",
        },
        conversation: {
            kind: "direct",
            id: binding.linearSessionId,
            label: `Linear AgentSession ${binding.linearSessionId}`,
        },
        route: {
            agentId: binding.agentId,
            routeSessionKey: binding.sessionKey,
            dispatchSessionKey: binding.sessionKey,
            persistedSessionKey: binding.sessionKey,
            createIfMissing: true,
        },
        reply: {
            to: `linear:${binding.linearSessionId}`,
            sourceReplyDeliveryMode: "direct",
        },
        message: {
            inboundEventKind: "user_request",
            body: command,
            rawBody: command,
            bodyForAgent: command,
            commandBody: command,
        },
        access: {
            commands: {
                authorized: true,
                useAccessGroups: false,
                allowTextCommands: true,
                authorizers: [],
            },
        },
        command: {
            kind: "text-slash",
            body: command,
            authorized: true,
        },
        commandTurn: {
            kind: "text-slash",
            source: "text",
            body: command,
            authorized: true,
        },
    });
    await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: api.runtime.config.current(),
        dispatcherOptions: {
            deliver: async (payload) => deliverControlReply(api, linearApi, binding.linearSessionId, payload),
            onError: (err) => api.logger.warn(`Codex control command failed: ${err}`),
            silentReplyContext: {
                cfg: api.runtime.config.current(),
                sessionKey: binding.sessionKey,
                surface: "linear-agent-session",
                conversationType: "direct",
            },
        },
    });
}
function queueControlCommand(params) {
    const task = dispatchControlCommand(params)
        .catch((err) => params.api.logger.error(`Could not route Codex control command: ${err}`))
        .finally(() => params.binding.pendingControls.delete(task));
    params.binding.pendingControls.add(task);
    return task;
}
/**
 * Inject a Linear follow-up into the active Codex run through OpenClaw's
 * acceptance-aware `/steer` command. Review/compaction rejection therefore
 * falls back to a queued normal prompt instead of losing the message.
 */
export function steerActiveCodexRun(params) {
    const binding = getActiveCodexRun(params.issueId, params.linearSessionId);
    if (!binding)
        return false;
    queueControlCommand({
        api: params.api,
        linearApi: params.linearApi,
        binding,
        command: `/steer ${params.message}`,
    });
    return true;
}
/** Route a Linear stop signal to native Codex interruption, never steering. */
export async function stopActiveCodexRun(params) {
    const binding = getActiveCodexRun(params.issueId, params.linearSessionId);
    if (!binding)
        return false;
    await queueControlCommand({
        api: params.api,
        linearApi: params.linearApi,
        binding,
        command: "/codex stop",
    });
    return true;
}
/**
 * Route a control command to a known OpenClaw session even when it is a native
 * specialist child rather than the issue-level Codex binding. Used by child
 * Linear AgentSessions so their prompts steer the specialist that owns them.
 * @param params - runtime route and Linear projection metadata
 */
export async function controlOpenClawSession(params) {
    await dispatchControlCommand({
        api: params.api,
        linearApi: params.linearApi,
        binding: {
            issueId: `specialist:${params.linearSessionId}`,
            linearSessionId: params.linearSessionId,
            agentId: params.agentId,
            openClawSessionId: params.openClawSessionKey,
            sessionKey: params.openClawSessionKey,
            runId: params.openClawSessionKey,
            pendingControls: new Set(),
        },
        command: params.command,
    });
}
/** @internal Reset the process-local registry between tests. */
export function _resetCodexSteeringForTesting() {
    activeByIssue.clear();
}
