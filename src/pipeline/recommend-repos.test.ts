import { describe, it, expect } from "vitest";
import { parseRecommendation } from "./recommend-repos.js";

const REPOS = ["ld-shopify", "shopify-tracker", "transaction-monitor-2", "ld-shopify-admin"];

describe("parseRecommendation", () => {
  it("parses a clean JSON object", () => {
    const out = parseRecommendation(
      '{"repos":["ld-shopify","shopify-tracker"],"reasoning":"Storefront tracking bug."}',
      REPOS,
    );
    expect(out).toEqual({ repos: ["ld-shopify", "shopify-tracker"], reasoning: "Storefront tracking bug." });
  });

  it("extracts JSON from markdown/prose wrapping", () => {
    const out = parseRecommendation(
      'Here is my answer:\n```json\n{"repos":["transaction-monitor-2"],"reasoning":"Pipeline change."}\n```',
      REPOS,
    );
    expect(out?.repos).toEqual(["transaction-monitor-2"]);
  });

  it("drops names that are not configured repos", () => {
    const out = parseRecommendation(
      '{"repos":["ld-shopify","not-a-repo","shopify-tracker"],"reasoning":"x"}',
      REPOS,
    );
    expect(out?.repos).toEqual(["ld-shopify", "shopify-tracker"]);
  });

  it("returns null when there is no JSON object", () => {
    expect(parseRecommendation("I am not sure which repo.", REPOS)).toBeNull();
  });

  it("tolerates missing/invalid fields", () => {
    expect(parseRecommendation('{"reasoning":"no repos key"}', REPOS)).toEqual({ repos: [], reasoning: "no repos key" });
    expect(parseRecommendation('{"repos":"ld-shopify"}', REPOS)).toEqual({ repos: [], reasoning: "" });
  });

  it("returns empty repos (not null) for malformed JSON body", () => {
    expect(parseRecommendation("{ not valid json", REPOS)).toBeNull();
  });
});
