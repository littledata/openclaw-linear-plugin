import { describe, it, expect, afterEach } from "vitest";
import {
  getPlanApproval,
  savePlanApproval,
  clearPlanApproval,
  isApprovalReply,
  type PlanApprovalState,
} from "./plan-approval-state.js";

function makeState(overrides: Partial<PlanApprovalState> = {}): PlanApprovalState {
  return {
    issueId: "issue-approval-test",
    issueIdentifier: "CORE-APPROVE",
    status: "pending",
    rounds: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  clearPlanApproval("issue-approval-test");
});

describe("plan-approval state store", () => {
  it("round-trips save → get → clear", () => {
    expect(getPlanApproval("issue-approval-test")).toBeUndefined();
    savePlanApproval(makeState({ assignments: [{ role: "spine", task: "build API" }] }));
    const got = getPlanApproval("issue-approval-test");
    expect(got?.status).toBe("pending");
    expect(got?.assignments).toEqual([{ role: "spine", task: "build API" }]);
    clearPlanApproval("issue-approval-test");
    expect(getPlanApproval("issue-approval-test")).toBeUndefined();
  });

  it("does not throw clearing an absent entry", () => {
    expect(() => clearPlanApproval("nope")).not.toThrow();
  });
});

describe("isApprovalReply", () => {
  it("treats explicit affirmatives as approval", () => {
    for (const yes of ["approve", "Approved", "LGTM", "ok", "yes", "ship it", "proceed", "looks good"]) {
      expect(isApprovalReply(yes)).toBe(true);
    }
  });

  it("treats change requests / empty as NOT approval", () => {
    for (const no of ["", "  ", "use redis instead", "can you split the backend task?", "no, rework the schema"]) {
      expect(isApprovalReply(no)).toBe(false);
    }
  });

  it("matches an approval embedded in a short sentence", () => {
    expect(isApprovalReply("yep approve this")).toBe(true);
  });
});
