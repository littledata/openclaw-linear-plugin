/**
 * provision.ts — the setup step that installs the tonone agent stack.
 *
 * Orchestrates: resolve the configured roster → fetch the tonone repo at the
 * pinned/refreshable ref → install each agent's skills into the workspace skills
 * dir → register the agents in `agents.list`. Invoked explicitly (CLI command),
 * NOT blind on every startup — honoring "never blind-install skills": pinned
 * ref, explicit step, logged file list.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveRoster, type RosterAgent } from "./agent-roster.js";
import { fetchTononeSource } from "./tonone-source.js";
import { installSkills, defaultSkillsInstallDir } from "./install-skills.js";
import { ensureAgentsRegistered } from "./register-agents.js";

export interface ProvisionResult {
  sha: string;
  ref: string;
  roster: string[];
  installedSkills: string[];
  missingSkills: string[];
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Run the full provision flow.
 * @param api - the plugin API (logger + runtime.config)
 * @param options - `overwrite` forces re-sync of existing agents' skills/subagents
 * @returns a structured summary of what was fetched/installed/registered
 */
export async function provisionTononeAgents(
  api: OpenClawPluginApi,
  options: { overwrite?: boolean } = {},
): Promise<ProvisionResult> {
  const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  const roster: RosterAgent[] = resolveRoster(pluginConfig);
  if (roster.length === 0) {
    throw new Error("provisionAgents resolved to an empty roster — nothing to provision");
  }
  api.logger.info(`[provision] roster: ${roster.map((a) => a.id).join(", ")}`);

  const source = fetchTononeSource({
    repo: pluginConfig?.tononeRepo as string | undefined,
    ref: pluginConfig?.tononeRef as string | undefined,
    cacheDir: pluginConfig?.tononeCacheDir as string | undefined,
    logger: api.logger,
  });

  const installDir = (pluginConfig?.skillsInstallDir as string) || defaultSkillsInstallDir();
  const install = installSkills(source.dir, roster, installDir, api.logger);

  const registration =
    pluginConfig?.autoRegisterAgents === false
      ? { created: [], updated: [], skipped: roster.map((a) => a.id) }
      : await ensureAgentsRegistered(api, roster, { overwrite: options.overwrite });

  return {
    sha: source.sha,
    ref: source.ref,
    roster: roster.map((a) => a.id),
    installedSkills: install.installed,
    missingSkills: install.missing,
    created: registration.created,
    updated: registration.updated,
    skipped: registration.skipped,
  };
}
