import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock, execCodexMock, containerGitStatusMock, openPrMock, updateDispatchProgressMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  execCodexMock: vi.fn(),
  containerGitStatusMock: vi.fn(),
  openPrMock: vi.fn(),
  updateDispatchProgressMock: vi.fn(),
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
    openPrInContainer: openPrMock,
  };
});

vi.mock("./dispatch-state.js", () => ({
  updateDispatchProgress: updateDispatchProgressMock,
}));

import { runStatePlan, summarizeImplementationFailure } from "./orchestrator.js";

describe("plan-implement no-change guard", () => {
  it("removes encoded tool payloads from implementation failures", () => {
    const encoded = Buffer.from("x".repeat(1_000)).toString("base64");
    expect(summarizeImplementationFailure(`Spine failed:\n\`\`\`\n${encoded}\n\`\`\``))
      .toBe("Spine failed: [tool output omitted]");
  });

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
    openPrMock.mockReset().mockResolvedValue("https://github.com/littledata/api/pull/1");
    updateDispatchProgressMock.mockReset().mockResolvedValue(undefined);
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

  it("continues a paused implementation through the stable OpenClaw session", async () => {
    runAgentMock
      .mockReset()
      .mockResolvedValueOnce({ success: true, output: "Continued the existing implementation." })
      .mockResolvedValueOnce({ success: true, output: "REVIEW: pass" });
    containerGitStatusMock.mockReturnValue({
      hasChanges: true,
      lastCommit: "def resumed work",
      commitsAhead: 1,
    });
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Implement", team: { id: "team-1" } }),
        emitActivity: vi.fn().mockResolvedValue(undefined),
        createComment: vi.fn().mockResolvedValue("comment-1"),
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "embedded", maxReworkAttempts: 0 },
    } as any;
    const dispatch = {
      issueId: "issue-resume",
      issueIdentifier: "CORE-RESUME",
      issueTitle: "Implement",
      worktreePath: "/tmp/openclaw-linear-resume-test",
      branch: "CORE-RESUME/work",
      tier: "medium",
      model: "test-model",
      status: "paused",
      dispatchedAt: "2026-07-14T10:00:00.000Z",
      attempt: 0,
      phaseIndex: 0,
      agentSessionId: "linear-session-resume",
      containerName: "openclaw-linear-CORE-RESUME",
      containerRepos: ["api"],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "in-progress",
      phases: [{ type: "plan-implement" }],
      onSuccess: null,
    }, {
      resume: true,
      resumeGuidance: "Continue, but leave Elasticsearch to infrastructure.",
    });

    expect(runAgentMock.mock.calls[0][0]).toMatchObject({
      sessionId: "linear-impl-CORE-RESUME",
      issueIdentifier: "CORE-RESUME",
      message: expect.stringContaining("Continue, but leave Elasticsearch to infrastructure."),
    });
    expect(runAgentMock.mock.calls[0][0].message).toContain("Continue the existing implementation");
    expect(openPrMock).toHaveBeenCalled();
  });
});
