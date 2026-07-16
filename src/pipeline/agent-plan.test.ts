import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SessionPlan,
  createSessionPlan,
  getSessionPlan,
  disposeSessionPlan,
  updateAssignmentStatus,
  type PlanStep,
} from "./agent-plan.js";

function makeApi() {
  return { updateSession: vi.fn().mockResolvedValue(undefined) };
}

describe("SessionPlan", () => {
  it("flattens phases → specialist assignments → nested steps", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement", "Code review", "QA"]);
    plan.setAssignments(0, [
      { key: "spine", label: "Spine", steps: ["refactor Redis", "add tests"] },
      { key: "forge", label: "Forge", steps: ["provision cache"] },
    ]);
    expect(plan.toSteps()).toEqual<PlanStep[]>([
      { content: "Implement", status: "pending" },
      { content: "↳ Spine", status: "pending" },
      { content: "    • refactor Redis", status: "pending" },
      { content: "    • add tests", status: "pending" },
      { content: "↳ Forge", status: "pending" },
      { content: "    • provision cache", status: "pending" },
      { content: "Code review", status: "pending" },
      { content: "QA", status: "pending" },
    ]);
  });

  it("flips one specialist (and its steps) live by match key, leaving siblings alone", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setAssignments(0, [
      { key: "spine", label: "Spine", steps: ["build API"] },
      { key: "forge", label: "Forge", steps: ["provision"] },
    ]);
    // in-progress leaves the specialist's steps pending (no per-step signal)
    expect(plan.setAssignmentStatus("SPINE", "inProgress")).toBe(true);
    // completed cascades to the specialist's steps
    expect(plan.setAssignmentStatus("spine", "completed")).toBe(true);
    const steps = plan.toSteps();
    expect(steps[1]).toEqual({ content: "↳ Spine", status: "completed" });
    expect(steps[2]).toEqual({ content: "    • build API", status: "completed" });
    // Forge untouched
    expect(steps[3]).toEqual({ content: "↳ Forge", status: "pending" });
    expect(steps[4]).toEqual({ content: "    • provision", status: "pending" });
  });

  it("matches keys tolerantly (namespace-stripped, case-insensitive)", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setAssignments(0, [{ key: "spine", label: "Spine", steps: ["x"] }]);
    expect(plan.setAssignmentStatus("tonone:Spine", "completed")).toBe(true);
    expect(plan.setAssignmentStatus("unknown", "completed")).toBe(false);
  });

  it("setPhaseAssignmentsStatus flips every specialist + step of a phase", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setAssignments(0, [{ key: "spine", label: "Spine", steps: ["a", "b"] }]);
    plan.setPhaseAssignmentsStatus(0, "completed");
    for (const row of plan.toSteps().slice(1)) expect(row.status).toBe("completed");
  });

  it("shows only a placeholder while preparing, then reveals the tree", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setAssignments(0, [{ key: "spine", label: "Spine", steps: ["x"] }]);
    plan.setPreparing("🧭 Apex is preparing the plan…");
    expect(plan.toSteps()).toEqual([{ content: "🧭 Apex is preparing the plan…", status: "inProgress" }]);
    plan.clearPreparing();
    expect(plan.toSteps().length).toBe(3);
  });

  it("transitions phase status independently of assignments", () => {
    const plan = new SessionPlan({ linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement", "Code review"]);
    plan.setPhaseStatus(0, "inProgress");
    plan.setPhaseStatus(1, "canceled");
    const steps = plan.toSteps();
    expect(steps[0]).toEqual({ content: "Implement", status: "inProgress" });
    expect(steps[1]).toEqual({ content: "Code review", status: "canceled" });
  });

  it("flush() pushes the full plan array to Linear (full replacement)", async () => {
    const api = makeApi();
    const plan = new SessionPlan({ linearApi: api, agentSessionId: "s-42", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setPhaseStatus(0, "completed");
    await plan.flush();
    expect(api.updateSession).toHaveBeenCalledWith("s-42", {
      plan: [{ content: "Implement", status: "completed" }],
    });
  });

  it("does NOT push when disabled or when there is no session", async () => {
    const disabled = makeApi();
    const p1 = new SessionPlan({ linearApi: disabled, agentSessionId: "s1", enabled: false });
    p1.initPhases(["Implement"]);
    await p1.flush();
    expect(disabled.updateSession).not.toHaveBeenCalled();

    const noSession = makeApi();
    const p2 = new SessionPlan({ linearApi: noSession, agentSessionId: undefined, enabled: true });
    p2.initPhases(["Implement"]);
    await p2.flush();
    expect(noSession.updateSession).not.toHaveBeenCalled();
  });

  it("swallows Linear errors (best-effort) and warns", async () => {
    const api = { updateSession: vi.fn().mockRejectedValue(new Error("boom")) };
    const warn = vi.fn();
    const plan = new SessionPlan({ linearApi: api, agentSessionId: "s1", enabled: true, logger: { warn } });
    plan.initPhases(["Implement"]);
    await expect(plan.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("session plan registry", () => {
  beforeEach(() => disposeSessionPlan("CORE-1"));

  it("create/get/dispose round-trips by ticket identifier", () => {
    const plan = createSessionPlan("CORE-1", { linearApi: makeApi(), agentSessionId: "s1", enabled: true });
    expect(getSessionPlan("CORE-1")).toBe(plan);
    disposeSessionPlan("CORE-1");
    expect(getSessionPlan("CORE-1")).toBeUndefined();
  });

  it("updateAssignmentStatus flips a registered plan's specialist and flushes", async () => {
    const api = makeApi();
    const plan = createSessionPlan("CORE-1", { linearApi: api, agentSessionId: "s1", enabled: true });
    plan.initPhases(["Implement"]);
    plan.setAssignments(0, [{ key: "spine", label: "Spine", steps: ["x"] }]);
    api.updateSession.mockClear();
    await updateAssignmentStatus("CORE-1", "spine", "completed");
    expect(api.updateSession).toHaveBeenCalledWith("s1", {
      plan: [
        { content: "Implement", status: "pending" },
        { content: "↳ Spine", status: "completed" },
        { content: "    • x", status: "completed" },
      ],
    });
    disposeSessionPlan("CORE-1");
  });

  it("updateAssignmentStatus no-ops for an unknown ticket", async () => {
    await expect(updateAssignmentStatus("NOPE-9", "spine", "completed")).resolves.toBeUndefined();
  });
});
