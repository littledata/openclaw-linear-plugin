import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../agent/agent.js", () => ({
  READ_ONLY_DENY: [],
  runAgent: runAgentMock,
}));

import { runStatePlan } from "./orchestrator.js";

describe("review verdict recovery", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("asks the reviewer for a format-only correction when a successful review omits its verdict line", async () => {
    runAgentMock
      .mockResolvedValueOnce({
        success: true,
        output: "I inspected the linked PR and found no security concerns.",
      })
      .mockResolvedValueOnce({
        success: true,
        output: "SECURITY: pass",
      });

    const emitActivity = vi.fn().mockResolvedValue(undefined);
    const createComment = vi.fn().mockResolvedValue("comment-1");
    const ctx = {
      api: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({
          title: "Review exact PR",
          description: "Check the attached change.",
          team: { id: "team-1" },
        }),
        emitActivity,
        createComment,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: {},
    } as any;
    const dispatch = {
      issueId: "issue-1",
      issueIdentifier: "CORE-1740",
      issueTitle: "Review exact PR",
      worktreePath: "/tmp/openclaw-linear-review-test",
      branch: "CORE-1740/review",
      tier: "medium",
      model: "test-model",
      status: "dispatched",
      dispatchedAt: "2026-07-13T10:00:00.000Z",
      attempt: 0,
      agentSessionId: "session-1",
      containerName: "openclaw-linear-CORE-1740",
      containerRepos: ["ld-shopify"],
      reviewPullRequests: [{
        url: "https://github.com/littledata/ld-shopify/pull/1740",
        repoName: "ld-shopify",
        repository: "littledata/ld-shopify",
        number: 1740,
      }],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "code-review",
      phases: [{ type: "review", role: "warden", gate: true }],
      onSuccess: null,
    });

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[1][0].message).toContain("Your review completed, but its verdict format was missing");
    expect(createComment).not.toHaveBeenCalled();
    expect(emitActivity).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "response", body: expect.stringContaining("all phases passed") }),
    );
  });
});
