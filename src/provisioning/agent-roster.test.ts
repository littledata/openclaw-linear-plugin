import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROSTER,
  DEFAULT_PROVISION_IDS,
  resolveRoster,
  tononeAgentsForRoster,
} from "./agent-roster.js";

describe("resolveRoster", () => {
  it("returns the full default roster when provisionAgents is unset", () => {
    expect(resolveRoster().map((a) => a.id)).toEqual(DEFAULT_PROVISION_IDS);
    expect(resolveRoster({}).map((a) => a.id)).toEqual(DEFAULT_PROVISION_IDS);
  });

  it("filters to the selected ids, preserving default order", () => {
    const roster = resolveRoster({ provisionAgents: ["warden", "apex", "proof"] });
    expect(roster.map((a) => a.id)).toEqual(["apex", "warden", "proof"]);
  });

  it("ignores unknown ids and is case-insensitive", () => {
    const roster = resolveRoster({ provisionAgents: ["APEX", "nope", "Spine"] });
    expect(roster.map((a) => a.id)).toEqual(["apex", "spine"]);
  });

  it("applies agentOverrides without dropping unspecified fields", () => {
    const [apex] = resolveRoster({
      provisionAgents: ["apex"],
      agentOverrides: { apex: { skills: ["apex-plan"], label: "Lead" } },
    });
    expect(apex.skills).toEqual(["apex-plan"]);
    expect(apex.label).toBe("Lead");
    // subagents untouched by the override
    expect(apex.subagents).toEqual(["spine", "relay", "flux", "prism", "forge"]);
  });
});

describe("roster shape", () => {
  it("apex is the coding lead delegating to implementers", () => {
    const apex = DEFAULT_ROSTER.find((a) => a.id === "apex")!;
    expect(apex.kind).toBe("plan-implement");
    expect(apex.subagents).toContain("spine");
  });

  it("apex-reviewer is a distinct review agent with inline comments + approve", () => {
    const rev = DEFAULT_ROSTER.find((a) => a.id === "apex-reviewer")!;
    expect(rev.kind).toBe("review");
    expect(rev.reviewStyle).toBe("approve");
    expect(rev.inlineComments).toBe(true);
    // shares the tonone apex source
    expect(rev.tononeAgent).toBe("apex");
  });

  it("warden comments (never approves); proof is QA", () => {
    expect(DEFAULT_ROSTER.find((a) => a.id === "warden")!.reviewStyle).toBe("comment");
    expect(DEFAULT_ROSTER.find((a) => a.id === "proof")!.kind).toBe("qa");
  });

  it("dedupes tonone source agents (apex + apex-reviewer → one 'apex')", () => {
    const sources = tononeAgentsForRoster(resolveRoster());
    expect(sources.filter((s) => s === "apex")).toHaveLength(1);
    expect(sources).toContain("spine");
  });
});
