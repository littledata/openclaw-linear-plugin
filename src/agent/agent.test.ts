import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies so we can control runAgentOnce behavior
const mockRunEmbedded = vi.fn();
const mockRunSubprocess = vi.fn();
const mockGetExtensionAPI = vi.fn();
const mockResolveWatchdogConfig = vi.fn().mockReturnValue({
  inactivityMs: 120_000,
  maxTotalMs: 7_200_000,
  toolTimeoutMs: 600_000,
});

vi.mock("./watchdog.js", () => ({
  InactivityWatchdog: class {
    wasKilled = false;
    silenceMs = 0;
    start() {}
    tick() {}
    pause() {}
    resume() {}
    stop() {}
  },
  resolveWatchdogConfig: (...args: any[]) => mockResolveWatchdogConfig(...args),
}));

// We need to test the runAgent retry wrapper. Since runAgentOnce is internal,
// we test through runAgent by controlling the embedded/subprocess behavior.
// The simplest approach: mock the entire module internals via the extension API.

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("{}"),
    mkdirSync: vi.fn(),
  };
});

import {
  formatToolActivityParameter,
  formatToolActivityResult,
  formatToolActivityTitle,
  formatToolActivityValue,
  runAgent,
} from "./agent.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function createApi(): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      config: {
        loadConfig: vi.fn().mockReturnValue({ agents: { list: [] } }),
      },
      system: {
        runCommandWithTimeout: vi.fn().mockResolvedValue({
          code: 0,
          stdout: JSON.stringify({ result: { payloads: [{ text: "subprocess output" }] } }),
          stderr: "",
        }),
      },
    },
    pluginConfig: {},
  } as unknown as OpenClawPluginApi;
}

describe("runAgent subprocess", () => {
  it("extracts text from JSON payloads", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "hello" }, { text: "world" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("world");
  });

  it("uses raw stdout when JSON parsing fails", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "plain text output",
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("plain text output");
  });

  it("uses stderr when command fails with no stdout", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "error from stderr",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("error from stderr");
  });

  it("includes agentId in command arguments", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "my-agent",
      sessionId: "session-1",
      message: "test",
    });

    const args = runCmd.mock.calls[0][0];
    expect(args).toContain("my-agent");
    expect(args).toContain("--agent");
  });

  it("passes timeout in seconds to subprocess", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "test",
      sessionId: "session-1",
      message: "test",
      timeoutMs: 60_000,
    });

    const args: string[] = runCmd.mock.calls[0][0];
    const timeoutIdx = args.indexOf("--timeout");
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(args[timeoutIdx + 1]).toBe("60");
  });

  it("handles empty payloads array", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    // Falls back to raw stdout when no payload text
    expect(result.output).toBeTruthy();
  });

  it("handles null payloads text", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: null }, { text: "real" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("real");
  });
});

  it("extracts text from flat envelope (payloads at top level)", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ payloads: [{ text: "flat response" }], meta: {} }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("flat response");
  });

  it("strips plugin init log noise before JSON blob", async () => {
    const api = createApi();
    const noisyOutput = [
      "[plugins] Dispatch gateway methods registered",
      "[plugins] Linear agent extension registered (agent: zoe)",
      '[plugins] cli tools registered: cli_codex, cli_claude, cli_gemini (agent default: cli_codex)',
      JSON.stringify({ payloads: [{ text: "clean response" }], meta: {} }),
    ].join("\n");
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: noisyOutput,
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("clean response");
    expect(result.output).not.toContain("[plugins]");
    expect(result.output).not.toContain("payloads");
  });

describe("runAgent date/time injection", () => {
  it("injects current date/time into the message sent to subprocess", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "done" }] } }),
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "do something",
    });

    // The --message arg should contain the date context prefix
    const args: string[] = runCmd.mock.calls[0][0];
    const msgIdx = args.indexOf("--message");
    const passedMessage = args[msgIdx + 1];
    expect(passedMessage).toMatch(/^\[Current date\/time:.*\d{4}.*\]/);
    expect(passedMessage).toContain("do something");
  });

  it("includes ISO timestamp in the injected context", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test task",
    });

    const args: string[] = runCmd.mock.calls[0][0];
    const msgIdx = args.indexOf("--message");
    const passedMessage = args[msgIdx + 1];
    // Should contain ISO format like 2026-02-19T05:45:00.000Z
    expect(passedMessage).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("runAgent retry wrapper", () => {
  it("returns success on first attempt when no watchdog kill", async () => {
    const api = createApi();
    // Mock subprocess fallback (no streaming → uses subprocess)
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "done" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("done");
    // Should only call once
    expect((api.runtime.system as any).runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("returns failure without retry on normal (non-watchdog) failure", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "some error",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(false);
    expect(result.watchdogKilled).toBeUndefined();
    // Only one attempt — no retry for non-watchdog failures
    expect((api.runtime.system as any).runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("does not retry on success", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "all good" }] } }),
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(runCmd).toHaveBeenCalledOnce();
  });
});

