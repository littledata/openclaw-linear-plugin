import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDispatchState,
  registerDispatch,
  transitionDispatch,
  completeDispatch,
  updateDispatchStatus,
  updateDispatchProgress,
  getActiveDispatch,
  listActiveDispatches,
  listStaleDispatches,
  listRecoverableDispatches,
  registerSessionMapping,
  lookupSessionMapping,
  removeSessionMapping,
  markEventProcessed,
  pruneCompleted,
  pruneCompletedDispatches,
  removeActiveDispatch,
  TransitionError,
  type ActiveDispatch,
} from "./dispatch-state.js";

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claw-ds-"));
  return join(dir, "state.json");
}

function makeDispatch(overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "uuid-1",
    issueIdentifier: "API-100",
    worktreePath: "/tmp/wt/API-100",
    branch: "codex/API-100",
    tier: "small",
    model: "test-model",
    status: "dispatched",
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Read / Register
// ---------------------------------------------------------------------------

describe("readDispatchState", () => {
  it("returns empty state when file missing", async () => {
    const p = tmpStatePath();
    const state = await readDispatchState(p);
    expect(state.version).toBe(2);
    expect(state.dispatches.active).toEqual({});
    expect(state.dispatches.completed).toEqual({});
    expect(state.sessionMap).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });

  it("recovers from corrupted state file", async () => {
    const p = tmpStatePath();
    // Write invalid JSON
    writeFileSync(p, "{{{{not valid json!!!!", "utf-8");
    const state = await readDispatchState(p);
    expect(state.version).toBe(2);
    expect(state.dispatches.active).toEqual({});
    expect(state.dispatches.completed).toEqual({});
    expect(state.sessionMap).toEqual({});
    expect(state.processedEvents).toEqual([]);
    // Corrupted file should have been renamed
    const dir = join(p, "..");
    const files = readdirSync(dir);
    const corrupted = files.filter((f: string) => f.includes(".corrupted."));
    expect(corrupted.length).toBe(1);
  });
});

describe("registerDispatch", () => {
  it("registers and reads back", async () => {
    const p = tmpStatePath();
    const d = makeDispatch();
    await registerDispatch("API-100", d, p);
    const state = await readDispatchState(p);
    const active = getActiveDispatch(state, "API-100");
    expect(active).not.toBeNull();
    expect(active!.issueIdentifier).toBe("API-100");
    expect(active!.attempt).toBe(0);
  });

  it("sets attempt=0 default", async () => {
    const p = tmpStatePath();
    const d = makeDispatch();
    (d as any).attempt = undefined;
    await registerDispatch("API-100", d, p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "API-100")!.attempt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CAS transitions
// ---------------------------------------------------------------------------

describe("transitionDispatch", () => {
  it("dispatched → working", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    const updated = await transitionDispatch("API-100", "dispatched", "working", undefined, p);
    expect(updated.status).toBe("working");
  });

  it("working → auditing", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    const updated = await transitionDispatch("API-100", "working", "auditing", undefined, p);
    expect(updated.status).toBe("auditing");
  });

  it("auditing → done", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "auditing" }), p);
    const updated = await transitionDispatch("API-100", "auditing", "done", undefined, p);
    expect(updated.status).toBe("done");
  });

  it("auditing → working (rework) with attempt update", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "auditing", attempt: 0 }), p);
    const updated = await transitionDispatch("API-100", "auditing", "working", { attempt: 1 }, p);
    expect(updated.status).toBe("working");
    expect(updated.attempt).toBe(1);
  });

  it("throws TransitionError when fromStatus mismatch", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    await expect(
      transitionDispatch("API-100", "dispatched", "working", undefined, p),
    ).rejects.toThrow(TransitionError);
  });

  it("throws on invalid transition", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "done" }), p);
    await expect(
      transitionDispatch("API-100", "done", "working", undefined, p),
    ).rejects.toThrow();
  });

  it("throws when dispatch missing", async () => {
    const p = tmpStatePath();
    await expect(
      transitionDispatch("MISSING-1", "dispatched", "working", undefined, p),
    ).rejects.toThrow("No active dispatch");
  });

  it("applies stuckReason", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    const updated = await transitionDispatch(
      "API-100", "working", "stuck", { stuckReason: "watchdog_kill_2x" }, p,
    );
    expect(updated.status).toBe("stuck");
    expect(updated.stuckReason).toBe("watchdog_kill_2x");
  });

  it("applies session key updates", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "dispatched" }), p);
    const updated = await transitionDispatch(
      "API-100", "dispatched", "working",
      { workerSessionKey: "sess-w-1" }, p,
    );
    expect(updated.workerSessionKey).toBe("sess-w-1");
  });
});

