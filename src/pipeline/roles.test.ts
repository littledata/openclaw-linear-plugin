import { describe, it, expect } from "vitest";
import {
  ROLES,
  resolveRole,
  implementerRoles,
  buildRolePrompt,
  parseReviewVerdict,
  resolveRoleBackend,
  resolveRoleModel,
} from "./roles.js";

describe("resolveRole", () => {
  it("resolves a known role case-insensitively", () => {
    expect(resolveRole("SPINE")?.id).toBe("spine");
    expect(resolveRole("warden")?.label).toBe("Warden");
  });
  it("returns undefined for unknown roles", () => {
    expect(resolveRole("nope")).toBeUndefined();
  });
});

describe("implementerRoles", () => {
  it("returns only the implement-kind roles", () => {
    const ids = implementerRoles().map((r) => r.id).sort();
    expect(ids).toEqual(["flux", "forge", "prism", "spine"]);
  });
});

describe("resolveRoleBackend", () => {
  it("uses the role default when no override", () => {
    expect(resolveRoleBackend(ROLES.spine)).toBe("codex");
    expect(resolveRoleBackend(ROLES.warden)).toBe("embedded");
  });
  it("honours a config override", () => {
    expect(resolveRoleBackend(ROLES.spine, { roleBackends: { spine: "embedded" } })).toBe("embedded");
  });
  it("ignores an invalid override value", () => {
    expect(resolveRoleBackend(ROLES.spine, { roleBackends: { spine: "bogus" } })).toBe("codex");
  });
});

describe("resolveRoleModel", () => {
  it("returns undefined with no config", () => {
    expect(resolveRoleModel(ROLES.spine)).toBeUndefined();
  });
  it("returns the configured model", () => {
    expect(resolveRoleModel(ROLES.spine, { roleModels: { spine: "openai/gpt-5.6-sol" } })).toBe(
      "openai/gpt-5.6-sol",
    );
  });
});

describe("buildRolePrompt", () => {
  it("binds the skill and names the issue", () => {
    const p = buildRolePrompt(ROLES.spine, { identifier: "CORE-1", phase: "implement" });
    expect(p).toContain("spine-backend");
    expect(p).toContain("CORE-1");
    expect(p).toContain("worktree");
  });
  it("adds a verdict-line instruction for reviewers", () => {
    const p = buildRolePrompt(ROLES.warden, { identifier: "CORE-2", phase: "review" });
    expect(p).toContain("SECURITY: pass");
    expect(p).toContain("REVIEWING");
  });
  it("appends extra instructions", () => {
    const p = buildRolePrompt(ROLES.apex, { identifier: "CORE-3", phase: "plan", extra: "ROUTING-BLOB" });
    expect(p).toContain("ROUTING-BLOB");
  });
});

describe("parseReviewVerdict", () => {
  it("parses a pass line", () => {
    expect(parseReviewVerdict("looks good\nSECURITY: pass", "SECURITY")).toEqual({
      pass: true,
      reason: "passed",
    });
  });
  it("parses a fail line with a reason", () => {
    const v = parseReviewVerdict("QA: fail — 2 tests are red", "QA");
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("2 tests are red");
  });
  it("parses a fail with a hyphen separator", () => {
    const v = parseReviewVerdict("REVIEW: fail - missing null check", "REVIEW");
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("missing null check");
  });
  it("takes the LAST verdict line", () => {
    const v = parseReviewVerdict("REVIEW: fail — early\n...\nREVIEW: pass", "REVIEW");
    expect(v.pass).toBe(true);
  });
  it("defaults to FAIL when no verdict line is present", () => {
    const v = parseReviewVerdict("I reviewed it and it seems fine", "SECURITY");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("no SECURITY verdict");
  });
});
