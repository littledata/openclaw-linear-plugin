import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIER_MODELS, resolveTierModels, assessTier, type IssueContext } from "./tier-assess.js";

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------

const mockRunAgent = vi.fn();

vi.mock("../agent/agent.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(overrides?: { defaultAgentId?: string }) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pluginConfig: {
      defaultAgentId: overrides?.defaultAgentId,
    },
  } as any;
}

function makeIssue(overrides?: Partial<IssueContext>): IssueContext {
  return {
    identifier: "CT-123",
    title: "Fix login bug",
    description: "Users cannot log in when using SSO",
    labels: ["bug"],
    commentCount: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TIER_MODELS", () => {
  it("maps small to haiku, medium to sonnet, high to opus", () => {
    expect(TIER_MODELS.small).toBe("anthropic/claude-haiku-4-5");
    expect(TIER_MODELS.medium).toBe("anthropic/claude-sonnet-4-6");
    expect(TIER_MODELS.high).toBe("anthropic/claude-opus-4-6");
  });
});

describe("assessTier", () => {
  beforeEach(() => {
    mockRunAgent.mockReset();
  });

  it("returns parsed tier from agent response", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"high","reasoning":"Multi-service architecture change"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("high");
    expect(result.model).toBe(TIER_MODELS.high);
    expect(result.reasoning).toBe("Multi-service architecture change");
    expect(api.logger.info).toHaveBeenCalled();
  });

  it("falls back to medium when agent fails (success: false) with no parseable JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      output: "Agent process exited with code 1",
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medium");
    expect(result.model).toBe(TIER_MODELS.medium);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medium");
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("falls back to medium when output has no JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: "I think this is a medium complexity issue because it involves multiple files.",
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medium");
    expect(result.model).toBe(TIER_MODELS.medium);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medium");
  });

  it("falls back to medium when JSON has invalid tier", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"expert","reasoning":"Very hard problem"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medium");
    expect(result.model).toBe(TIER_MODELS.medium);
  });

  it("handles agent throwing an error", async () => {
    mockRunAgent.mockRejectedValue(new Error("Connection refused"));

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medium");
    expect(result.model).toBe(TIER_MODELS.medium);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medium");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Tier assessment error for CT-123"),
    );
  });

  it("truncates long descriptions to 1500 chars", async () => {
    const longDescription = "A".repeat(3000);
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"small","reasoning":"Simple copy change"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue({ description: longDescription }));

    // Verify the message sent to runAgent has the description truncated
    const callArgs = mockRunAgent.mock.calls[0][0];
    const message: string = callArgs.message;
    // The description in the prompt should be at most 1500 chars of the original
    // "Description: " prefix + 1500 chars = the truncated form
    expect(message).toContain("Description: " + "A".repeat(1500));
    expect(message).not.toContain("A".repeat(1501));
  });

  it("uses configured agentId when provided", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"small","reasoning":"Typo fix"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue(), "kaylee");

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.agentId).toBe("kaylee");
  });

  it("parses JSON even when wrapped in markdown fences", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '```json\n{"tier":"small","reasoning":"Config tweak"}\n```',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("small");
    expect(result.model).toBe(TIER_MODELS.small);
    expect(result.reasoning).toBe("Config tweak");
  });

  it("handles null description gracefully", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"small","reasoning":"Trivial"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue({ description: null }));

    expect(result.tier).toBe("small");
  });

  it("handles empty labels and no comments", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medium","reasoning":"Standard feature"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue({ labels: [], commentCount: undefined }));

    expect(result.tier).toBe("medium");
  });

  it("falls back to medium on malformed JSON (half JSON)", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"seni',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medium");
    expect(result.reasoning).toBe("Assessment failed — defaulting to medium");
  });

  it("provides default reasoning when missing from response", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"high"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("high");
    expect(result.reasoning).toBe("no reasoning provided");
  });

  it("extracts JSON from output with success=false but valid JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      output: 'Agent exited early but: {"tier":"small","reasoning":"Simple fix"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("small");
    expect(result.reasoning).toBe("Simple fix");
  });

  it("defaults agentId from pluginConfig when not passed", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medium","reasoning":"Normal"}',
    });

    const api = makeApi({ defaultAgentId: "zoe" });
    await assessTier(api, makeIssue());

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.agentId).toBe("zoe");
  });

  it("uses 30s timeout for assessment", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medium","reasoning":"Normal"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue());

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.timeoutMs).toBe(30_000);
  });
});

describe("resolveTierModels", () => {
  it("returns built-in defaults when no config is given", () => {
    expect(resolveTierModels(undefined)).toEqual(TIER_MODELS);
    expect(resolveTierModels({})).toEqual(TIER_MODELS);
  });

  it("applies per-tier overrides from config", () => {
    const resolved = resolveTierModels({
      tierModels: { small: "openai/gpt-5.5", high: "openai/gpt-5.6-sol" },
    });
    expect(resolved.small).toBe("openai/gpt-5.5");
    expect(resolved.high).toBe("openai/gpt-5.6-sol");
    // Unset tier falls back to the built-in default
    expect(resolved.medium).toBe(TIER_MODELS.medium);
  });

  it("overrides all three tiers", () => {
    const resolved = resolveTierModels({
      tierModels: { small: "a", medium: "b", high: "c" },
    });
    expect(resolved).toEqual({ small: "a", medium: "b", high: "c" });
  });
});
