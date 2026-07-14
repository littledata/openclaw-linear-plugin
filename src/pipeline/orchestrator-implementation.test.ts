import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentMock, execCodexMock, containerGitStatusMock, openPrMock, updateDispatchProgressMock, completeDispatchMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  execCodexMock: vi.fn(),
  containerGitStatusMock: vi.fn(),
  openPrMock: vi.fn(),
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
    containerGitStatus: containerGitStatusMock,
    openPrInContainer: openPrMock,
  };
});

vi.mock("./dispatch-state.js", () => ({
  updateDispatchProgress: updateDispatchProgressMock,
  completeDispatch: completeDispatchMock,
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
      hasUncommitted: false,
      lastCommit: "abc base",
      lastCommitMessage: "base",
      commitsAhead: 0,
    });
    openPrMock.mockReset().mockResolvedValue("https://github.com/littledata/api/pull/1");
    updateDispatchProgressMock.mockReset().mockResolvedValue(undefined);
    completeDispatchMock.mockReset().mockResolvedValue(undefined);
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

  it("requires a new commit when a fresh coding delegation starts from an existing branch", async () => {
    containerGitStatusMock.mockReturnValue({
      hasChanges: true,
      hasUncommitted: false,
      lastCommit: "def existing coder commit",
      lastCommitMessage: "CORE-REMEDIATE: existing\n\nChangelog:\n- code\n\nValidation:\n- test: pass",
      commitsAhead: 1,
    });
    const createComment = vi.fn().mockResolvedValue("comment-1");
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Remediate review", team: { id: "team-1" } }),
        emitActivity: vi.fn().mockResolvedValue(undefined),
        createComment,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0 },
    } as any;
    const dispatch = {
      issueId: "issue-remediate",
      issueIdentifier: "CORE-REMEDIATE",
      issueTitle: "Remediate review",
      worktreePath: "/tmp/openclaw-linear-remediate-test",
      branch: "CORE-REMEDIATE/work",
      tier: "medium",
      model: "test-model",
      status: "dispatched",
      dispatchedAt: "2026-07-14T10:00:00.000Z",
      attempt: 0,
      agentSessionId: "session-remediate",
      containerName: "openclaw-linear-CORE-REMEDIATE",
      containerRepos: ["api"],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "in-progress",
      phases: [{ type: "plan-implement" }],
      onSuccess: null,
    });

    expect(execCodexMock).toHaveBeenCalledTimes(1); // implementation only; no self-review
    expect(openPrMock).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      "issue-remediate",
      expect.stringContaining("remediation did not create a separate commit"),
    );
  });

  it("continues a paused implementation through the stable OpenClaw session", async () => {
    runAgentMock
      .mockReset()
      .mockResolvedValueOnce({ success: true, output: "Continued the existing implementation." });
    execCodexMock.mockResolvedValueOnce({ success: true, output: "REVIEW: pass" });
    containerGitStatusMock.mockReturnValue({
      hasChanges: true,
      hasUncommitted: false,
      lastCommit: "def resumed work",
      lastCommitMessage: "CORE-RESUME: work\n\nChangelog:\n- code\n\nValidation:\n- test: pass",
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
    expect(execCodexMock).toHaveBeenCalledWith(expect.objectContaining({
      containerName: "openclaw-linear-CORE-RESUME",
      githubRole: undefined,
      prompt: expect.stringContaining("refs/openclaw/base..HEAD"),
    }));
    expect(openPrMock).toHaveBeenCalled();
  });

  it("requires self-review remediation to land as a separate commit", async () => {
    runAgentMock
      .mockReset()
      .mockResolvedValueOnce({ success: true, output: "Implemented and committed." })
      .mockResolvedValueOnce({ success: true, output: "Fixed the review finding in a new commit." });
    execCodexMock
      .mockReset()
      .mockResolvedValueOnce({
        success: true,
        output: "Found an unhandled null path.\nREVIEW: fail — handle the null path",
      })
      .mockResolvedValueOnce({ success: true, output: "REVIEW: pass" });

    const base = {
      hasChanges: false,
      hasUncommitted: false,
      lastCommit: "aaa base",
      lastCommitMessage: "base",
      commitsAhead: 0,
    };
    const coder = {
      hasChanges: true,
      hasUncommitted: false,
      lastCommit: "bbb coder commit",
      lastCommitMessage: "CORE-FIX: implement\n\nChangelog:\n- code\n\nValidation:\n- test: pass",
      commitsAhead: 1,
    };
    const remediation = {
      hasChanges: true,
      hasUncommitted: false,
      lastCommit: "ccc review remediation",
      lastCommitMessage: "CORE-FIX: remediate\n\nChangelog:\n- fix\n\nValidation:\n- test: pass",
      commitsAhead: 2,
    };
    containerGitStatusMock
      .mockReset()
      .mockReturnValueOnce(base)
      .mockReturnValueOnce(coder)
      .mockReturnValueOnce(coder)
      .mockReturnValueOnce(remediation)
      .mockReturnValueOnce(remediation);

    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Implement", team: { id: "team-1" } }),
        emitActivity: vi.fn().mockResolvedValue(undefined),
        createComment: vi.fn().mockResolvedValue("comment-1"),
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "embedded", maxReworkAttempts: 1 },
    } as any;
    const dispatch = {
      issueId: "issue-fix",
      issueIdentifier: "CORE-FIX",
      issueTitle: "Implement",
      worktreePath: "/tmp/openclaw-linear-fix-test",
      branch: "CORE-FIX/work",
      tier: "medium",
      model: "test-model",
      status: "paused",
      dispatchedAt: "2026-07-14T10:00:00.000Z",
      attempt: 0,
      phaseIndex: 0,
      agentSessionId: "linear-session-fix",
      containerName: "openclaw-linear-CORE-FIX",
      containerRepos: ["api"],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "in-progress",
      phases: [{ type: "plan-implement" }],
      onSuccess: null,
    }, {
      resume: true,
      resumeGuidance: "Finish the existing change.",
    });

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[1][0].message).toContain("Found an unhandled null path");
    expect(runAgentMock.mock.calls[1][0].extraSystemPrompt).toContain("create a NEW commit");
    expect(openPrMock).toHaveBeenCalledOnce();
  });
});
