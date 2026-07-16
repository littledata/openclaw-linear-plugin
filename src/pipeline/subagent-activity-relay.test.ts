import { describe, expect, it, vi } from "vitest";
import {
  extractVisibleAssistantText,
  SubagentActivityRelay,
} from "./subagent-activity-relay.js";

function createRelay() {
  const emitActivity = vi.fn().mockResolvedValue(undefined);
  const relay = new SubagentActivityRelay({ emitActivity });
  relay.bind(["child-session", "child-run"], {
    issueIdentifier: "CORE-1",
    agentId: "spine",
    agentLabel: "Spine",
    agentSessionId: "linear-session",
  });
  return { relay, emitActivity };
}

describe("SubagentActivityRelay", () => {
  it("announces specialist start and finish as labelled thoughts", async () => {
    const { relay, emitActivity } = createRelay();
    relay.bind(["announcement-child"], {
      issueIdentifier: "CORE-1747",
      agentId: "spine",
      agentLabel: "Spine",
      agentSessionId: "linear-session",
    });

    await relay.announceStarted(["announcement-child"]);
    await relay.announceFinished(["announcement-child"], true);

    expect(emitActivity).toHaveBeenNthCalledWith(
      1,
      "linear-session",
      {
        type: "thought",
        body:
          "Spine — Started work in the CORE-1747 ticket workspace. Live progress and tool calls will appear here.",
      },
      undefined,
    );
    expect(emitActivity).toHaveBeenNthCalledWith(
      2,
      "linear-session",
      { type: "thought", body: "Spine — Finished the delegated work." },
      undefined,
    );
  });

  it("relays native Codex agent events before the child transcript is persisted", async () => {
    const { relay, emitActivity } = createRelay();

    await relay.agentEvent({
      runId: "child-run",
      sessionKey: "child-session",
      stream: "tool",
      data: {
        phase: "start",
        name: "container_search_code",
        toolCallId: "native-call",
        args: { query: "MetricEmitter" },
      },
    });
    await relay.agentEvent({
      runId: "child-run",
      sessionKey: "child-session",
      stream: "tool",
      data: {
        phase: "result",
        name: "container_search_code",
        toolCallId: "native-call",
        result: { matches: ["src/metric.ts:1"] },
      },
    });

    expect(emitActivity).toHaveBeenNthCalledWith(
      1,
      "linear-session",
      {
        type: "action",
        action: "Search Code",
        parameter: "Specialist: Spine\n\nMetricEmitter",
      },
      { ephemeral: true },
    );
    expect(emitActivity).toHaveBeenNthCalledWith(
      2,
      "linear-session",
      expect.objectContaining({
        type: "action",
        action: "Search Code",
        parameter: "Specialist: Spine\n\nMetricEmitter",
      }),
      undefined,
    );
  });

  it("deduplicates a native tool event observed again through lifecycle hooks", async () => {
    const { relay, emitActivity } = createRelay();
    const event = {
      toolName: "container_exec",
      toolCallId: "same-call",
      params: { command: "git status --short" },
    };

    await relay.agentEvent({
      runId: "child-run",
      stream: "tool",
      data: {
        phase: "start",
        name: event.toolName,
        toolCallId: event.toolCallId,
        args: event.params,
      },
    });
    await relay.toolStarted(event, { sessionKey: "child-session" });
    await relay.agentEvent({
      runId: "child-run",
      stream: "tool",
      data: {
        phase: "result",
        name: event.toolName,
        toolCallId: event.toolCallId,
        result: { stdout: "clean", exitCode: 0 },
      },
    });
    await relay.toolFinished(
      { ...event, result: { stdout: "clean", exitCode: 0 } },
      { sessionKey: "child-session" },
    );

    expect(emitActivity).toHaveBeenCalledTimes(2);
  });

  it("coalesces visible Codex preamble updates into a specialist thought", async () => {
    vi.useFakeTimers();
    const { relay, emitActivity } = createRelay();

    await relay.agentEvent({
      runId: "child-run",
      stream: "item",
      data: {
        kind: "preamble",
        itemId: "message-1",
        progressText: "Inspecting the",
      },
    });
    await relay.agentEvent({
      runId: "child-run",
      stream: "item",
      data: {
        kind: "preamble",
        itemId: "message-1",
        progressText: "Inspecting the deployment files.",
      },
    });
    await vi.advanceTimersByTimeAsync(750);

    expect(emitActivity).toHaveBeenCalledTimes(1);
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session",
      { type: "thought", body: "Spine — Inspecting the deployment files." },
      undefined,
    );
    vi.useRealTimers();
  });

  it("relays only terminal assistant snapshots from the native stream", async () => {
    const { relay, emitActivity } = createRelay();
    await relay.agentEvent({
      runId: "child-run",
      stream: "assistant",
      data: { text: "partial", delta: "partial" },
    });
    await relay.agentEvent({
      runId: "child-run",
      stream: "assistant",
      data: { text: "Completed the infrastructure cleanup." },
    });

    expect(emitActivity).toHaveBeenCalledTimes(1);
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session",
      { type: "thought", body: "Spine — Completed the infrastructure cleanup." },
      undefined,
    );
  });

  it("relays a child container command as formatted start and completion cards", async () => {
    const { relay, emitActivity } = createRelay();
    await relay.toolStarted(
      {
        toolName: "container_exec",
        toolCallId: "call-1",
        params: { command: "git status --short" },
      },
      { sessionKey: "child-session" },
    );
    await relay.toolFinished(
      {
        toolName: "container_exec",
        toolCallId: "call-1",
        params: { command: "git status --short" },
        result: { stdout: " M src/file.ts", exitCode: 0 },
      },
      { sessionKey: "child-session" },
    );

    expect(emitActivity).toHaveBeenNthCalledWith(
      1,
      "linear-session",
      {
        type: "action",
        action: "Shell",
        parameter: "Specialist: Spine\n\ngit status --short",
      },
      { ephemeral: true },
    );
    expect(emitActivity).toHaveBeenNthCalledWith(
      2,
      "linear-session",
      {
        type: "action",
        action: "Shell",
        parameter: "Specialist: Spine\n\ngit status --short",
        result: "M src/file.ts",
      },
      undefined,
    );
  });

  it("relays generic child tools and errors", async () => {
    const { relay, emitActivity } = createRelay();
    await relay.toolFinished(
      {
        toolName: "memory_search",
        toolCallId: "call-2",
        params: { query: "prior work" },
        error: "unavailable",
      },
      { runId: "child-run" },
    );
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session",
      {
        type: "action",
        action: "Memory Search",
        parameter: 'Specialist: Spine\n\n{\n  "query": "prior work"\n}',
        result: "Failed\n\nunavailable",
      },
      undefined,
    );
  });

  it("relays and deduplicates visible assistant messages", async () => {
    const { relay, emitActivity } = createRelay();
    await relay.assistantText("I found the failing path.", ["child-session"]);
    await relay.assistantText("I found the failing path.", ["child-run"]);
    expect(emitActivity).toHaveBeenCalledTimes(1);
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session",
      { type: "thought", body: "Spine — I found the failing path." },
      undefined,
    );
  });

  it("stops relaying after the child is unbound", async () => {
    const { relay, emitActivity } = createRelay();
    relay.unbind(["child-session", "child-run"]);
    await relay.toolStarted(
      { toolName: "container_search_code", params: { query: "MetricEmitter" } },
      { sessionKey: "child-session" },
    );
    await relay.assistantText("No longer visible", ["child-run"]);
    expect(emitActivity).not.toHaveBeenCalled();
  });
});

describe("extractVisibleAssistantText", () => {
  it("keeps text and excludes reasoning/thinking blocks", () => {
    expect(
      extractVisibleAssistantText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "reasoning", text: "hidden reasoning" },
          { type: "text", text: "Visible progress" },
        ],
      }),
    ).toEqual(["Visible progress"]);
  });
});
