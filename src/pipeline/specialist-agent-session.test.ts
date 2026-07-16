import { describe, expect, it, vi } from "vitest";
import {
  bindSpecialistRuntimeIdentity,
  claimSpecialistAgentSession,
  completeSpecialistAgentSession,
  createSpecialistAgentSession,
  getSpecialistByLinearSession,
  getSpecialistByRuntimeIdentity,
} from "./specialist-agent-session.js";

function api() {
  return {
    createSessionOnIssue: vi.fn().mockResolvedValue({ sessionId: "child-linear-1" }),
    emitActivity: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    completeSession: vi.fn().mockResolvedValue(undefined),
  };
}

describe("specialist AgentSessions", () => {
  it("creates a child session with its own running plan and runtime routing", async () => {
    const linear = api();
    const record = await createSpecialistAgentSession(linear, {
      issueId: "issue-child-1",
      issueIdentifier: "CORE-CHILD",
      parentAgentSessionId: "parent-linear-1",
      agentId: "spine",
      agentLabel: "Spine",
      childSessionKey: "agent:spine:child-1",
      task: "Refactor authentication",
      steps: ["remove legacy route", "add regression tests"],
    });
    expect(record?.agentSessionId).toBe("child-linear-1");
    expect(getSpecialistByRuntimeIdentity("agent:spine:child-1")).toBe(record);
    expect(linear.updateSession).toHaveBeenCalledWith("child-linear-1", {
      plan: expect.arrayContaining([
        { content: "remove legacy route", status: "inProgress" },
        { content: "add regression tests", status: "pending" },
      ]),
    });
    bindSpecialistRuntimeIdentity("run-child-1", record!);
    expect(getSpecialistByRuntimeIdentity("run-child-1")).toBe(record);
  });

  it("claims the created webhook and completes the child plan/session", async () => {
    const linear = api();
    let resolveCreate!: (value: { sessionId: string }) => void;
    linear.createSessionOnIssue.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const creating = createSpecialistAgentSession(linear, {
      issueId: "issue-child-race",
      issueIdentifier: "CORE-RACE",
      parentAgentSessionId: "parent-race",
      agentId: "forge",
      agentLabel: "Forge",
      childSessionKey: "agent:forge:race",
      task: "Update deployment",
      steps: [],
    });
    await vi.waitFor(() => expect(linear.createSessionOnIssue).toHaveBeenCalled());
    const claimed = claimSpecialistAgentSession("issue-child-race", "child-race");
    expect(claimed?.agentId).toBe("forge");
    resolveCreate({ sessionId: "child-race" });
    const record = await creating;
    expect(getSpecialistByLinearSession("child-race")).toBe(record);
    await completeSpecialistAgentSession(linear, record!, true);
    expect(record?.active).toBe(false);
    expect(linear.completeSession).toHaveBeenCalledWith(
      "child-race",
      expect.stringContaining("returned the result to Apex"),
    );
  });
});