describe("embedded tool activity projection", () => {
  it("emits one ephemeral start and one completed action paired by toolCallId", async () => {
    const api = createApi() as any;
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    const runEmbeddedPiAgent = vi.fn().mockImplementation(async (opts: any) => {
      expect(opts.shouldEmitToolResult()).toBe(false);
      expect(opts.shouldEmitToolOutput()).toBe(false);
      opts.onPartialReply({
        text: "I’m checking the local diff first so the review is based on the authoritative workspace.",
      });
      opts.onAgentEvent({
        stream: "tool",
        data: {
          phase: "start",
          name: "container_exec",
          toolCallId: "call-1",
          args: { command: "git diff", workdir: "/work/repo" },
        },
      });
      opts.onAgentToolResult({
        toolName: "container_exec",
        result: { success: true, stdout: "diff output" },
        isError: false,
      });
      opts.onAgentEvent({
        stream: "tool",
        data: { phase: "result", name: "container_exec", toolCallId: "call-1", isError: false },
      });
      return { payloads: [{ text: "REVIEW: pass" }], meta: { durationMs: 10 } };
    });
    api.runtime.agent = {
      defaults: { provider: "openrouter", model: "test-model" },
      runEmbeddedPiAgent,
    };

    const result = await runAgent({
      api,
      agentId: "apex",
      sessionId: "linear-apex-CORE-1-0",
      issueIdentifier: "CORE-1",
      message: "review",
      readOnly: true,
      streaming: { linearApi: { emitActivity } as any, agentSessionId: "linear-session" },
    });

    expect(result.success).toBe(true);
    expect(emitActivity).toHaveBeenCalledTimes(3);
    expect(emitActivity).toHaveBeenNthCalledWith(
      1,
      "linear-session",
      {
        type: "thought",
        body: "I’m checking the local diff first so the review is based on the authoritative workspace.",
      },
      undefined,
    );
    expect(emitActivity).toHaveBeenNthCalledWith(
      2,
      "linear-session",
      {
        type: "action",
        action: "Shell",
        parameter: "git diff",
      },
      { ephemeral: true },
    );
    expect(emitActivity).toHaveBeenNthCalledWith(
      3,
      "linear-session",
      expect.objectContaining({
        type: "action",
        action: "Shell",
        parameter: "git diff",
        result: "diff output",
      }),
      undefined,
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].extraSystemPrompt).toContain(
      "Repository shell commands are allowed only through the container_* tools",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].extraSystemPrompt).toContain(
      "LINEAR PROGRESS VISIBILITY",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].extraSystemPrompt).not.toContain("Do not run shell commands");
    expect(runEmbeddedPiAgent.mock.calls[0][0]).not.toHaveProperty("agentHarnessRuntimeOverride");
  });

  it("pretty-prints JSON and caps oversized values", () => {
    expect(formatToolActivityValue('{"a":1}', 100)).toBe('{\n  "a": 1\n}');
    expect(formatToolActivityValue("abcdefgh", 4)).toContain("abcd\n…(4 more characters)");
  });

  it("formats search and generic tool activities for Linear", () => {
    expect(formatToolActivityTitle("container_search_code")).toBe("Search Code");
    expect(formatToolActivityParameter("container_search_code", {
      query: "where are webhook events routed?",
      repo: "openclaw-linear-plugin",
      limit: 5,
    })).toBe("where are webhook events routed?");

    expect(formatToolActivityTitle("container_read_file")).toBe("Container Read File");
    expect(formatToolActivityTitle("fetch_pr-details-v2")).toBe("Fetch Pr Details V2");
    expect(formatToolActivityParameter("container_read_file", {
      path: "src/agent/agent.ts",
      repo: "openclaw-linear-plugin",
    })).toBe('{\n  "path": "src/agent/agent.ts",\n  "repo": "openclaw-linear-plugin"\n}');
  });

  it("extracts shell output from OpenClaw's structured tool result", () => {
    expect(formatToolActivityResult("container_exec", {
      content: [{
        type: "text",
        text: JSON.stringify({ success: true, exitCode: 0, stdout: "line one\nline two", stderr: "" }),
      }],
      details: { success: true, exitCode: 0, stdout: "line one\nline two", stderr: "" },
    }, false)).toBe("line one\nline two");
    expect(formatToolActivityResult("container_exec", {
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "command failed",
    }, true)).toBe("Failed\n\ncommand failed");
  });

  it("opts into the Codex harness, binds the stable session, and emits native input as elicitation", async () => {
    const api = createApi() as any;
    api.pluginConfig = {
      enableCodexHarnessSteering: true,
      codexHarnessModel: "openai/gpt-5.3-codex",
    };
    const emitActivity = vi.fn().mockResolvedValue(undefined);
    const upsertSessionEntry = vi.fn().mockResolvedValue(undefined);
    const runEmbeddedPiAgent = vi.fn().mockImplementation(async (opts: any) => {
      await opts.onBlockReply({ text: "Codex needs input:\n1. Use migration A\n2. Use migration B" });
      return { payloads: [{ text: "done" }], meta: { durationMs: 10 } };
    });
    api.runtime.agent = {
      defaults: { provider: "openrouter", model: "test-model" },
      session: { upsertSessionEntry },
      runEmbeddedPiAgent,
    };

    const result = await runAgent({
      api,
      agentId: "apex",
      sessionId: "linear-apex-CORE-1-0",
      message: "review",
      abortKey: "issue-1",
      streaming: { linearApi: { emitActivity } as any, agentSessionId: "linear-session-1" },
    });

    expect(result.success).toBe(true);
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "agent:apex:linear:direct:linear-session-1",
      agentHarnessRuntimeOverride: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
    }));
    expect(upsertSessionEntry).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "agent:apex:linear:direct:linear-session-1",
      entry: expect.objectContaining({
        sessionId: "linear-apex-CORE-1-0",
        agentRuntimeOverride: "codex",
      }),
    }));
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session-1",
      {
        type: "elicitation",
        body: "Codex needs input:\n1. Use migration A\n2. Use migration B",
      },
      undefined,
    );
  });
});
