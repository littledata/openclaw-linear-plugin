import { describe, it, expect } from "vitest";
import { parseRepoSelection } from "./repo-selection-state.js";

describe("parseRepoSelection", () => {
  const candidates = ["api", "frontend", "worker"];

  it("parses 1-based numbers", () => {
    expect(parseRepoSelection("1", candidates)).toEqual(["api"]);
    expect(parseRepoSelection("2,3", candidates)).toEqual(["frontend", "worker"]);
    expect(parseRepoSelection("2 3", candidates)).toEqual(["frontend", "worker"]);
  });

  it("parses names case-insensitively", () => {
    expect(parseRepoSelection("API", candidates)).toEqual(["api"]);
    expect(parseRepoSelection("frontend, worker", candidates)).toEqual(["frontend", "worker"]);
  });

  it("handles all/both keywords", () => {
    expect(parseRepoSelection("all", candidates)).toEqual(candidates);
    expect(parseRepoSelection("both please", candidates)).toEqual(candidates);
    expect(parseRepoSelection("everything", candidates)).toEqual(candidates);
  });

  it("mixes numbers and names and de-duplicates", () => {
    expect(parseRepoSelection("1, api, 2", candidates)).toEqual(["api", "frontend"]);
  });

  it("returns empty for unrecognized input", () => {
    expect(parseRepoSelection("banana", candidates)).toEqual([]);
    expect(parseRepoSelection("9", candidates)).toEqual([]);
    expect(parseRepoSelection("0", candidates)).toEqual([]);
    expect(parseRepoSelection("", candidates)).toEqual([]);
  });
});
