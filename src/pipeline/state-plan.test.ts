import { describe, it, expect } from "vitest";
import {
  resolveStatePlan,
  resolveTargetState,
  orchestrationMode,
  isReviewOnlyPlan,
  type StatePlan,
} from "./state-plan.js";

describe("orchestrationMode", () => {
  it("defaults to single", () => {
    expect(orchestrationMode()).toBe("single");
    expect(orchestrationMode({})).toBe("single");
  });
  it("returns stateplan when configured", () => {
    expect(orchestrationMode({ orchestrationMode: "stateplan" })).toBe("stateplan");
  });
});

describe("isReviewOnlyPlan", () => {
  it("distinguishes review/QA plans from implementation plans", () => {
    expect(isReviewOnlyPlan(resolveStatePlan({ name: "Code Review", type: "started" }))).toBe(true);
    expect(isReviewOnlyPlan(resolveStatePlan({ name: "QA", type: "started" }))).toBe(true);
    expect(isReviewOnlyPlan(resolveStatePlan({ name: "In Progress", type: "started" }))).toBe(false);
    expect(isReviewOnlyPlan(null)).toBe(false);
  });
});

describe("resolveStatePlan — built-in matchers", () => {
  it("maps In Progress → implement", () => {
    const p = resolveStatePlan({ name: "In Progress", type: "started" })!;
    expect(p.phases).toEqual([{ type: "plan-implement" }]);
    expect(p.onSuccess?.names).toContain("In Review");
    expect(p.onFailure?.names).toContain("In Progress");
    expect(p.clearDelegate).toBe(true);
  });

  it("maps Todo → implement", () => {
    const p = resolveStatePlan({ name: "Todo", type: "unstarted" })!;
    expect(p.phases[0].type).toBe("plan-implement");
  });

  it("maps In Review → code-review gates (checked before implement)", () => {
    const p = resolveStatePlan({ name: "In Review", type: "started" })!;
    expect(p.phases.map((x) => x.role)).toEqual(["warden", "apex"]);
    expect(p.phases.every((x) => x.gate)).toBe(true);
    expect(p.onSuccess?.names).toContain("QA");
    expect(p.onFailure?.names).toContain("In Progress");
  });

  it("maps QA → proof (checked before implement even though type=started)", () => {
    const p = resolveStatePlan({ name: "QA", type: "started" })!;
    expect(p.phases).toEqual([{ type: "review", role: "proof", gate: true }]);
    expect(p.onSuccess?.names).toContain("Done");
  });

  it("returns null for Done / unmatched", () => {
    expect(resolveStatePlan({ name: "Done", type: "completed" })).toBeNull();
    expect(resolveStatePlan({ name: "Canceled", type: "canceled" })).toBeNull();
  });
});

describe("resolveStatePlan — config override", () => {
  const cfg = {
    statePlans: {
      "in progress": {
        phases: ["plan-implement", "warden"],
        onSuccess: "Ready for Review",
        onFailure: ["Coding", "In Progress"],
        clearDelegate: false,
      },
      Shipping: {
        phases: [{ type: "product", role: "lumen" }],
      },
    },
  };

  it("overrides a built-in state by exact name (case-insensitive)", () => {
    const p = resolveStatePlan({ name: "In Progress", type: "started" }, cfg)!;
    expect(p.phases).toEqual([
      { type: "plan-implement" },
      { type: "review", role: "warden", gate: true },
    ]);
    expect(p.onSuccess?.names).toEqual(["Ready for Review"]);
    expect(p.onFailure?.names).toEqual(["Coding", "In Progress"]);
    expect(p.clearDelegate).toBe(false);
  });

  it("adds a plan for a custom state name", () => {
    const p = resolveStatePlan({ name: "Shipping", type: "started" }, cfg)!;
    expect(p.phases).toEqual([{ type: "product", role: "lumen" }]);
  });

  it("treats a bare product role id as a product phase", () => {
    const p = resolveStatePlan(
      { name: "Discovery", type: "backlog" },
      { statePlans: { Discovery: { phases: ["helm"] } } },
    )!;
    expect(p.phases).toEqual([{ type: "product", role: "helm" }]);
  });

  it("falls back to matcher when config plan has no usable phases", () => {
    const p = resolveStatePlan(
      { name: "In Progress", type: "started" },
      { statePlans: { "In Progress": { phases: [] } } },
    )!;
    expect(p.phases[0].type).toBe("plan-implement");
  });
});

describe("resolveTargetState", () => {
  const states = [
    { id: "s1", name: "In Progress", type: "started" },
    { id: "s2", name: "In Review", type: "started" },
    { id: "s3", name: "Done", type: "completed" },
  ];

  it("matches by name first", () => {
    expect(resolveTargetState({ names: ["In Review"] }, states)).toEqual({ id: "s2", name: "In Review" });
  });

  it("contains-matches a longer board state name (Review → Design Review)", () => {
    const board = [
      { id: "a", name: "In Progress", type: "started" },
      { id: "b", name: "Design Review", type: "started" },
    ];
    expect(resolveTargetState({ names: ["In Review", "Code Review", "Review"] }, board)).toEqual({
      id: "b",
      name: "Design Review",
    });
  });

  it("prefers an exact match over a contains match", () => {
    const board = [
      { id: "a", name: "Design Review", type: "started" },
      { id: "b", name: "Review", type: "started" },
    ];
    expect(resolveTargetState({ names: ["Review"] }, board)).toEqual({ id: "b", name: "Review" });
  });

  it("falls back to type when no name matches", () => {
    expect(resolveTargetState({ names: ["Nope"], type: "completed" }, states)).toEqual({
      id: "s3",
      name: "Done",
    });
  });

  it("returns null when nothing matches", () => {
    expect(resolveTargetState({ names: ["Nope"] }, states)).toBeNull();
  });

  it("returns null for a null target", () => {
    expect(resolveTargetState(null, states)).toBeNull();
  });
});
