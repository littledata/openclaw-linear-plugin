import { describe, it, expect } from "vitest";
import { parsePriorContextAnalysis, isSubstantiveComment } from "./prior-work.js";

describe("parsePriorContextAnalysis", () => {
  const repos = ["ld-shopify", "transaction-monitor-2", "ld-shopify-admin"];

  it("parses repos (validated + canonicalized) + brief", () => {
    const out = '{"repos":["LD-SHOPIFY"],"brief":"Finish the disabledEvents UI slice."}';
    expect(parsePriorContextAnalysis(out, repos)).toEqual({
      repos: ["ld-shopify"],
      brief: "Finish the disabledEvents UI slice.",
    });
  });

  it("drops unknown repo names", () => {
    const out = '{"repos":["nope","ld-shopify-admin"],"brief":"x"}';
    expect(parsePriorContextAnalysis(out, repos)?.repos).toEqual(["ld-shopify-admin"]);
  });

  it("extracts JSON embedded in prose", () => {
    const out = 'After review:\n{"repos":["transaction-monitor-2"],"brief":"continue"}\ndone';
    expect(parsePriorContextAnalysis(out, repos)?.repos).toEqual(["transaction-monitor-2"]);
  });

  it("returns null when neither repos nor brief present", () => {
    expect(parsePriorContextAnalysis('{"repos":["nope"]}', repos)).toBeNull();
    expect(parsePriorContextAnalysis("no json", repos)).toBeNull();
  });

  it("accepts a brief with no repos (repo stays undecided)", () => {
    expect(parsePriorContextAnalysis('{"brief":"continue in the same place"}', repos)).toEqual({
      repos: [],
      brief: "continue in the same place",
    });
  });
});

describe("isSubstantiveComment", () => {
  const c = (body: string, author: string | null = "George Lazu") => ({ body, author, createdAt: "" });

  it("keeps the Apex plan, verdicts, and user steering", () => {
    expect(isSubstantiveComment(c("## 🧭 Apex plan\n\n- **Prism** — Fix the events settings UI…", "Vasile"))).toBe(true);
    expect(isSubstantiveComment(c("this is not a segment specific issue, but a disabledEvents setting issue - it's not modified correctly at the UI level"))).toBe(true);
    expect(isSubstantiveComment(c("i think the bug is in ld-shopify, and it's likely related to how we have one general events page component per destination"))).toBe(true);
    expect(isSubstantiveComment(c("**[main]** Read CORE-1740. Plan:\n\n1. Trace where Segment disabledEvents is stored…", "Vasile"))).toBe(true);
  });

  it("drops the bot's own gate prompts, system markers, and stop/error noise", () => {
    expect(isSubstantiveComment(c("This thread is for an agent session with vasile.", null))).toBe(false);
    expect(isSubstantiveComment(c("Please reply with an option:\n- Resume — continue prior work (resume)\n- Start fresh (fresh)", "Vasile"))).toBe(false);
    expect(isSubstantiveComment(c("**Input needed to continue**\n\nOpen the Vasile agent session.", "Vasile"))).toBe(false);
    expect(isSubstantiveComment(c("Which repo should CORE-1740 be implemented in? Recommended: shopify-tracker", "Vasile"))).toBe(false);
    expect(isSubstantiveComment(c("🛑 Stop received for CORE-1740 — no active work was running; cleared any pending dispatch state.", "Vasile"))).toBe(false);
    expect(isSubstantiveComment(c("**[main]** Something went wrong while processing this. The system will retry automatically if possible.", "Vasile"))).toBe(false);
    expect(isSubstantiveComment(c("**[main]** ⚠️ 🛠️ `command -v cli_codex || true` failed", "Vasile"))).toBe(false);
  });

  it("drops pure one-word gate replies but keeps a repo-name reply", () => {
    expect(isSubstantiveComment(c("resume"))).toBe(false);
    expect(isSubstantiveComment(c("fresh"))).toBe(false);
    expect(isSubstantiveComment(c("yes"))).toBe(false);
    expect(isSubstantiveComment(c("ld-shopify"))).toBe(true);
    expect(isSubstantiveComment(c("   "))).toBe(false);
  });
});
