/**
 * install-skills.ts — install tonone skills into the OpenClaw workspace skills
 * dir so provisioned agents resolve them by name.
 *
 * tonone skills live at `team/<agent>/skills/<skill>/SKILL.md` in the source
 * checkout. Their bodies are harness-agnostic prose (kept verbatim), but the
 * frontmatter carries Claude-Code-isms (`allowed-tools`, `version`, `author`)
 * that don't belong in an OpenClaw skill. We rewrite the frontmatter down to
 * `name` + `description` and copy the rest of the skill directory as-is.
 * OpenClaw discovers skills recursively under the workspace `skills/` dir by
 * their frontmatter `name`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RosterAgent } from "./agent-roster.js";

/** Default install root: `<workspace-coding>/skills/tonone`. */
export function defaultSkillsInstallDir(): string {
  return join(homedir(), ".openclaw", "workspace-coding", "skills", "tonone");
}

export interface AgentPersona {
  name: string;
  description: string;
  /** The persona prose body (frontmatter stripped). */
  body: string;
}

export interface InstallSkillsResult {
  /** Skill names successfully installed. */
  installed: string[];
  /** Requested skills whose source SKILL.md was not found. */
  missing: string[];
  /** Persona body per tonone agent (from `team/<agent>/agents/<agent>.md`). */
  personas: Record<string, AgentPersona>;
}

/** Parsed frontmatter + body of a markdown-with-frontmatter file. */
interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse a leading YAML frontmatter block (`--- ... ---`) into flat string
 * key/values plus the remaining body. Only scalar single-line values are read
 * (sufficient for tonone `name`/`description`/`model`); block scalars are
 * ignored. No YAML dependency required.
 * @param raw - the raw file contents
 * @returns the parsed frontmatter map and the body after the block
 */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

/** Rebuild a minimal OpenClaw SKILL.md keeping only name + description. */
function normalizeSkillMarkdown(raw: string, fallbackName: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);
  const name = frontmatter.name || fallbackName;
  const description = frontmatter.description || "";
  const fm = [`name: ${name}`, description ? `description: ${description}` : ""]
    .filter(Boolean)
    .join("\n");
  return `---\n${fm}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/**
 * Read a tonone agent persona (`team/<agent>/agents/<agent>.md`). Returns null
 * when absent.
 * @param sourceDir - the tonone repo checkout root
 * @param tononeAgent - the source agent directory name
 * @returns the persona name/description/body, or null
 */
export function readPersona(sourceDir: string, tononeAgent: string): AgentPersona | null {
  const file = join(sourceDir, "team", tononeAgent, "agents", `${tononeAgent}.md`);
  if (!existsSync(file)) return null;
  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"));
  return {
    name: frontmatter.name || tononeAgent,
    description: frontmatter.description || "",
    body: body.trim(),
  };
}

/**
 * Install the skills required by a roster into the workspace skills dir and
 * collect each agent's persona.
 *
 * Idempotent: each skill dir is replaced fresh so a re-provision picks up
 * upstream changes. The skill directory is copied verbatim (supporting files
 * included) except SKILL.md, whose frontmatter is normalized.
 * @param sourceDir - the tonone repo checkout root
 * @param roster - the resolved roster to install skills for
 * @param installDir - target skills dir (default `<workspace>/skills/tonone`)
 * @param logger - optional progress logger
 * @returns installed/missing skill names + personas per tonone agent
 */
export function installSkills(
  sourceDir: string,
  roster: RosterAgent[],
  installDir: string = defaultSkillsInstallDir(),
  logger?: { info: (m: string) => void; warn: (m: string) => void },
): InstallSkillsResult {
  mkdirSync(installDir, { recursive: true });
  const installed: string[] = [];
  const missing: string[] = [];
  const personas: Record<string, AgentPersona> = {};
  const seen = new Set<string>();

  for (const agent of roster) {
    if (!personas[agent.tononeAgent]) {
      const persona = readPersona(sourceDir, agent.tononeAgent);
      if (persona) personas[agent.tononeAgent] = persona;
    }
    for (const skill of agent.skills) {
      if (seen.has(skill)) continue;
      seen.add(skill);
      const srcSkillDir = join(sourceDir, "team", agent.tononeAgent, "skills", skill);
      const srcSkillMd = join(srcSkillDir, "SKILL.md");
      if (!existsSync(srcSkillMd)) {
        missing.push(skill);
        logger?.warn(`[provision] skill not found in source: ${agent.tononeAgent}/${skill}`);
        continue;
      }
      const destSkillDir = join(installDir, skill);
      rmSync(destSkillDir, { recursive: true, force: true });
      // Copy supporting files, then overwrite SKILL.md with the normalized form.
      cpSync(srcSkillDir, destSkillDir, { recursive: true });
      writeFileSync(
        join(destSkillDir, "SKILL.md"),
        normalizeSkillMarkdown(readFileSync(srcSkillMd, "utf8"), skill),
        "utf8",
      );
      installed.push(skill);
    }
  }

  logger?.info(
    `[provision] installed ${installed.length} skill(s) into ${installDir}` +
      (missing.length ? `; ${missing.length} missing` : ""),
  );
  return { installed, missing, personas };
}

/** List skill names already present in an install dir (for status/inspection). */
export function listInstalledSkills(installDir: string = defaultSkillsInstallDir()): string[] {
  if (!existsSync(installDir)) return [];
  return readdirSync(installDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(installDir, d.name, "SKILL.md")))
    .map((d) => d.name);
}
