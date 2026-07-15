import { describe, it, expect } from "vitest";
import { ensureAgentsRegistered } from "./register-agents.js";
import type { RosterAgent } from "./agent-roster.js";

/** A fake plugin API whose mutateConfigFile applies the mutation to a held draft. */
function fakeApi(initial: Record<string, any>) {
  const draft = initial;
  const calls: Array<{ mode: string }> = [];
  const api = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtime: {
      config: {
        mutateConfigFile: async (params: any) => {
          calls.push({ mode: params.afterWrite.mode });
          await params.mutate(draft);
          return {};
        },
      },
    },
  } as any;
  return { api, draft, calls };
}

const ROSTER: RosterAgent[] = [
  {
    id: "apex",
    label: "Apex",
    tononeAgent: "apex",
    skills: ["apex-plan", "apex-review"],
    kind: "plan-implement",
    subagents: ["spine", "forge"],
    summary: "lead",
  },
  {
    id: "warden",
    label: "Warden",
    tononeAgent: "warden",
    skills: ["warden-audit"],
    kind: "review",
    reviewStyle: "comment",
    summary: "security",
  },
];

describe("ensureAgentsRegistered", () => {
  it("creates missing agents and preserves the existing main entry", async () => {
    const { api, draft, calls } = fakeApi({ agents: { list: [{ id: "main" }] } });
    const result = await ensureAgentsRegistered(api, ROSTER);

    expect(result.created).toEqual(["apex", "warden"]);
    expect(calls[0].mode).toBe("auto");
    const ids = draft.agents.list.map((e: any) => e.id);
    expect(ids).toEqual(["main", "apex", "warden"]);

    const apex = draft.agents.list.find((e: any) => e.id === "apex");
    expect(apex.skills).toEqual(["apex-plan", "apex-review"]);
    expect(apex.subagents).toEqual({ allowAgents: ["spine", "forge"], delegationMode: "prefer" });

    const warden = draft.agents.list.find((e: any) => e.id === "warden");
    expect(warden.subagents).toBeUndefined();

    // Write-isolation: every provisioned agent denies host writes/exec but keeps
    // sessions_spawn so leads can delegate.
    expect(apex.tools.deny).toContain("group:runtime");
    expect(apex.tools.deny).toContain("write");
    expect(apex.tools.deny).not.toContain("sessions_spawn");
  });

  it("initializes agents.list when absent", async () => {
    const { api, draft } = fakeApi({});
    await ensureAgentsRegistered(api, [ROSTER[0]]);
    expect(draft.agents.list.map((e: any) => e.id)).toEqual(["apex"]);
  });

  it("does not clobber operator-set fields on existing agents (non-overwrite)", async () => {
    const { api, draft, calls: _c } = fakeApi({
      agents: { list: [{ id: "apex", model: "custom/model", skills: ["mine"] }] },
    });
    const result = await ensureAgentsRegistered(api, [ROSTER[0]]);
    const apex = draft.agents.list.find((e: any) => e.id === "apex");
    expect(apex.model).toBe("custom/model");
    expect(apex.skills).toEqual(["mine"]); // kept — already had skills
    expect(apex.subagents).toEqual({ allowAgents: ["spine", "forge"], delegationMode: "prefer" }); // filled (was absent)
    expect(result.updated).toEqual(["apex"]);
  });

  it("re-syncs skills/subagents on overwrite while keeping model", async () => {
    const { api, draft } = fakeApi({
      agents: { list: [{ id: "apex", model: "custom/model", skills: ["stale"] }] },
    });
    const result = await ensureAgentsRegistered(api, [ROSTER[0]], { overwrite: true });
    const apex = draft.agents.list.find((e: any) => e.id === "apex");
    expect(apex.model).toBe("custom/model");
    expect(apex.skills).toEqual(["apex-plan", "apex-review"]);
    expect(result.updated).toEqual(["apex"]);
  });

  it("throws when the config mutation API is unavailable", async () => {
    const api = { logger: { info: () => {}, warn: () => {}, error: () => {} }, runtime: {} } as any;
    await expect(ensureAgentsRegistered(api, ROSTER)).rejects.toThrow(/mutateConfigFile/);
  });
});
