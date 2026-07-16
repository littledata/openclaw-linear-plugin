import { describe, it, expect } from "vitest";
import {
  implementerUsesContainerAgent,
  parseAssignments,
  parsePriorSessionPlan,
} from "./orchestrator.js";

const issue = { id: "1", identifier: "CORE-9", title: "t" };

describe("parseAssignments", () => {
  it("parses valid implementer assignments", () => {
    const out = '{"assignments":[{"role":"spine","task":"build API"},{"role":"prism","task":"build UI"}]}';
    expect(parseAssignments(out, issue)).toEqual([
      { role: "spine", task: "build API" },
      { role: "prism", task: "build UI" },
    ]);
  });

  it("lowercases and validates role ids, dropping unknown/empty", () => {
    const out = '{"assignments":[{"role":"SPINE","task":"x"},{"role":"apex","task":"y"},{"role":"flux","task":""}]}';
    // apex is not an implementer; flux has empty task → both dropped, leaving spine
    expect(parseAssignments(out, issue)).toEqual([{ role: "spine", task: "x" }]);
  });

  it("falls back to a single spine assignment (with steps) when unparseable", () => {
    const [fallback] = parseAssignments("no json here", issue);
    expect(fallback.role).toBe("spine");
    expect(fallback.task).toBe("Implement issue CORE-9 end to end.");
    expect(fallback.steps?.length).toBeGreaterThan(0);
  });

  it("parses the step-by-step breakdown for an assignment", () => {
    const out = '{"assignments":[{"role":"spine","task":"build API","steps":["add route"," wire service ","",42]}]}';
    expect(parseAssignments(out, issue)).toEqual([
      { role: "spine", task: "build API", steps: ["add route", "wire service", "42"] },
    ]);
  });

  it("falls back when assignments is missing or empty", () => {
    expect(parseAssignments('{"notes":"hi"}', issue)[0].role).toBe("spine");
    expect(parseAssignments('{"assignments":[]}', issue)[0].role).toBe("spine");
  });

  it("extracts JSON embedded in prose", () => {
    const out = 'Here is my plan:\n{"assignments":[{"role":"forge","task":"terraform"}]}\nDone.';
    expect(parseAssignments(out, issue)).toEqual([{ role: "forge", task: "terraform" }]);
  });
});

describe("parsePriorSessionPlan", () => {
  it("recovers the explicit Apex wait rows and specialist steps", () => {
    expect(parsePriorSessionPlan([
      "- [completed] Formulate plan",
      "- [pending] Wait for Spine — Refactor authentication",
      "- [pending]     • remove legacy route",
      "- [pending]     • add regression tests",
      "- [pending] Apex reviews specialist work and validates the combined change",
    ].join("\n"))).toEqual([{
      role: "spine",
      task: "Refactor authentication",
      steps: ["remove legacy route", "add regression tests"],
    }]);
  });

  it("recovers the older nested specialist format", () => {
    expect(parsePriorSessionPlan([
      "- [pending] Implement",
      "- [pending] ↳ Forge",
      "- [pending]     • update the deployment chart",
    ].join("\n"))).toEqual([{
      role: "forge",
      task: "update the deployment chart",
      steps: ["update the deployment chart"],
    }]);
  });
});

describe("implementerUsesContainerAgent", () => {
  it("uses direct in-container Codex when workerBackend is codex", () => {
    expect(implementerUsesContainerAgent({ workerBackend: "codex" })).toBe(false);
  });

  it("uses the continuous container agent when Codex harness steering is enabled", () => {
    expect(implementerUsesContainerAgent({
      workerBackend: "codex",
      enableCodexHarnessSteering: true,
    })).toBe(true);
  });

  it("uses the embedded container agent by default or when configured", () => {
    expect(implementerUsesContainerAgent()).toBe(true);
    expect(implementerUsesContainerAgent({ workerBackend: "embedded" })).toBe(true);
  });
});
