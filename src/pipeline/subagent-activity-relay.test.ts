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
