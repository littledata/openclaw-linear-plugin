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
import { getPlanApproval, savePlanApproval, clearPlanApproval } from "./plan-approval-state.js";

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
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0, planApprovalGate: false },
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
    // Nothing was committed, so there is genuinely nothing to ship → still blocks.
    expect(openPrMock).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("without producing code changes"),
    );
  });

  it("ships existing committed work when a fresh delegation adds no new commit", async () => {
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
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0, planApprovalGate: false },
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
    // Self-review / commit-hygiene never block the push: a valid commit already
    // exists on the branch, so we ship it and let human code review be the gate.
    expect(openPrMock).toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      "issue-remediate",
      expect.stringContaining("Implementation complete"),
    );
  });

  it("ships committed work when self-review keeps failing, attaching findings to the PR", async () => {
    const base = {
      hasChanges: false, hasUncommitted: false,
      lastCommit: "aaa base", lastCommitMessage: "base", commitsAhead: 0,
    };
    const coder = {
      hasChanges: true, hasUncommitted: false,
      lastCommit: "bbb coder commit",
      lastCommitMessage: "CORE-SHIP: implement\n\nChangelog:\n- code\n\nValidation:\n- test: pass",
      commitsAhead: 1,
    };
    containerGitStatusMock.mockReset().mockReturnValueOnce(base).mockReturnValue(coder);
    execCodexMock
      .mockReset()
      .mockResolvedValueOnce({ success: true, output: "Implemented the change." })
      .mockResolvedValueOnce({
        success: true,
        output: "Missing test coverage for the null path.\nREVIEW: fail — add tests",
      });
    const createComment = vi.fn().mockResolvedValue("comment-1");
    const ctx = {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Implement", team: { id: "team-1" } }),
        emitActivity: vi.fn().mockResolvedValue(undefined),
        createComment,
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0, planApprovalGate: false },
    } as any;
    const dispatch = {
      issueId: "issue-ship", issueIdentifier: "CORE-SHIP", issueTitle: "Implement",
      worktreePath: "/tmp/openclaw-linear-ship-test", branch: "CORE-SHIP/work",
      tier: "medium", model: "test-model", status: "dispatched",
      dispatchedAt: "2026-07-15T10:00:00.000Z", attempt: 0, agentSessionId: "session-ship",
      containerName: "openclaw-linear-CORE-SHIP", containerRepos: ["api"],
    } as any;

    await runStatePlan(ctx, dispatch, {
      stateLabel: "in-progress", phases: [{ type: "plan-implement" }], onSuccess: null,
    });

    // Self-review failed, but the committed work still ships — the human code
    // review is the real gate — and the findings ride along on the PR body.
    expect(openPrMock).toHaveBeenCalledOnce();
    const prBody = openPrMock.mock.calls[0][4];
    expect(prBody).toContain("Unresolved self-review findings");
    expect(prBody).toContain("Missing test coverage");
    expect(createComment).toHaveBeenCalledWith(
      "issue-ship",
      expect.stringContaining("Implementation complete"),
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
      pluginConfig: { workerBackend: "embedded", maxReworkAttempts: 0, planApprovalGate: false },
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
      pluginConfig: { workerBackend: "embedded", maxReworkAttempts: 1, planApprovalGate: false },
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

describe("plan-approval gate", () => {
  const ISSUE = "issue-approval-gate";
  beforeEach(() => {
    clearPlanApproval(ISSUE);
    runAgentMock.mockReset().mockResolvedValue({
      success: true,
      output: '{"assignments":[{"role":"spine","task":"Implement the change"}]}',
    });
    execCodexMock.mockReset().mockResolvedValue({ success: true, output: "Done" });
    containerGitStatusMock.mockReset().mockReturnValue({
      hasChanges: false, hasUncommitted: false, lastCommit: "abc base", lastCommitMessage: "base", commitsAhead: 0,
    });
    openPrMock.mockReset().mockResolvedValue("https://github.com/littledata/api/pull/1");
    updateDispatchProgressMock.mockReset().mockResolvedValue(undefined);
    completeDispatchMock.mockReset().mockResolvedValue(undefined);
  });

  function ctxFor(emitActivity: any) {
    return {
      api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
      linearApi: {
        getIssueDetails: vi.fn().mockResolvedValue({ title: "Implement", team: { id: "team-1" } }),
        emitActivity,
        createComment: vi.fn().mockResolvedValue("comment-1"),
      },
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: { workerBackend: "codex", maxReworkAttempts: 0, planApprovalGate: true },
    } as any;
  }
  const dispatch = () => ({
    issueId: ISSUE, issueIdentifier: "CORE-GATE", issueTitle: "Implement",
    worktreePath: "/tmp/openclaw-linear-gate-test", branch: "CORE-GATE/work",
    tier: "medium", model: "test-model", status: "dispatched",
    dispatchedAt: "2026-07-15T10:00:00.000Z", attempt: 0, agentSessionId: "session-1",
    containerName: "openclaw-linear-CORE-GATE", containerRepos: ["api"],
  }) as any;

  it("presents the plan and pauses before implementing on a fresh turn", async () => {
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    await runStatePlan(ctxFor(emitActivity), dispatch(), {
      stateLabel: "in-progress", phases: [{ type: "plan-implement" }], onSuccess: null,
    });
    // Apex planned, plan presented for approval, NO implementation ran.
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(execCodexMock).not.toHaveBeenCalled();
    expect(openPrMock).not.toHaveBeenCalled();
    const elicitation = emitActivity.mock.calls.find((c: any[]) => c[1]?.type === "elicitation");
    expect(elicitation?.[1].body).toContain("approval");
    expect(getPlanApproval(ISSUE)?.status).toBe("pending");
    clearPlanApproval(ISSUE);
  });

  it("implements the approved plan once the user signs off", async () => {
    savePlanApproval({
      issueId: ISSUE, issueIdentifier: "CORE-GATE", agentSessionId: "session-1",
      status: "approved", assignments: [{ role: "spine", task: "Implement the change" }],
      rounds: 1, createdAt: "2026-07-15T10:00:00.000Z",
    });
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    await runStatePlan(ctxFor(emitActivity), dispatch(), {
      stateLabel: "in-progress", phases: [{ type: "plan-implement" }], onSuccess: null,
    });
    // Approved plan → implementer ran (no re-plan needed), approval consumed.
    expect(execCodexMock).toHaveBeenCalled();
    expect(getPlanApproval(ISSUE)).toBeUndefined();
    clearPlanApproval(ISSUE);
  });
});
