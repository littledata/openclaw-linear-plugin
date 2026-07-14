import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock, execCodexMock, checkoutPullRequestMock, publishPullRequestReviewMock, updateDispatchProgressMock, completeDispatchMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  execCodexMock: vi.fn(),
  checkoutPullRequestMock: vi.fn(),
  publishPullRequestReviewMock: vi.fn(),
  updateDispatchProgressMock: vi.fn(),
  completeDispatchMock: vi.fn(),
}));

vi.mock("../agent/agent.js", () => ({
  READ_ONLY_DENY: [],
  runAgent: runAgentMock,
}));

vi.mock("../infra/container-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/container-runner.js")>();
  return {
    ...actual,
    execCodexInContainer: execCodexMock,
    checkoutPullRequestInContainer: checkoutPullRequestMock,
    publishPullRequestReviewInContainer: publishPullRequestReviewMock,
  };
});

vi.mock("./dispatch-state.js", () => ({
  updateDispatchProgress: updateDispatchProgressMock,
  completeDispatch: completeDispatchMock,
}));

import { runStatePlan } from "./orchestrator.js";

describe("review verdict recovery", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    execCodexMock.mockReset();
    checkoutPullRequestMock.mockReset().mockResolvedValue({ status: 0, stdout: "", stderr: "" });
    publishPullRequestReviewMock.mockReset().mockResolvedValue({ status: 0, stdout: "", stderr: "" });
    updateDispatchProgressMock.mockReset().mockResolvedValue(undefined);
    completeDispatchMock.mockReset().mockResolvedValue(undefined);
  });

  it("asks the reviewer for a format-only correction when a successful review omits its verdict line", async () => {
    execCodexMock
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
    const updateIssue = vi.fn().mockResolvedValue(true);
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
        updateIssue,
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

    expect(execCodexMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(checkoutPullRequestMock).toHaveBeenCalledTimes(1);
    expect(checkoutPullRequestMock).toHaveBeenCalledWith(
      "openclaw-linear-CORE-1740",
      "ld-shopify",
      "https://github.com/littledata/ld-shopify/pull/1740",
      1740,
      {},
    );
    expect(execCodexMock.mock.calls[1][0].prompt).toContain("Your review completed, but its verdict format was missing");
    expect(execCodexMock.mock.calls[0][0]).toMatchObject({
      containerName: "openclaw-linear-CORE-1740",
      workdir: "/work/ld-shopify",
      githubRole: undefined,
    });
    expect(execCodexMock.mock.calls[0][0].prompt).toContain("the local checkout is authoritative");
    expect(publishPullRequestReviewMock).toHaveBeenCalledWith(
      "openclaw-linear-CORE-1740",
      "ld-shopify",
      "https://github.com/littledata/ld-shopify/pull/1740",
      expect.stringContaining("### Warden"),
      true,
      {},
    );
    expect(publishPullRequestReviewMock.mock.calls[0][3]).toContain("### Warden");
    expect(createComment).not.toHaveBeenCalled();
    expect(updateIssue).toHaveBeenCalledWith("issue-1", { delegateId: null });
    expect(completeDispatchMock).toHaveBeenCalledWith(
      "CORE-1740",
      expect.objectContaining({ status: "done" }),
      undefined,
    );
    expect(emitActivity).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "response", body: expect.stringContaining("all phases passed") }),
    );
  });

  it("runs the full Warden + Apex bundle and publishes one overall failure", async () => {
    execCodexMock
      .mockResolvedValueOnce({
        success: true,
        output: "The query accepts untrusted input.\nSECURITY: fail — parameterize the query",
      })
      .mockResolvedValueOnce({ success: true, output: "REVIEW: pass" });
    const createComment = vi.fn().mockResolvedValue("comment-1");
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    const updateIssue = vi.fn().mockResolvedValue(true);
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Review", team: { id: "team-1" } }),
        emitActivity,
        createComment,
        getTeamStates: vi.fn().mockResolvedValue([
          { id: "state-progress", name: "In Progress", type: "started" },
        ]),
        updateIssue,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: {},
    } as any;
    const dispatch = {
      issueId: "issue-1",
      issueIdentifier: "CORE-1731",
      issueTitle: "Review",
      worktreePath: "/tmp/openclaw-linear-review-test",
      branch: "CORE-1731/review",
      tier: "medium",
      model: "test-model",
      status: "dispatched",
      dispatchedAt: "2026-07-13T10:00:00.000Z",
      attempt: 0,
      agentSessionId: "session-1",
      containerName: "openclaw-linear-CORE-1731",
      containerRepos: ["transaction-monitor-2"],
      reviewPullRequests: [{
        url: "https://github.com/littledata/transaction-monitor-2/pull/1541",
        repoName: "transaction-monitor-2",
        repository: "littledata/transaction-monitor-2",
        number: 1541,
      }],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "code-review",
      phases: [
        { type: "review", role: "warden", gate: true },
        { type: "review", role: "apex", gate: true },
      ],
      onSuccess: null,
      onFailure: { names: ["In Progress"] },
    });

    expect(execCodexMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(publishPullRequestReviewMock).toHaveBeenCalledTimes(1);
    expect(publishPullRequestReviewMock).toHaveBeenCalledWith(
      "openclaw-linear-CORE-1731",
      "transaction-monitor-2",
      "https://github.com/littledata/transaction-monitor-2/pull/1541",
      expect.stringContaining("### Apex"),
      false,
      {},
    );
    expect(publishPullRequestReviewMock.mock.calls[0][3]).toContain("### Warden");
    expect(updateIssue).toHaveBeenNthCalledWith(1, "issue-1", { stateId: "state-progress" });
    expect(updateIssue).toHaveBeenNthCalledWith(2, "issue-1", { delegateId: null });
    expect(completeDispatchMock).toHaveBeenCalledWith(
      "CORE-1731",
      expect.objectContaining({ status: "failed" }),
      undefined,
    );
    expect(createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("parameterize the query"),
    );
    expect(emitActivity).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "response", body: expect.stringContaining("parameterize the query") }),
    );
  });

  it("uses the steerable embedded Codex harness for container-local review when opted in", async () => {
    runAgentMock.mockResolvedValue({ success: true, output: "SECURITY: pass" });
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    const updateIssue = vi.fn().mockResolvedValue(true);
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Review", team: { id: "team-1" } }),
        emitActivity,
        createComment: vi.fn().mockResolvedValue("comment-1"),
        updateIssue,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { enableCodexHarnessSteering: true },
    } as any;
    const dispatch = {
      issueId: "issue-1",
      issueIdentifier: "CORE-1750",
      issueTitle: "Review",
      worktreePath: "/tmp/openclaw-linear-review-test",
      branch: "CORE-1750/review",
      tier: "medium",
      model: "test-model",
      status: "dispatched",
      dispatchedAt: "2026-07-15T10:00:00.000Z",
      attempt: 0,
      agentSessionId: "session-1",
      containerName: "openclaw-linear-CORE-1750",
      containerRepos: ["transaction-monitor-2"],
      reviewPullRequests: [{
        url: "https://github.com/littledata/transaction-monitor-2/pull/1750",
        repoName: "transaction-monitor-2",
        repository: "littledata/transaction-monitor-2",
        number: 1750,
      }],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "code-review",
      phases: [{ type: "review", role: "warden", gate: true }],
      onSuccess: null,
    });

    expect(execCodexMock).not.toHaveBeenCalled();
    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "warden",
      abortKey: "issue-1",
      issueIdentifier: "CORE-1750",
      readOnly: true,
      streaming: expect.objectContaining({ agentSessionId: "session-1" }),
    }));
    expect(publishPullRequestReviewMock).toHaveBeenCalledTimes(1);
  });
});
