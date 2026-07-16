import { describe, it, expect } from "vitest";
import {
  codingEnabled,
  conversationalEnabled,
  conversationalConfig,
  conversationalCommentReply,
  triageConfig,
  triageEnabled,
} from "./mode-config.js";

describe("mode-config", () => {
  it("defaults both capabilities ON when unconfigured (back-compat)", () => {
    expect(codingEnabled(undefined)).toBe(true);
    expect(codingEnabled({})).toBe(true);
    expect(conversationalEnabled(undefined)).toBe(true);
    expect(conversationalEnabled({})).toBe(true);
  });

  it("coding profile: coding on, conversational off", () => {
    const cfg = { coding: { enabled: true }, conversational: { enabled: false } };
    expect(codingEnabled(cfg)).toBe(true);
    expect(conversationalEnabled(cfg)).toBe(false);
  });

  it("main profile: coding off, conversational on", () => {
    const cfg = { coding: { enabled: false }, conversational: { enabled: true } };
    expect(codingEnabled(cfg)).toBe(false);
    expect(conversationalEnabled(cfg)).toBe(true);
  });

  it("only enabled:false disables — other/absent values stay ON", () => {
    expect(codingEnabled({ coding: {} })).toBe(true);
    expect(conversationalEnabled({ conversational: { agentId: "main" } })).toBe(true);
    expect(codingEnabled({ coding: { enabled: false } })).toBe(false);
  });

  it("exposes conversational settings and dual comment-reply default (off)", () => {
    expect(conversationalConfig({ conversational: { agentId: "main" } }).agentId).toBe("main");
    // Default OFF: the session `response` activity already posts the threaded
    // comment, so dual output must be explicitly opted into.
    expect(conversationalCommentReply(undefined)).toBe(false);
    expect(conversationalCommentReply({ conversational: { commentReply: false } })).toBe(false);
    expect(conversationalCommentReply({ conversational: { commentReply: true } })).toBe(true);
  });

  it("keeps triage opt-in and exposes its agent", () => {
    expect(triageEnabled(undefined)).toBe(false);
    expect(triageEnabled({ triage: { enabled: false } })).toBe(false);
    expect(triageEnabled({ triage: { enabled: true, agentId: "sift" } })).toBe(true);
    expect(triageConfig({ triage: { agentId: "sift" } }).agentId).toBe("sift");
  });
});
