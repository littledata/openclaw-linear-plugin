import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import type { LinearAgentApi } from "../api/linear-api.js";

/** Runtime metadata for one Linear session's active Codex harness turn. */
export interface ActiveCodexRunBinding {
  issueId: string;
  linearSessionId: string;
  agentId: string;
  openClawSessionId: string;
  sessionKey: string;
  runId: string;
  pendingControls: Set<Promise<void>>;
}

const activeByIssue = new Map<string, ActiveCodexRunBinding>();

/** Return whether the opt-in Codex harness steering integration is enabled. */
export function isCodexHarnessSteeringEnabled(config?: Record<string, unknown>): boolean {
  return config?.enableCodexHarnessSteering === true;
}

/** Build the stable OpenClaw session key shared by a Linear AgentSession's turns. */
export function buildLinearCodexSessionKey(agentId: string, linearSessionId: string): string {
  return `agent:${agentId}:linear:direct:${linearSessionId}`;
}

/** Register an active Codex harness run so Linear prompts can target it. */
export function bindActiveCodexRun(
  binding: Omit<ActiveCodexRunBinding, "pendingControls">,
): ActiveCodexRunBinding {
  const active = { ...binding, pendingControls: new Set<Promise<void>>() };
  activeByIssue.set(binding.issueId, active);
  return active;
}

/** Return the active binding for an issue, optionally fenced to a Linear session. */
export function getActiveCodexRun(
  issueId: string,
  linearSessionId?: string,
): ActiveCodexRunBinding | null {
  const binding = activeByIssue.get(issueId);
  if (!binding) return null;
  if (linearSessionId && binding.linearSessionId !== linearSessionId) return null;
  return binding;
}

/** Remove a binding only when the completing run still owns it. */
export function unbindActiveCodexRun(issueId: string, runId: string): void {
  if (activeByIssue.get(issueId)?.runId === runId) activeByIssue.delete(issueId);
}

/** Wait for steer commands that fell back to a deferred normal turn. */
export async function drainCodexControls(binding: ActiveCodexRunBinding): Promise<void> {
  while (binding.pendingControls.size) {
    await Promise.allSettled([...binding.pendingControls]);
  }
}

function shouldSuppressControlReply(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "steered current session." ||
    normalized.includes("codex stop requested") ||
    normalized.includes("codex turn interrupted");
}

async function deliverControlReply(
  api: OpenClawPluginApi,
  linearApi: LinearAgentApi,
  linearSessionId: string,
  payload: ReplyPayload,
): Promise<void> {
  const body = payload.text?.trim();
  if (!body || shouldSuppressControlReply(body)) return;
  await linearApi.emitActivity(linearSessionId, {
    type: "thought",
    body,
  }).catch((err) => api.logger.warn(`Could not project deferred Codex reply to Linear: ${err}`));
}

async function dispatchControlCommand(params: {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  binding: ActiveCodexRunBinding;
  command: string;
}): Promise<void> {
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
    cfg: api.runtime.config.current() as any,
    dispatcherOptions: {
      deliver: async (payload) => deliverControlReply(api, linearApi, binding.linearSessionId, payload),
      onError: (err) => api.logger.warn(`Codex control command failed: ${err}`),
      silentReplyContext: {
        cfg: api.runtime.config.current() as any,
        sessionKey: binding.sessionKey,
        surface: "linear-agent-session",
        conversationType: "direct",
      },
    },
  });
}

function queueControlCommand(params: {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  binding: ActiveCodexRunBinding;
  command: string;
}): Promise<void> {
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
export function steerActiveCodexRun(params: {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  issueId: string;
  linearSessionId: string;
  message: string;
}): boolean {
  const binding = getActiveCodexRun(params.issueId, params.linearSessionId);
  if (!binding) return false;
  queueControlCommand({
    api: params.api,
    linearApi: params.linearApi,
    binding,
    command: `/steer ${params.message}`,
  });
  return true;
}

/** Route a Linear stop signal to native Codex interruption, never steering. */
export async function stopActiveCodexRun(params: {
  api: OpenClawPluginApi;
  linearApi: LinearAgentApi;
  issueId: string;
  linearSessionId: string;
}): Promise<boolean> {
  const binding = getActiveCodexRun(params.issueId, params.linearSessionId);
  if (!binding) return false;
  await queueControlCommand({
    api: params.api,
    linearApi: params.linearApi,
    binding,
    command: "/codex stop",
  });
  return true;
}

/** @internal Reset the process-local registry between tests. */
export function _resetCodexSteeringForTesting(): void {
  activeByIssue.clear();
}
