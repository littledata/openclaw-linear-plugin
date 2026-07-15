import { describe, it, expect } from "vitest";
import {
  codingEnabled,
  conversationalEnabled,
  conversationalConfig,
  conversationalCommentReply,
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

  it("exposes conversational settings and comment-reply default (on)", () => {
    expect(conversationalConfig({ conversational: { agentId: "main" } }).agentId).toBe("main");
    expect(conversationalCommentReply(undefined)).toBe(true);
    expect(conversationalCommentReply({ conversational: { commentReply: false } })).toBe(false);
    expect(conversationalCommentReply({ conversational: { commentReply: true } })).toBe(true);
  });
});
