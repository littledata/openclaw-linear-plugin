/**
 * Relays a spawned specialist's visible activity into the parent Linear
 * AgentSession. Spawned OpenClaw sessions do not inherit the parent's embedded
 * streaming callbacks, so their tool cards and assistant messages need a
 * gateway-level bridge keyed by the child session/run identifiers.
 */
import {
  formatToolActivityParameter,
  formatToolActivityResult,
  formatToolActivityTitle,
} from "../agent/agent.js";

/** Minimal Linear API surface required by the relay. */
export interface SubagentActivityApi {
  emitActivity(
    agentSessionId: string,
    content:
      | { type: "thought"; body: string }
      | {
          type: "action";
          action: string;
          parameter?: string;
          result?: string;
        },
    opts?: { ephemeral?: boolean },
  ): Promise<void>;
}

/** Parent/child routing metadata retained for one spawned specialist. */
export interface SubagentActivityBinding {
  issueIdentifier: string;
  agentId: string;
  agentLabel: string;
  agentSessionId: string;
}

interface ToolHookContext {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}

interface ToolStartEvent {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface ToolEndEvent extends ToolStartEvent {
  result?: unknown;
  error?: string;
}

/** Sanitized OpenClaw event emitted for every active agent run. */
export interface SubagentAgentEvent {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
  sessionId?: string;
}

interface PendingTool {
  binding: SubagentActivityBinding;
  toolName: string;
  action: string;
  parameter?: string;
}

const MESSAGE_DEDUPE_MS = 5 * 60_000;
const MAX_DEDUPE_ENTRIES = 500;
const MAX_COMPLETED_TOOL_IDS = 1_000;
const PREAMBLE_QUIET_MS = 750;

interface PendingPreamble {
  binding: SubagentActivityBinding;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Mutable relay state shared by every plugin runtime in one gateway process.
 * Native subagents initialise their own plugin runtime, while the parent
 * runtime receives `subagent_spawned`; sharing this state lets the child
 * runtime resolve the binding registered by its parent.
 */
export interface SubagentActivityRelayState {
  bindings: Map<string, SubagentActivityBinding>;
  pendingTools: Map<string, PendingTool>;
  startedToolIds: Set<string>;
  completedToolIds: Set<string>;
  messageFingerprints: Map<string, number>;
  pendingPreambles: Map<string, PendingPreamble>;
}

/** Create an isolated relay state store. */
export function createSubagentActivityRelayState(): SubagentActivityRelayState {
  return {
    bindings: new Map(),
    pendingTools: new Map(),
    startedToolIds: new Set(),
    completedToolIds: new Set(),
    messageFingerprints: new Map(),
    pendingPreambles: new Map(),
  };
}

/** Extract only user-visible assistant text; thinking/reasoning blocks are excluded. */
export function extractVisibleAssistantText(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return [];
  if (typeof record.content === "string") {
    const text = record.content.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(record.content)) return [];
  return record.content
    .filter((block): block is Record<string, unknown> =>
      !!block &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => String(block.text).trim())
    .filter(Boolean);
}

/**
 * Gateway-level relay for child tool calls and visible assistant messages.
 * Every method is best-effort: Linear telemetry must never block coding work.
 */
export class SubagentActivityRelay {
  private readonly bindings: Map<string, SubagentActivityBinding>;
  private readonly pendingTools: Map<string, PendingTool>;
  private readonly startedToolIds: Set<string>;
  private readonly completedToolIds: Set<string>;
  private readonly messageFingerprints: Map<string, number>;
  private readonly pendingPreambles: Map<string, PendingPreamble>;

  /**
   * @param linearApi - Linear activity API
   * @param logger - best-effort diagnostic logger
   * @param state - shared runtime state; isolated by default for callers/tests
   */
  constructor(
    private readonly linearApi: SubagentActivityApi | null,
    private readonly logger?: { warn: (message: string) => void },
    state: SubagentActivityRelayState = createSubagentActivityRelayState(),
  ) {
    this.bindings = state.bindings;
    this.pendingTools = state.pendingTools;
    this.startedToolIds = state.startedToolIds;
    this.completedToolIds = state.completedToolIds;
    this.messageFingerprints = state.messageFingerprints;
    this.pendingPreambles = state.pendingPreambles;
  }

  /** Bind every known child identity (session key, session id, run id). */
  bind(keys: Array<string | undefined>, binding: SubagentActivityBinding): void {
    for (const key of keys) {
      if (key) this.bindings.set(key, binding);
    }
  }

  /** Announce that a bound specialist has started work in the shared ticket workspace. */
  async announceStarted(identities: Array<string | undefined>): Promise<void> {
    const binding = this.resolveBindingFromKeys(identities);
    if (!binding) return;
    await this.emitAssistantText(
      binding,
      `Started work in the ${binding.issueIdentifier} ticket workspace. Live progress and tool calls will appear here.`,
    );
  }

