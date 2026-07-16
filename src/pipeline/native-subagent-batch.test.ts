import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetNativeSubagentBatchesForTesting,
  captureNativeSubagentGeneration,
  completeNativeSubagent,
  registerNativeSubagent,
  waitForNativeSubagentBatch,
} from "./native-subagent-batch.js";

describe("native subagent batches", () => {
  beforeEach(() => _resetNativeSubagentBatchesForTesting());

  it("returns immediately when the lead spawned no specialist", async () => {
    const generation = captureNativeSubagentGeneration("CORE-1");
    await expect(waitForNativeSubagentBatch("CORE-1", generation)).resolves.toEqual({
      spawned: false,
      timedOut: false,
      cancelled: false,
      outcomes: [],
    });
  });

  it("waits for every specialist spawned in the captured batch", async () => {
    const generation = captureNativeSubagentGeneration("CORE-2");
    registerNativeSubagent("CORE-2", "spine");
    registerNativeSubagent("CORE-2", "forge");
    const pending = waitForNativeSubagentBatch("CORE-2", generation, { timeoutMs: 2_000 });

    completeNativeSubagent("CORE-2", "spine", "ok", "backend done");
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    completeNativeSubagent("CORE-2", "forge", "ok", "infra done");
    await expect(pending).resolves.toEqual({
      spawned: true,
      timedOut: false,
      cancelled: false,
      outcomes: [
        expect.objectContaining({ key: "spine", outcome: "ok", detail: "backend done" }),
        expect.objectContaining({ key: "forge", outcome: "ok", detail: "infra done" }),
      ],
    });
  });

  it("reports timeout without confusing it with specialist completion", async () => {
    const generation = captureNativeSubagentGeneration("CORE-3");
    registerNativeSubagent("CORE-3", "spine");
    await expect(
      waitForNativeSubagentBatch("CORE-3", generation, { timeoutMs: 5 }),
    ).resolves.toEqual({
      spawned: true,
      timedOut: true,
      cancelled: false,
      outcomes: [],
    });
  });
});
