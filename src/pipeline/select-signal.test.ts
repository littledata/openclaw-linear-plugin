import { describe, it, expect } from "vitest";
import { repoSelectSignal, optionsSignal } from "./select-signal.js";
import { parseRepoSelection } from "./repo-selection-state.js";

describe("repoSelectSignal", () => {
  it("maps each candidate to a label/value option", () => {
    const s = repoSelectSignal(["ld-shopify", "tmv2"]);
    expect(s?.signal).toBe("select");
    expect(s?.signalMetadata.options.slice(0, 2)).toEqual([
      { label: "ld-shopify", value: "ld-shopify" },
      { label: "tmv2", value: "tmv2" },
    ]);
  });
  it('adds an "all" option when more than one candidate', () => {
    const s = repoSelectSignal(["a", "b"]);
    expect(s?.signalMetadata.options.some((o) => o.value === "all")).toBe(true);
  });
  it("omits the all option for a single candidate", () => {
    const s = repoSelectSignal(["only"]);
    expect(s?.signalMetadata.options).toEqual([{ label: "only", value: "only" }]);
  });
  it("returns undefined for no candidates", () => {
    expect(repoSelectSignal([])).toBeUndefined();
  });
  it("marks recommended labels without changing their values", () => {
    const s = repoSelectSignal(["ld-shopify", "tmv2"], ["ld-shopify"]);
    expect(s?.signalMetadata.options[0]).toEqual({
      label: "ld-shopify (recommended)",
      value: "ld-shopify",
    });
  });
});

describe("optionsSignal", () => {
  it("builds a select signal from answer choices", () => {
    const s = optionsSignal(["yes", "no"]);
    expect(s?.signal).toBe("select");
    expect(s?.signalMetadata.options).toEqual([
      { label: "yes", value: "yes" },
      { label: "no", value: "no" },
    ]);
  });
  it("returns undefined for empty/blank choices", () => {
    expect(optionsSignal([])).toBeUndefined();
    expect(optionsSignal(["  ", ""])).toBeUndefined();
  });
});

// The whole point of `select`: the returned value must survive the SAME reply
// parsers a typed answer hits, since Linear echoes it as a normal prompt.
describe("option values round-trip through existing reply parsers", () => {
  it("repo option values parse back to the same selection", () => {
    const cands = ["ld-shopify", "tmv2"];
    const s = repoSelectSignal(cands);
    for (const o of s!.signalMetadata.options) {
      const parsed = parseRepoSelection(o.value, cands);
      if (o.value === "all") expect(parsed).toEqual(cands);
      else expect(parsed).toEqual([o.value]);
    }
  });
});
