import { describe, it, expect } from "vitest";
import { selectIdleExpired, type ContainerRecord } from "./container-registry.js";

function rec(over: Partial<ContainerRecord>): ContainerRecord {
  return {
    issueIdentifier: "CORE-1",
    containerName: "openclaw-linear-CORE-1",
    repos: ["ld-shopify"],
    branch: "core-1",
    createdAtMs: 0,
    lastUsedMs: 0,
    ...over,
  };
}

describe("selectIdleExpired", () => {
  const NOW = 1_000_000_000;
  const TTL = 24 * 60 * 60_000;

  it("expires containers idle longer than the TTL (by lastUsed, not creation)", () => {
    const fresh = rec({ issueIdentifier: "A", createdAtMs: 0, lastUsedMs: NOW - 1000 });
    const stale = rec({ issueIdentifier: "B", createdAtMs: 0, lastUsedMs: NOW - TTL - 1 });
    const out = selectIdleExpired([fresh, stale], NOW, TTL);
    expect(out.map((r) => r.issueIdentifier)).toEqual(["B"]);
  });

  it("keeps a long-lived container that was USED recently (sliding TTL)", () => {
    // Created 3 days ago but used a minute ago → must NOT be reaped.
    const r = rec({ createdAtMs: NOW - 3 * TTL, lastUsedMs: NOW - 60_000 });
    expect(selectIdleExpired([r], NOW, TTL)).toHaveLength(0);
  });

  it("falls back to createdAt when lastUsed is missing", () => {
    const r = rec({ createdAtMs: NOW - TTL - 1, lastUsedMs: NaN });
    expect(selectIdleExpired([r], NOW, TTL)).toHaveLength(1);
  });

  it("treats a non-finite timestamp as expired so it can't linger", () => {
    const r = rec({ createdAtMs: NaN, lastUsedMs: NaN });
    expect(selectIdleExpired([r], NOW, TTL)).toHaveLength(1);
  });
});