  /** Announce the terminal specialist lifecycle state before its routing keys are released. */
  async announceFinished(
    identities: Array<string | undefined>,
    success: boolean,
  ): Promise<void> {
    const binding = this.resolveBindingFromKeys(identities);
    if (!binding) return;
    await this.emitAssistantText(
      binding,
      success ? "Finished the delegated work." : "Stopped before completing the delegated work.",
    );
  }

  /** Drop child identities and any pending tool records associated with them. */
  unbind(keys: Array<string | undefined>): void {
    const bindings = new Set(
      keys.map((key) => (key ? this.bindings.get(key) : undefined)).filter(Boolean),
    );
    for (const key of keys) {
      if (key) this.bindings.delete(key);
    }
    if (!bindings.size) return;
    for (const [key, preamble] of this.pendingPreambles) {
      if (!bindings.has(preamble.binding)) continue;
      clearTimeout(preamble.timer);
      this.pendingPreambles.delete(key);
      void this.emitAssistantText(preamble.binding, preamble.text);
    }
    for (const [key, pending] of this.pendingTools) {
      if (bindings.has(pending.binding)) this.pendingTools.delete(key);
    }
  }

  /**
   * Relay the native Codex/OpenClaw agent-event stream for a bound specialist.
   * This is the authoritative live surface for Codex harness runs: their
   * transcript is commonly persisted only after the turn finishes.
   */
  async agentEvent(event: SubagentAgentEvent): Promise<void> {
    const identities = [event.sessionKey, event.sessionId, event.runId];
    const binding = this.resolveBindingFromKeys(identities);
    if (!binding || !this.linearApi) return;

    if (event.stream === "tool") {
      const name = typeof event.data.name === "string" ? event.data.name : "tool";
      const toolCallId =
        typeof event.data.toolCallId === "string"
          ? event.data.toolCallId
          : typeof event.data.itemId === "string"
            ? event.data.itemId
            : undefined;
      const phase = event.data.phase;
      if (phase === "start") {
        await this.toolStarted(
          {
            toolName: name,
            toolCallId,
            params: this.asRecord(event.data.args),
            runId: event.runId,
          },
          event,
        );
      } else if (phase === "result") {
        const isError = event.data.isError === true;
        await this.toolFinished(
          {
            toolName: name,
            toolCallId,
            result: event.data.result,
            error: isError ? this.readError(event.data.result) : undefined,
            runId: event.runId,
          },
          event,
        );
      }
      return;
    }

    // Codex commentary is projected as an item/preamble snapshot. Coalesce
    // rapid token-level updates and publish only the latest visible text.
    if (
      event.stream === "item" &&
      event.data.kind === "preamble" &&
      typeof event.data.progressText === "string"
    ) {
      this.queuePreamble(
        binding,
        typeof event.data.itemId === "string" ? event.data.itemId : event.runId,
        event.data.progressText,
      );
      return;
    }

    // Streaming assistant snapshots are cumulative. The terminal snapshot has
    // no `delta`, so relay that once and let preambles cover live commentary.
    if (
      event.stream === "assistant" &&
      !Object.prototype.hasOwnProperty.call(event.data, "delta") &&
      typeof event.data.text === "string"
    ) {
      await this.emitAssistantText(binding, event.data.text);
    }
  }

  /** Emit the transient start card for a mapped child tool call. */
  async toolStarted(event: ToolStartEvent, ctx: ToolHookContext): Promise<void> {
    const binding = this.resolveBinding(event, ctx);
    if (!binding || !this.linearApi) return;
    const key = this.toolKey(event, binding);
    if (key && (this.startedToolIds.has(key) || this.completedToolIds.has(key))) return;
    if (key) this.startedToolIds.add(key);
    const action = formatToolActivityTitle(event.toolName);
    const parameter = this.withSpecialist(
      binding,
      formatToolActivityParameter(event.toolName, event.params),
    );
    if (key) {
      this.pendingTools.set(key, { binding, toolName: event.toolName, action, parameter });
    }
    await this.emit(
      binding.agentSessionId,
      { type: "action", action, parameter },
      { ephemeral: true },
    );
  }

