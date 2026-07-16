import { describe, expect, it, vi } from "vitest";
import { routeDelegateForState, type DelegateRoutingConfig } from "./delegate-routing.js";

const config: DelegateRoutingConfig = {
  enabled: true,
  selfOwner: "triage",
  owners: { triage: "lil-agent-id", delivery: "vasile-id" },
  stateOwners: {
    Triage: "triage",
    "In Progress": "delivery",
    "Code Review": "delivery",
    QA: "delivery",
  },
};

describe("routeDelegateForState", () => {
  it("hands a triage-owned delivery state to Vasile", async () => {
    const updateIssue = vi.fn().mockResolvedValue({});
    const result = await routeDelegateForState(
      config,
      {
        id: "issue-1",
        delegateId: "lil-agent-id",
        state: { name: "code review" },
      },
      { getIssueDetails: vi.fn(), updateIssue },
    );

    expect(result).toMatchObject({ action: "transferred", toOwner: "delivery" });
    expect(updateIssue).toHaveBeenCalledWith("issue-1", { delegateId: "vasile-id" });
  });

  it("does not touch unassigned, human-owned, or peer-owned tickets", async () => {
    const updateIssue = vi.fn();
    for (const delegateId of [undefined, "human-id", "vasile-id"]) {
      const getIssueDetails = vi.fn().mockResolvedValue({
        id: "issue-1",
        delegateId,
        state: { name: "In Progress" },
      });
      const result = await routeDelegateForState(
        config,
        { id: "issue-1", delegateId, state: { name: "In Progress" } },
        { getIssueDetails, updateIssue },
      );
      expect(result.action).toBe("ignored");
    }
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("keeps ownership when the state already belongs to this profile", async () => {
    const updateIssue = vi.fn();
    const result = await routeDelegateForState(
      config,
      { id: "issue-1", delegateId: "lil-agent-id", state: { name: "Triage" } },
      { getIssueDetails: vi.fn(), updateIssue },
    );
    expect(result.action).toBe("unchanged");
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("enriches sparse webhook data before routing", async () => {
    const updateIssue = vi.fn().mockResolvedValue({});
    const getIssueDetails = vi.fn().mockResolvedValue({
      id: "issue-1",
      delegate: { id: "lil-agent-id" },
      state: { name: "QA" },
    });
    const result = await routeDelegateForState(
      config,
      { id: "issue-1" },
      { getIssueDetails, updateIssue },
    );
    expect(result.action).toBe("transferred");
    expect(getIssueDetails).toHaveBeenCalledWith("issue-1");
  });
});
