/**
 * tools.test.ts — Integration tests for tool registration.
 *
 * Verifies createLinearTools() returns expected tools and handles
 * configuration flags and graceful failure scenarios.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./code-tool.js", () => ({
  createCodeTools: vi.fn(() => [
    { name: "cli_codex", execute: vi.fn() },
    { name: "cli_claude", execute: vi.fn() },
    { name: "cli_gemini", execute: vi.fn() },
  ]),
  createCodeTool: vi.fn(() => [
    { name: "cli_codex", execute: vi.fn() },
    { name: "cli_claude", execute: vi.fn() },
    { name: "cli_gemini", execute: vi.fn() },
  ]),
}));

vi.mock("./orchestration-tools.js", () => ({
  createOrchestrationTools: vi.fn(() => [
    { name: "spawn_agent", execute: vi.fn() },
    { name: "ask_agent", execute: vi.fn() },
  ]),
}));

vi.mock("./linear-issues-tool.js", () => ({
  createLinearIssuesTool: vi.fn(() => ({ name: "linear_issues", execute: vi.fn() })),
}));

vi.mock("./steering-tools.js", () => ({
  createSteeringTools: vi.fn(() => [
    { name: "steer_agent", execute: vi.fn() },
    { name: "capture_agent_output", execute: vi.fn() },
    { name: "abort_agent", execute: vi.fn() },
  ]),
}));

vi.mock("./container-tools.js", () => ({
  createContainerTools: vi.fn(() => [
    { name: "container_exec", execute: vi.fn() },
    { name: "container_write_file", execute: vi.fn() },
    { name: "container_read_file", execute: vi.fn() },
    { name: "container_apply_patch", execute: vi.fn() },
    { name: "container_status", execute: vi.fn() },
    { name: "container_clone_repo", execute: vi.fn() },
  ]),
}));

import { createLinearTools } from "./tools.js";
import { createCodeTools } from "./code-tool.js";
import { createOrchestrationTools } from "./orchestration-tools.js";
import { createLinearIssuesTool } from "./linear-issues-tool.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeApi(pluginConfig?: Record<string, unknown>) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginConfig: pluginConfig ?? {},
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createLinearTools", () => {
  it("returns cli_codex, cli_claude, cli_gemini, orchestration, linear_issues, and steering tools", () => {
    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(15);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("cli_codex");
    expect(names).toContain("cli_claude");
    expect(names).toContain("cli_gemini");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(names).toContain("linear_issues");
    expect(names).toContain("steer_agent");
    expect(names).toContain("capture_agent_output");
    expect(names).toContain("abort_agent");
  });

  it("includes orchestration tools by default", () => {
    const api = makeApi();
    createLinearTools(api, {});

    expect(createOrchestrationTools).toHaveBeenCalled();
  });

  it("excludes orchestration tools when enableOrchestration is false", () => {
    vi.mocked(createOrchestrationTools).mockClear();
    const api = makeApi({ enableOrchestration: false });
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(13);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("cli_codex");
    expect(names).toContain("cli_claude");
    expect(names).toContain("cli_gemini");
    expect(names).toContain("linear_issues");
    expect(names).toContain("steer_agent");
    expect(createOrchestrationTools).not.toHaveBeenCalled();
  });

  it("handles CLI tools creation failure gracefully", () => {
    vi.mocked(createCodeTools).mockImplementationOnce(() => {
      throw new Error("CLI not found");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(12);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(names).toContain("linear_issues");
    expect(names).toContain("steer_agent");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CLI coding tools not available"),
    );
  });

  it("handles orchestration tools creation failure gracefully", () => {
    vi.mocked(createOrchestrationTools).mockImplementationOnce(() => {
      throw new Error("orchestration init failed");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(13);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("cli_codex");
    expect(names).toContain("cli_claude");
    expect(names).toContain("cli_gemini");
    expect(names).toContain("linear_issues");
    expect(names).toContain("steer_agent");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Orchestration tools not available"),
    );
  });

  it("handles linear_issues creation failure gracefully", () => {
    vi.mocked(createLinearIssuesTool).mockImplementationOnce(() => {
      throw new Error("no token");
    });

    const api = makeApi();
    const tools = createLinearTools(api, {});

    expect(tools).toHaveLength(14);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("cli_codex");
    expect(names).toContain("cli_claude");
    expect(names).toContain("cli_gemini");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("ask_agent");
    expect(names).toContain("steer_agent");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("linear_issues tool not available"),
    );
  });
});
