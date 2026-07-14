import { describe, it, expect } from "vitest";
import { parseGrillStep } from "./grill.js";

describe("parseGrillStep", () => {
  it("parses a question step", () => {
    expect(parseGrillStep('{"question":"Which repo? (rec: events-manager)"}'))
      .toEqual({ ready: false, question: "Which repo? (rec: events-manager)" });
  });

  it("parses a ready step with guidance (repo is chosen elsewhere, ignored here)", () => {
    // The grill no longer selects repos; any `repos` in the output is ignored.
    expect(parseGrillStep('{"ready":true,"repos":["events-manager"],"guidance":"Fix X in Y"}'))
      .toEqual({ ready: true, guidance: "Fix X in Y" });
  });

  it("handles markdown-fenced JSON", () => {
    const r = parseGrillStep('```json\n{"ready":true,"guidance":"g"}\n```');
    expect(r?.ready).toBe(true);
    expect(r?.guidance).toBe("g");
  });

  it("defaults guidance on a bare ready", () => {
    expect(parseGrillStep('{"ready":true}')).toEqual({ ready: true, guidance: "" });
  });

  it("returns null for unparseable or empty-question output", () => {
    expect(parseGrillStep("no json here")).toBeNull();
    expect(parseGrillStep('{"question":""}')).toBeNull();
    expect(parseGrillStep('{"foo":"bar"}')).toBeNull();
  });

  it("parses a question with discrete options", () => {
    expect(parseGrillStep('{"question":"Which repo? (rec: ld-shopify)","options":["ld-shopify","tmv2"]}'))
      .toEqual({ ready: false, question: "Which repo? (rec: ld-shopify)", options: ["ld-shopify", "tmv2"] });
  });

  it("omits options when the array is absent or has no usable entries", () => {
    expect(parseGrillStep('{"question":"open?"}')).toEqual({ ready: false, question: "open?" });
    expect(parseGrillStep('{"question":"open?","options":[" ",3,null]}'))
      .toEqual({ ready: false, question: "open?" });
  });
});
