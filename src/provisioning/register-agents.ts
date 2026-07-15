/**
 * register-agents.ts — register the provisioned roster in OpenClaw `agents.list`.
 *
 * Uses the non-deprecated `api.runtime.config.mutateConfigFile` (loadConfig/
 * writeConfigFile are deprecated) with `afterWrite:{mode:"auto"}` so the gateway
 * hot-reloads (or defers) the change. Idempotent: a missing agent id is created;
 * an existing one is left intact except for filling in the roster's skills/
 * subagents/name when absent (so operator customizations — model, thinking — are
 * never clobbered). Registering the agents is what lets the control UI open
 * their sessions ("Unknown agent id" otherwise) and lets Apex delegate to them.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { READ_ONLY_DENY } from "../agent/agent.js";
import type { RosterAgent } from "./agent-roster.js";

/**
 * Host-write denial applied to EVERY provisioned agent's config so that when an
 * agent is spawned as an in-session subagent (whose tool policy comes from its
 * `agents.list` entry, not the parent's runtime deny), it still cannot touch the
 * host — its only mutation path is the container_* tools. sessions_spawn/send are
 * kept OUT of the deny so leads (apex / apex-reviewer) can delegate; non-lead
 * agents simply have no `allowAgents` target.
 */
const HOST_WRITE_DENY: string[] = READ_ONLY_DENY.filter(
  (tool) => tool !== "sessions_spawn" && tool !== "sessions_send",
);

/** Minimal shape of an `agents.list[]` entry we read/write. */
interface AgentEntryDraft {
  id: string;
  name?: string;
  skills?: string[];
  subagents?: { allowAgents?: string[]; delegationMode?: "suggest" | "prefer" };
  tools?: { deny?: string[] };
  [key: string]: unknown;
}

/** The `api.runtime.config` surface we depend on. */
interface ConfigMutationApi {
  mutateConfigFile: (params: {
    afterWrite: { mode: "auto" } | { mode: "restart"; reason: string } | { mode: "none"; reason: string };
    mutate: (draft: Record<string, any>) => void | Promise<void>;
  }) => Promise<unknown>;
}

export interface RegisterAgentsResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/** Build the desired `agents.list` entry for a roster agent. */
function desiredEntry(agent: RosterAgent): AgentEntryDraft {
  const entry: AgentEntryDraft = {
    id: agent.id,
    name: agent.label,
    skills: [...agent.skills],
    tools: { deny: [...HOST_WRITE_DENY] },
  };
  if (agent.subagents?.length) {
    entry.subagents = { allowAgents: [...agent.subagents], delegationMode: "prefer" };
  }
  return entry;
}

/**
 * Ensure every roster agent exists in `agents.list`.
 * @param api - the plugin API (needs `runtime.config.mutateConfigFile`)
 * @param roster - the resolved roster to register
 * @param options - `overwrite` to force skills/subagents sync on existing ids
 * @returns which ids were created / updated / left untouched
 */
export async function ensureAgentsRegistered(
  api: OpenClawPluginApi,
  roster: RosterAgent[],
  options: { overwrite?: boolean } = {},
): Promise<RegisterAgentsResult> {
  const configApi = (api as unknown as { runtime?: { config?: ConfigMutationApi } }).runtime?.config;
  if (!configApi?.mutateConfigFile) {
    throw new Error("api.runtime.config.mutateConfigFile is unavailable — cannot register agents");
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  await configApi.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      if (!draft.agents || typeof draft.agents !== "object") draft.agents = {};
      if (!Array.isArray(draft.agents.list)) draft.agents.list = [];
      const list = draft.agents.list as AgentEntryDraft[];

      for (const agent of roster) {
        const want = desiredEntry(agent);
        const idx = list.findIndex((e) => e?.id === agent.id);
        if (idx === -1) {
          list.push(want);
          created.push(agent.id);
          continue;
        }
        const existing = list[idx];
        if (options.overwrite) {
          // Preserve operator-set fields (model, thinking, agentDir, …); replace
          // only the roster-owned fields (skills, subagents, and the write-isolation
          // tool policy that keeps subagents container-only).
          list[idx] = {
            ...existing,
            name: existing.name ?? want.name,
            skills: want.skills,
            subagents: want.subagents ?? existing.subagents,
            tools: want.tools,
          };
          updated.push(agent.id);
          continue;
        }
        // Non-overwrite: fill only absent roster fields.
        let touched = false;
        const next: AgentEntryDraft = { ...existing };
        if (!next.name) { next.name = want.name; touched = true; }
        if (!next.skills || next.skills.length === 0) { next.skills = want.skills; touched = true; }
        if (!next.subagents && want.subagents) { next.subagents = want.subagents; touched = true; }
        if (!next.tools) { next.tools = want.tools; touched = true; }
        if (touched) {
          list[idx] = next;
          updated.push(agent.id);
        } else {
          skipped.push(agent.id);
        }
      }
    },
  });

  api.logger.info(
    `[provision] agents registered — created: [${created.join(", ")}], updated: [${updated.join(", ")}], skipped: [${skipped.join(", ")}]`,
  );
  return { created, updated, skipped };
}