  /** Emit the persistent completion card for a mapped child tool call. */
  async toolFinished(event: ToolEndEvent, ctx: ToolHookContext): Promise<void> {
    const binding = this.resolveBinding(event, ctx);
    if (!binding || !this.linearApi) return;
    const key = this.toolKey(event, binding);
    if (key && this.completedToolIds.has(key)) return;
    const pending = key ? this.pendingTools.get(key) : undefined;
    if (key) {
      this.pendingTools.delete(key);
      this.startedToolIds.delete(key);
      this.rememberCompletedTool(key);
    }
    const isError = typeof event.error === "string" && event.error.length > 0;
    await this.emit(binding.agentSessionId, {
      type: "action",
      action: pending?.action ?? formatToolActivityTitle(event.toolName),
      parameter:
        pending?.parameter ??
        this.withSpecialist(
          binding,
          formatToolActivityParameter(event.toolName, event.params),
        ),
      result: formatToolActivityResult(
        pending?.toolName ?? event.toolName,
        event.result ?? event.error ?? (isError ? "failed" : "completed"),
        isError,
      ),
    });
  }

  /** Relay visible child assistant prose as a specialist-labelled thought. */
  async assistantText(text: string, identities: Array<string | undefined>): Promise<void> {
    const binding = this.resolveBindingFromKeys(identities);
    if (!binding) return;
    await this.emitAssistantText(binding, text);
  }

  private async emitAssistantText(
    binding: SubagentActivityBinding,
    text: string,
  ): Promise<void> {
    const body = text.trim();
    if (!this.linearApi || !body) return;
    const fingerprint = `${binding.agentSessionId}:${binding.agentId}:${body}`;
    const now = Date.now();
    const seenAt = this.messageFingerprints.get(fingerprint);
    if (seenAt && now - seenAt < MESSAGE_DEDUPE_MS) return;
    this.messageFingerprints.set(fingerprint, now);
    this.trimMessageFingerprints(now);
    await this.emit(binding.agentSessionId, {
      type: "thought",
      body: `${binding.agentLabel} — ${body}`,
    });
  }

  /** Relay visible text blocks from a persisted child assistant message. */
  async assistantMessage(
    message: unknown,
    identities: Array<string | undefined>,
  ): Promise<void> {
    for (const text of extractVisibleAssistantText(message)) {
      await this.assistantText(text, identities);
    }
  }

  private resolveBinding(event: ToolStartEvent, ctx: ToolHookContext): SubagentActivityBinding | undefined {
    return this.resolveBindingFromKeys([
      ctx.sessionKey,
      ctx.sessionId,
      ctx.runId,
      event.runId,
    ]);
  }

  private resolveBindingFromKeys(keys: Array<string | undefined>): SubagentActivityBinding | undefined {
    for (const key of keys) {
      const binding = key ? this.bindings.get(key) : undefined;
      if (binding) return binding;
    }
    return undefined;
  }

  private toolKey(
    event: ToolStartEvent,
    binding: SubagentActivityBinding,
  ): string | undefined {
    const callId = event.toolCallId;
    if (!callId) return undefined;
    return `${binding.agentSessionId}:${binding.agentId}:${callId}`;
  }

  private queuePreamble(
    binding: SubagentActivityBinding,
    itemId: string,
    text: string,
  ): void {
    const key = `${binding.agentSessionId}:${binding.agentId}:${itemId}`;
    const existing = this.pendingPreambles.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingPreambles.delete(key);
      void this.emitAssistantText(binding, text);
    }, PREAMBLE_QUIET_MS);
    timer.unref?.();
    this.pendingPreambles.set(key, { binding, text, timer });
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private readError(value: unknown): string {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.error === "string") return record.error;
      if (typeof record.message === "string") return record.message;
    }
    return "failed";
  }

  private withSpecialist(binding: SubagentActivityBinding, parameter?: string): string {
    return parameter
      ? `Specialist: ${binding.agentLabel}\n\n${parameter}`
      : `Specialist: ${binding.agentLabel}`;
  }

  private rememberCompletedTool(key: string): void {
    this.completedToolIds.add(key);
    if (this.completedToolIds.size <= MAX_COMPLETED_TOOL_IDS) return;
    const oldest = this.completedToolIds.values().next().value;
    if (oldest) this.completedToolIds.delete(oldest);
  }

  private trimMessageFingerprints(now: number): void {
    for (const [key, seenAt] of this.messageFingerprints) {
      if (now - seenAt >= MESSAGE_DEDUPE_MS) this.messageFingerprints.delete(key);
    }
    while (this.messageFingerprints.size > MAX_DEDUPE_ENTRIES) {
      const oldest = this.messageFingerprints.keys().next().value;
      if (!oldest) break;
      this.messageFingerprints.delete(oldest);
    }
  }

  private async emit(
    agentSessionId: string,
    content: Parameters<SubagentActivityApi["emitActivity"]>[1],
    opts?: { ephemeral?: boolean },
  ): Promise<void> {
    try {
      await this.linearApi?.emitActivity(agentSessionId, content, opts);
    } catch (error) {
      this.logger?.warn(`[subagent-activity] could not emit Linear activity: ${error}`);
    }
  }
}
