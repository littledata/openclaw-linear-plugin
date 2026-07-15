import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  _resetCodexSteeringForTesting,
  bindActiveCodexRun,
  buildLinearCodexSessionKey,
  drainCodexControls,
  steerActiveCodexRun,
  stopActiveCodexRun,
} from "./codex-steering.js";

function createHarness() {
  const commands: string[] = [];
  const emitActivity = vi.fn().mockResolvedValue(undefined);
  const buildContext = vi.fn((input: any) => ({
    ...input,
    SessionKey: input.route.routeSessionKey,
    CommandBody: input.message.commandBody,
  }));
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ ctx, dispatcherOptions }: any) => {
    commands.push(ctx.message.commandBody);
    await dispatcherOptions.deliver({ text: "steered current session." });
    return { queuedFinal: false, counts: {} };
  });
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      config: { current: vi.fn().mockReturnValue({}) },
      channel: {
        inbound: { buildContext },
        reply: { dispatchReplyWithBufferedBlockDispatcher },
      },
    },
  } as unknown as OpenClawPluginApi;
  const linearApi = { emitActivity } as any;
  return { api, linearApi, commands, emitActivity, buildContext };
}

describe("Codex harness steering", () => {
  beforeEach(() => _resetCodexSteeringForTesting());

  it("routes a follow-up through /steer on the bound OpenClaw session", async () => {
    const { api, linearApi, commands, emitActivity, buildContext } = createHarness();
    const binding = bindActiveCodexRun({
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
      agentId: "apex",
      openClawSessionId: "embedded-session-1",
      sessionKey: buildLinearCodexSessionKey("apex", "linear-session-1"),
      runId: "run-1",
    });

    expect(steerActiveCodexRun({
      api,
      linearApi,
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
      message: "focus on the failing test",
    })).toBe(true);
    await drainCodexControls(binding);

    expect(commands).toEqual(["/steer focus on the failing test"]);
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.objectContaining({
        routeSessionKey: "agent:apex:linear:direct:linear-session-1",
        dispatchSessionKey: "agent:apex:linear:direct:linear-session-1",
      }),
    }));
    expect(emitActivity).not.toHaveBeenCalled();
  });

  it("maps stop to /codex stop and never to steering", async () => {
    const { api, linearApi, commands } = createHarness();
    bindActiveCodexRun({
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
      agentId: "apex",
      openClawSessionId: "embedded-session-1",
      sessionKey: buildLinearCodexSessionKey("apex", "linear-session-1"),
      runId: "run-1",
    });

    expect(await stopActiveCodexRun({
      api,
      linearApi,
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
    })).toBe(true);

    expect(commands).toEqual(["/codex stop"]);
    expect(commands[0]).not.toContain("steer");
  });

  it("keeps a rejected steer pending and projects its deferred reply", async () => {
    const { api, linearApi, emitActivity } = createHarness();
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    (api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher as any)
      .mockImplementationOnce(async ({ dispatcherOptions }: any) => {
        await deferred;
        await dispatcherOptions.deliver({ text: "Applied after review completed." });
        return { queuedFinal: true, counts: { final: 1 } };
      });
    const binding = bindActiveCodexRun({
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
      agentId: "apex",
      openClawSessionId: "embedded-session-1",
      sessionKey: buildLinearCodexSessionKey("apex", "linear-session-1"),
      runId: "run-1",
    });

    expect(steerActiveCodexRun({
      api,
      linearApi,
      issueId: "issue-1",
      linearSessionId: "linear-session-1",
      message: "wait for review, then apply this",
    })).toBe(true);
    expect(binding.pendingControls.size).toBe(1);

    release();
    await drainCodexControls(binding);
    expect(binding.pendingControls.size).toBe(0);
    expect(emitActivity).toHaveBeenCalledWith(
      "linear-session-1",
      { type: "thought", body: "Applied after review completed." },
    );
  });

  it("does not route a stale Linear session into another session's run", () => {
    const { api, linearApi, commands } = createHarness();
    bindActiveCodexRun({
      issueId: "issue-1",
      linearSessionId: "current-session",
      agentId: "apex",
      openClawSessionId: "embedded-session-1",
      sessionKey: buildLinearCodexSessionKey("apex", "current-session"),
      runId: "run-1",
    });

    expect(steerActiveCodexRun({
      api,
      linearApi,
      issueId: "issue-1",
      linearSessionId: "archived-session",
      message: "wrong target",
    })).toBe(false);
    expect(commands).toEqual([]);
  });
});