// ---------------------------------------------------------------------------
// Session mapping
// ---------------------------------------------------------------------------

describe("session mapping", () => {
  it("register + lookup round-trip", async () => {
    const p = tmpStatePath();
    await registerSessionMapping("sess-1", {
      dispatchId: "API-100",
      phase: "worker",
      attempt: 0,
    }, p);
    const state = await readDispatchState(p);
    const mapping = lookupSessionMapping(state, "sess-1");
    expect(mapping).not.toBeNull();
    expect(mapping!.dispatchId).toBe("API-100");
    expect(mapping!.phase).toBe("worker");
  });

  it("lookup returns null for unknown key", async () => {
    const p = tmpStatePath();
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "no-such")).toBeNull();
  });

  it("removeSessionMapping deletes", async () => {
    const p = tmpStatePath();
    await registerSessionMapping("sess-1", {
      dispatchId: "API-100",
      phase: "worker",
      attempt: 0,
    }, p);
    await removeSessionMapping("sess-1", p);
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "sess-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("markEventProcessed", () => {
  it("returns true (new) first call", async () => {
    const p = tmpStatePath();
    const isNew = await markEventProcessed("evt-1", p);
    expect(isNew).toBe(true);
  });

  it("returns false (dupe) second call", async () => {
    const p = tmpStatePath();
    await markEventProcessed("evt-1", p);
    const isDupe = await markEventProcessed("evt-1", p);
    expect(isDupe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complete dispatch
// ---------------------------------------------------------------------------

describe("completeDispatch", () => {
  it("moves active → completed", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    await completeDispatch("API-100", {
      tier: "small",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "API-100")).toBeNull();
    expect(state.dispatches.completed["API-100"]).toBeDefined();
    expect(state.dispatches.completed["API-100"].status).toBe("done");
  });

  it("cleans up session mappings for the dispatch", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    await registerSessionMapping("sess-w", { dispatchId: "API-100", phase: "worker", attempt: 0 }, p);
    await registerSessionMapping("sess-a", { dispatchId: "API-100", phase: "audit", attempt: 0 }, p);
    await completeDispatch("API-100", {
      tier: "small",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "sess-w")).toBeNull();
    expect(lookupSessionMapping(state, "sess-a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

describe("listStaleDispatches", () => {
  it("returns old dispatches", async () => {
    const p = tmpStatePath();
    const oldDate = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // 3 hours ago
    await registerDispatch("OLD-1", makeDispatch({
      issueIdentifier: "OLD-1",
      dispatchedAt: oldDate,
    }), p);
    const state = await readDispatchState(p);
    const stale = listStaleDispatches(state, 2 * 60 * 60_000); // 2h threshold
    expect(stale).toHaveLength(1);
    expect(stale[0].issueIdentifier).toBe("OLD-1");
  });

  it("excludes recent dispatches", async () => {
    const p = tmpStatePath();
    await registerDispatch("NEW-1", makeDispatch({ issueIdentifier: "NEW-1" }), p);
    const state = await readDispatchState(p);
    const stale = listStaleDispatches(state, 2 * 60 * 60_000);
    expect(stale).toHaveLength(0);
  });

  it("excludes paused and already-stuck dispatches regardless of age", async () => {
    const p = tmpStatePath();
    const oldDate = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await registerDispatch("PAUSED-OLD", makeDispatch({
      issueIdentifier: "PAUSED-OLD",
      status: "paused",
      dispatchedAt: oldDate,
      pausedAt: new Date().toISOString(),
    }), p);
    await registerDispatch("STUCK-OLD", makeDispatch({
      issueIdentifier: "STUCK-OLD",
      status: "stuck",
      dispatchedAt: oldDate,
      stuckReason: "manual",
    }), p);

    const state = await readDispatchState(p);
    expect(listStaleDispatches(state, 2 * 60 * 60_000)).toEqual([]);
  });
});

describe("listRecoverableDispatches", () => {
  it("returns working + workerKey - no auditKey", async () => {
    const p = tmpStatePath();
    await registerDispatch("REC-1", makeDispatch({
      issueIdentifier: "REC-1",
      status: "working",
      workerSessionKey: "sess-w",
    }), p);
    const state = await readDispatchState(p);
    const rec = listRecoverableDispatches(state);
    expect(rec).toHaveLength(1);
  });

  it("excludes dispatches with auditKey", async () => {
    const p = tmpStatePath();
    await registerDispatch("REC-2", makeDispatch({
      issueIdentifier: "REC-2",
      status: "working",
      workerSessionKey: "sess-w",
      auditSessionKey: "sess-a",
    }), p);
    const state = await readDispatchState(p);
    expect(listRecoverableDispatches(state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prune completed
// ---------------------------------------------------------------------------

describe("pruneCompleted", () => {
  it("removes old entries", async () => {
    const p = tmpStatePath();
    await registerDispatch("DONE-1", makeDispatch({ issueIdentifier: "DONE-1" }), p);
    await completeDispatch("DONE-1", {
      tier: "small",
      status: "done",
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(), // 2 days ago
    }, p);
    const pruned = await pruneCompleted(24 * 60 * 60_000, p); // 1 day threshold
    expect(pruned).toBe(1);
  });

  it("preserves recent entries", async () => {
    const p = tmpStatePath();
    await registerDispatch("DONE-2", makeDispatch({ issueIdentifier: "DONE-2" }), p);
    await completeDispatch("DONE-2", {
      tier: "small",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const pruned = await pruneCompleted(24 * 60 * 60_000, p);
    expect(pruned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migration", () => {
  it("migrates v1 state to v2 (adds version, sessionMap, processedEvents)", async () => {
    const p = tmpStatePath();
    // Write v1 state with no v2 fields (no version field)
    writeFileSync(p, JSON.stringify({
      dispatches: {
        active: { "X-1": makeDispatch({ issueIdentifier: "X-1" }) },
        completed: {},
      },
    }), "utf-8");
    const state = await readDispatchState(p);
    expect(state.version).toBe(2);
    expect(state.sessionMap).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });

  it('migrates "running" → "working"', async () => {
    const p = tmpStatePath();
    const d = makeDispatch({ issueIdentifier: "X-2" });
    (d as any).status = "running"; // old v1 status
    writeFileSync(p, JSON.stringify({
      dispatches: { active: { "X-2": d }, completed: {} },
      sessionMap: {},
      processedEvents: [],
    }), "utf-8");
    const state = await readDispatchState(p);
    expect(state.version).toBe(2);
    expect(getActiveDispatch(state, "X-2")!.status).toBe("working");
  });

  it("rejects unknown version", async () => {
    const p = tmpStatePath();
    writeFileSync(p, JSON.stringify({
      version: 99,
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    }), "utf-8");
    await expect(readDispatchState(p)).rejects.toThrow("Unknown dispatch state version: 99");
  });

  it("passes through v2 state unchanged", async () => {
    const p = tmpStatePath();
    const d = makeDispatch({ issueIdentifier: "X-3" });
    writeFileSync(p, JSON.stringify({
      version: 2,
      dispatches: { active: { "X-3": d }, completed: {} },
      sessionMap: {},
      processedEvents: ["evt-old"],
    }), "utf-8");
    const state = await readDispatchState(p);
    expect(state.version).toBe(2);
    expect(getActiveDispatch(state, "X-3")).not.toBeNull();
    expect(state.processedEvents).toEqual(["evt-old"]);
  });
});

describe("updateDispatchProgress", () => {
  it("preserves dispatch identity while pausing and resuming a phase", async () => {
    const p = tmpStatePath();
    await registerDispatch("PAUSE-1", makeDispatch({
      issueIdentifier: "PAUSE-1",
      agentSessionId: "linear-session-1",
      containerName: "openclaw-linear-PAUSE-1",
      containerRepos: ["api", "frontend"],
    }), p);

    const paused = await updateDispatchProgress("PAUSE-1", {
      status: "paused",
      phaseIndex: 1,
      pausedAt: "2026-07-14T20:00:00.000Z",
      stuckReason: "stale_2h",
    }, p);
    expect(paused).toMatchObject({
      status: "paused",
      phaseIndex: 1,
      agentSessionId: "linear-session-1",
      containerName: "openclaw-linear-PAUSE-1",
      containerRepos: ["api", "frontend"],
    });

    const resumed = await updateDispatchProgress("PAUSE-1", {
      status: "working",
      pausedAt: null,
      stuckReason: null,
    }, p);
    expect(resumed?.status).toBe("working");
    expect(resumed?.pausedAt).toBeUndefined();
    expect(resumed?.stuckReason).toBeUndefined();
    expect(resumed?.phaseIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Remove active dispatch
// ---------------------------------------------------------------------------

describe("removeActiveDispatch", () => {
  it("removes dispatch and cleans session mappings", async () => {
    const p = tmpStatePath();
    await registerDispatch("RM-1", makeDispatch({ issueIdentifier: "RM-1" }), p);
    await registerSessionMapping("sess-rm", { dispatchId: "RM-1", phase: "worker", attempt: 0 }, p);
    await removeActiveDispatch("RM-1", p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "RM-1")).toBeNull();
    expect(lookupSessionMapping(state, "sess-rm")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pruneCompletedDispatches (convenience wrapper)
// ---------------------------------------------------------------------------

describe("pruneCompletedDispatches", () => {
  it("prunes old completed dispatches", async () => {
    const p = tmpStatePath();
    // Create and complete a dispatch with a timestamp 10 days ago
    await registerDispatch("OLD-GC", makeDispatch({ issueIdentifier: "OLD-GC" }), p);
    await completeDispatch("OLD-GC", {
      tier: "small",
      status: "done",
      completedAt: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(), // 10 days ago
    }, p);
    // Also add a recent completed dispatch
    await registerDispatch("NEW-GC", makeDispatch({ issueIdentifier: "NEW-GC" }), p);
    await completeDispatch("NEW-GC", {
      tier: "high",
      status: "done",
      completedAt: new Date().toISOString(), // now
    }, p);

    // Prune with 7-day default
    const pruned = await pruneCompletedDispatches(7 * 24 * 60 * 60_000, p);
    expect(pruned).toBe(1);

    // Verify old one gone, recent one survives
    const state = await readDispatchState(p);
    expect(state.dispatches.completed["OLD-GC"]).toBeUndefined();
    expect(state.dispatches.completed["NEW-GC"]).toBeDefined();
  });

  it("preserves recent completed dispatches", async () => {
    const p = tmpStatePath();
    await registerDispatch("FRESH-1", makeDispatch({ issueIdentifier: "FRESH-1" }), p);
    await completeDispatch("FRESH-1", {
      tier: "small",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    await registerDispatch("FRESH-2", makeDispatch({ issueIdentifier: "FRESH-2" }), p);
    await completeDispatch("FRESH-2", {
      tier: "medium",
      status: "failed",
      completedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(), // 3 days ago
    }, p);

    const pruned = await pruneCompletedDispatches(7 * 24 * 60 * 60_000, p);
    expect(pruned).toBe(0);

    const state = await readDispatchState(p);
    expect(state.dispatches.completed["FRESH-1"]).toBeDefined();
    expect(state.dispatches.completed["FRESH-2"]).toBeDefined();
  });
});
