import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorktreeStatusMock, containerGitStatusMock, existsSyncMock } = vi.hoisted(() => ({
  getWorktreeStatusMock: vi.fn(),
  containerGitStatusMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("../infra/codex-worktree.js", () => ({ getWorktreeStatus: getWorktreeStatusMock }));
vi.mock("../infra/container-runner.js", () => ({ containerGitStatus: containerGitStatusMock }));

import { hasDispatchWorkspaceActivity } from "./dispatch-service.js";

const baseDispatch = {
  issueId: "issue-1",
  issueIdentifier: "CORE-1",
  worktreePath: "/artifacts/CORE-1",
  branch: "CORE-1/work",
  tier: "medium",
  model: "model",
  status: "working",
  dispatchedAt: "2026-07-14T00:00:00.000Z",
  attempt: 0,
} as const;

describe("hasDispatchWorkspaceActivity", () => {
  beforeEach(() => {
    getWorktreeStatusMock.mockReset();
    containerGitStatusMock.mockReset();
    existsSyncMock.mockReset();
  });

  it("checks container repos without running Git against the artifact directory", () => {
    containerGitStatusMock.mockReturnValue({ hasChanges: true, lastCommit: "abc", commitsAhead: 1 });

    expect(hasDispatchWorkspaceActivity({
      ...baseDispatch,
      containerName: "openclaw-linear-CORE-1",
      containerRepos: ["transaction-monitor-2"],
    } as any)).toBe(true);
    expect(containerGitStatusMock).toHaveBeenCalledWith(
      "openclaw-linear-CORE-1",
      "transaction-monitor-2",
    );
    expect(getWorktreeStatusMock).not.toHaveBeenCalled();
  });

  it("treats a transient container status failure conservatively", () => {
    containerGitStatusMock.mockImplementation(() => { throw new Error("docker unavailable"); });
    expect(hasDispatchWorkspaceActivity({
      ...baseDispatch,
      containerName: "openclaw-linear-CORE-1",
      containerRepos: ["transaction-monitor-2"],
    } as any)).toBe(true);
  });
});
