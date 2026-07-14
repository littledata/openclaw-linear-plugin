import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock, execCodexMock, containerGitStatusMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  execCodexMock: vi.fn(),
  containerGitStatusMock: vi.fn(),
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
    containerGitStatus: containerGitStatusMock,
  };
});

import { runStatePlan } from "./orchestrator.js";

describe("plan-implement no-change guard", () => {
  beforeEach(() => {
    runAgentMock.mockReset().mockResolvedValue({
      success: true,
      output: '{"assignments":[{"role":"spine","task":"Implement the change"}]}',
    });
    execCodexMock.mockReset().mockResolvedValue({ success: true, output: "Done" });
    containerGitStatusMock.mockReset().mockReturnValue({
      hasChanges: false,
      lastCommit: "abc base",
      commitsAhead: 0,
    });
  });

  it("does not launch Apex self-review after a successful but empty implementation", async () => {
    const createComment = vi.fn().mockResolvedValue("comment-1");
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Implement", team: { id: "team-1" } }),
        emitActivity: vi.fn().mockResolvedValue(undefined),
        createComment,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0 },
    } as any;
    const dispatch = {
      issueId: "issue-1",
      issueIdentifier: "CORE-1748",
      issueTitle: "Implement",
      worktreePath: "/tmp/openclaw-linear-implementation-test",
      branch: "CORE-1748/work",
      tier: "medium",
      model: "test-model",
      status: "dispatched",
      dispatchedAt: "2026-07-14T10:00:00.000Z",
      attempt: 0,
      agentSessionId: "session-1",
      containerName: "openclaw-linear-CORE-1748",
      containerRepos: ["transaction-monitor-2"],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "in-progress",
      phases: [{ type: "plan-implement" }],
      onSuccess: null,
    });

    expect(execCodexMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1); // Apex plan only; no self-review.
    expect(createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("no changes produced"),
    );
  });
});
