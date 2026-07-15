import { describe, it, expect } from "vitest";
import { buildWorkspacePrompt } from "./workspace-prompt.js";

describe("buildWorkspacePrompt", () => {
  const base = { identifier: "CORE-1", repos: [{ name: "api", workdir: "/work/api" }] };

  it("always states write-isolation, the tool catalog, and the no-transition rule", () => {
    const p = buildWorkspacePrompt({ ...base, kind: "plan-implement" });
    expect(p).toContain("CORE-1");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("container_search_code");
    expect(p).toContain("container_clone_repo");
    expect(p).toContain("NEVER change the ticket's workflow state");
    expect(p).toContain("api: /work/api");
  });

  it("implement kind explains commit/verify and forbids push/PR", () => {
    const p = buildWorkspacePrompt({ ...base, kind: "plan-implement" });
    expect(p).toContain("## Implementing");
    expect(p).toContain("VERIFY");
    expect(p).toContain("Do NOT push");
    expect(p).not.toContain("## Publishing your review");
  });

  it("warden (comment) publishes a COMMENT review and never approves", () => {
    const p = buildWorkspacePrompt({
      ...base,
      kind: "review",
      reviewStyle: "comment",
      verdictTag: "SECURITY",
      pullRequests: [{ repoName: "api", url: "https://github.com/o/api/pull/7" }],
    });
    expect(p).toContain("## Publishing your review");
    expect(p).toContain("gh pr review <pr-url> --comment");
    expect(p).toContain("--request-changes");
    expect(p).toContain("Never run `gh pr review --approve`");
    expect(p).toContain("SECURITY: pass");
    expect(p).toContain("https://github.com/o/api/pull/7");
  });

  it("apex-reviewer (approve) posts inline comments then APPROVE/REQUEST_CHANGES", () => {
    const p = buildWorkspacePrompt({
      ...base,
      kind: "review",
      reviewStyle: "approve",
      inlineComments: true,
      verdictTag: "REVIEW",
    });
    expect(p).toContain("INLINE comments");
    expect(p).toContain("pulls/<number>/reviews");
    expect(p).toContain("event=<APPROVE|REQUEST_CHANGES>");
    expect(p).toContain("REVIEW: pass");
  });

  it("qa kind is read-only and never edits code", () => {
    const p = buildWorkspacePrompt({ ...base, kind: "qa", reviewStyle: "comment" });
    expect(p).toContain("## Reviewing");
    expect(p).toContain("change nothing in the code");
  });

  it("handles unknown repos gracefully", () => {
    const p = buildWorkspacePrompt({ identifier: "CORE-2", kind: "plan-implement" });
    expect(p).toContain("cloned in your container workspace");
  });
});
