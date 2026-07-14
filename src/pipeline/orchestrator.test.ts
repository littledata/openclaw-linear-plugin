import { describe, it, expect } from "vitest";
import { implementerUsesContainerAgent, parseAssignments } from "./orchestrator.js";

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

  it("falls back to a single spine assignment when unparseable", () => {
    expect(parseAssignments("no json here", issue)).toEqual([
      { role: "spine", task: "Implement issue CORE-9 end to end." },
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
