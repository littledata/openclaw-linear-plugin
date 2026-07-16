import { describe, expect, it } from "vitest";
import { LINEAR_AGENT_SCOPES } from "./auth.js";

describe("Linear agent OAuth scopes", () => {
  it("makes the coding app assignable without exposing it in mention surfaces", () => {
    const scopes = LINEAR_AGENT_SCOPES.split(",");

    expect(scopes).toContain("app:assignable");
    expect(scopes).not.toContain("app:mentionable");
  });
});
