import { describe, it, expect } from "vitest";
import { parseGrillStep } from "./grill.js";

describe("parseGrillStep", () => {
  it("parses a question step", () => {
    expect(parseGrillStep('{"question":"Which repo? (rec: events-manager)"}'))
      .toEqual({ ready: false, question: "Which repo? (rec: events-manager)" });
  });

  it("parses a ready step with repos + guidance", () => {
    expect(parseGrillStep('{"ready":true,"repos":["events-manager","shopify-tracker"],"guidance":"Fix X in Y"}'))
      .toEqual({ ready: true, repos: ["events-manager", "shopify-tracker"], guidance: "Fix X in Y" });
  });

  it("handles markdown-fenced JSON", () => {
    const r = parseGrillStep('```json\n{"ready":true,"repos":["a"],"guidance":"g"}\n```');
    expect(r?.ready).toBe(true);
    expect(r?.repos).toEqual(["a"]);
  });

  it("defaults repos/guidance on a bare ready", () => {
    expect(parseGrillStep('{"ready":true}')).toEqual({ ready: true, repos: undefined, guidance: "" });
  });

  it("filters non-string repos", () => {
    expect(parseGrillStep('{"ready":true,"repos":["ok",3,null]}').repos).toEqual(["ok"]);
  });

  it("returns null for unparseable or empty-question output", () => {
    expect(parseGrillStep("no json here")).toBeNull();
    expect(parseGrillStep('{"question":""}')).toBeNull();
    expect(parseGrillStep('{"foo":"bar"}')).toBeNull();
  });
});
