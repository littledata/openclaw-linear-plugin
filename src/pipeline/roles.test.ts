import { describe, it, expect } from "vitest";
import {
  ROLES,
  resolveRole,
  implementerRoles,
  buildRolePrompt,
  parseReviewVerdict,
  resolveRoleBackend,
  resolveRoleModel,
  roleToolsDeny,
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
    expect(ids).toEqual(["flux", "forge", "prism", "relay", "spine"]);
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
    expect(p).toContain("spine-api");
    expect(p).toContain("CORE-1");
    expect(p).toContain("worktree");
  });
  it("adds a verdict-line instruction for reviewers", () => {
    const p = buildRolePrompt(ROLES.warden, { identifier: "CORE-2", phase: "review" });
    expect(p).toContain("SECURITY: pass");
    expect(p).toContain("REVIEWING");
    expect(p).toContain("ONE bounded container_exec");
    expect(p).toMatch(/Do not browse repository files through GitHub/i);
  });
  it("appends extra instructions", () => {
    const p = buildRolePrompt(ROLES.apex, { identifier: "CORE-3", phase: "plan", extra: "ROUTING-BLOB" });
    expect(p).toContain("ROUTING-BLOB");
    expect(p).toContain("ONE bounded container_exec");
  });
  it("embedded backend references the skill by name", () => {
    const p = buildRolePrompt(ROLES.warden, { identifier: "CORE-5", phase: "review", backend: "embedded" });
    expect(p).toContain("warden-audit");
    expect(p).toMatch(/Use the .* skill/);
  });
  it("codex backend does NOT tell it to use a skill or cli_ tool", () => {
    const p = buildRolePrompt(ROLES.spine, { identifier: "CORE-6", phase: "implement", backend: "codex" });
    expect(p).not.toMatch(/Use the `spine-api` skill/);
    expect(p).toMatch(/implement DIRECTLY/i);
    expect(p).toMatch(/no.*cli_\* tools|do NOT have/i);
  });
  it("forbids moving the ticket (but not all Linear use) for every role/phase", () => {
    for (const role of Object.values(ROLES)) {
      for (const phase of ["plan", "implement", "review", "product"] as const) {
        const p = buildRolePrompt(role, { identifier: "CORE-4", phase });
        expect(p).toMatch(/Do NOT change the ticket's workflow state/);
        expect(p).toMatch(/post a comment/); // Linear access is still allowed
      }
    }
  });
});

describe("roleToolsDeny", () => {
  it("does NOT deny linear_issues for any role (agents keep Linear access)", () => {
    for (const role of Object.values(ROLES)) {
      expect(roleToolsDeny(role)).not.toContain("linear_issues");
    }
  });
  it("denies the code CLIs for read-only roles (review can't rewrite code)", () => {
    expect(roleToolsDeny(ROLES.warden)).toEqual(
      expect.arrayContaining([
        "cli_codex",
        "cli_claude",
        "cli_gemini",
        "codex_apps.github_search",
        "codex_apps.github_fetch_file",
      ]),
    );
  });
  it("denies nothing for implementer (codex) roles", () => {
    expect(roleToolsDeny(ROLES.spine)).toEqual([]);
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
  it("accepts common structured verdict variants", () => {
    expect(parseReviewVerdict("**REVIEW VERDICT:** pass", "REVIEW").pass).toBe(true);
    expect(parseReviewVerdict('{"verdict":"fail"}', "REVIEW").pass).toBe(false);
    expect(parseReviewVerdict("`Verdict: pass`", "REVIEW").pass).toBe(true);
  });
  it("defaults to FAIL when no verdict line is present", () => {
    const v = parseReviewVerdict("I reviewed it and it seems fine", "SECURITY");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("no SECURITY verdict");
  });
});
