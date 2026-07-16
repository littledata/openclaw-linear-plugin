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
import { READ_ONLY_DENY, HOST_CODE_RUNNER_DENY } from "../agent/agent.js";
/**
 * Host-write denial applied to EVERY provisioned agent's config so that when an
 * agent is spawned as an in-session subagent (whose tool policy comes from its
 * `agents.list` entry, not the parent's runtime deny), it still cannot touch the
 * host — its only mutation path is the container_* tools. sessions_spawn/send are
 * kept OUT of the deny so leads (apex / apex-reviewer) can delegate; non-lead
 * agents simply have no `allowAgents` target. The host code-runner CLIs
 * (cli_codex/claude/gemini) are denied too — a spawned specialist must run its
 * code INSIDE the container via container_*, never as a host codex/claude process.
 */
const HOST_WRITE_DENY = [
    ...READ_ONLY_DENY.filter((tool) => tool !== "sessions_spawn" && tool !== "sessions_send"),
    ...HOST_CODE_RUNNER_DENY,
];
/** Build the desired `agents.list` entry for a roster agent. */
function desiredEntry(agent) {
    const entry = {
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
export async function ensureAgentsRegistered(api, roster, options = {}) {
    const configApi = api.runtime?.config;
    if (!configApi?.mutateConfigFile) {
        throw new Error("api.runtime.config.mutateConfigFile is unavailable — cannot register agents");
    }
    const created = [];
    const updated = [];
    const skipped = [];
    await configApi.mutateConfigFile({
        afterWrite: { mode: "auto" },
        mutate: (draft) => {
            if (!draft.agents || typeof draft.agents !== "object")
                draft.agents = {};
            if (!Array.isArray(draft.agents.list))
                draft.agents.list = [];
            const list = draft.agents.list;
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
                const next = { ...existing };
                if (!next.name) {
                    next.name = want.name;
                    touched = true;
                }
                if (!next.skills || next.skills.length === 0) {
                    next.skills = want.skills;
                    touched = true;
                }
                if (!next.subagents && want.subagents) {
                    next.subagents = want.subagents;
                    touched = true;
                }
                if (!next.tools) {
                    next.tools = want.tools;
                    touched = true;
                }
                if (touched) {
                    list[idx] = next;
                    updated.push(agent.id);
                }
                else {
                    skipped.push(agent.id);
                }
            }
        },
    });
    api.logger.info(`[provision] agents registered — created: [${created.join(", ")}], updated: [${updated.join(", ")}], skipped: [${skipped.join(", ")}]`);
    return { created, updated, skipped };
}
