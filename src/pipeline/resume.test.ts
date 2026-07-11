import { describe, it, expect } from "vitest";
import { parseResumeDecision } from "./resume-state.js";
import { parseResumeAnalysis } from "./prior-work.js";

describe("parseResumeDecision", () => {
  it("recognizes resume phrasings", () => {
    for (const s of ["resume", "Resume please", "continue", "yes", "pick up where we left off"]) {
      expect(parseResumeDecision(s)).toBe("resume");
    }
  });
  it("recognizes fresh phrasings", () => {
    for (const s of ["fresh", "start fresh", "restart", "start over", "from scratch", "reset it"]) {
      expect(parseResumeDecision(s)).toBe("fresh");
    }
  });
  it("prefers fresh when both hinted (explicit restart wins)", () => {
    expect(parseResumeDecision("don't resume, start fresh")).toBe("fresh");
  });
  it("returns null when unrecognized", () => {
    expect(parseResumeDecision("what are my options?")).toBeNull();
  });
});

describe("parseResumeAnalysis", () => {
  const repos = ["ld-shopify", "transaction-monitor-2", "ld-shopify-admin"];

  it("parses repos (validated + canonicalized) + brief", () => {
    const out = '{"repos":["LD-SHOPIFY"],"brief":"Finish the disabledEvents UI slice."}';
    expect(parseResumeAnalysis(out, repos)).toEqual({
      repos: ["ld-shopify"],
      brief: "Finish the disabledEvents UI slice.",
    });
  });

  it("drops unknown repo names", () => {
    const out = '{"repos":["nope","ld-shopify-admin"],"brief":"x"}';
    expect(parseResumeAnalysis(out, repos)?.repos).toEqual(["ld-shopify-admin"]);
  });

  it("extracts JSON embedded in prose", () => {
    const out = 'After review:\n{"repos":["transaction-monitor-2"],"brief":"continue"}\ndone';
    expect(parseResumeAnalysis(out, repos)?.repos).toEqual(["transaction-monitor-2"]);
  });

  it("returns null when neither repos nor brief present", () => {
    expect(parseResumeAnalysis('{"repos":["nope"]}', repos)).toBeNull();
    expect(parseResumeAnalysis("no json", repos)).toBeNull();
  });

  it("accepts a brief with no repos (repo stays undecided)", () => {
    expect(parseResumeAnalysis('{"brief":"continue in the same place"}', repos)).toEqual({
      repos: [],
      brief: "continue in the same place",
    });
  });
});
