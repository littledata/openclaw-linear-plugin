import { describe, it, expect } from "vitest";
import { requestCancel, isCancelled, clearCancel } from "./cancellation.js";

describe("cancellation registry", () => {
  it("is not cancelled by default", () => {
    expect(isCancelled("issue-none")).toBe(false);
  });
  it("flags and clears an issue", () => {
    requestCancel("issue-a");
    expect(isCancelled("issue-a")).toBe(true);
    clearCancel("issue-a");
    expect(isCancelled("issue-a")).toBe(false);
  });
  it("tracks issues independently", () => {
    requestCancel("issue-b");
    expect(isCancelled("issue-b")).toBe(true);
    expect(isCancelled("issue-c")).toBe(false);
    clearCancel("issue-b");
  });
});
