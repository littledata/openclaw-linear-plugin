/**
 * multi-repo.ts — Multi-repo resolution for dispatches spanning multiple git repos.
 *
 * Four-tier resolution:
 * 1. Issue body markers: <!-- repos: api, frontend --> or [repos: api, frontend]
 * 2. Linear labels: repo:api, repo:frontend
 * 3. Team mapping: teamMappings[teamKey].repos from plugin config
 * 4. Config default: Falls back to single codexBaseRepo
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface RepoConfig {
  name: string;
  path: string;
}

export interface RepoResolution {
  repos: RepoConfig[];
  source: "issue_body" | "labels" | "team_mapping" | "config_default";
}

/**
 * Enriched repo entry — filesystem path + optional GitHub identity.
 * Supports both plain string paths (backward compat) and objects.
 */
export interface RepoEntry {
  path: string;
  github?: string;      // "owner/repo" format
  hostname?: string;    // defaults to "github.com"
}

/**
 * Parse the repos config, normalizing both string and object formats.
 * String values become { path: value }, objects pass through.
 */
export function getRepoEntries(pluginConfig?: Record<string, unknown>): Record<string, RepoEntry> {
  const repos = pluginConfig?.repos as Record<string, string | Record<string, unknown>> | undefined;
  if (!repos) return {};
  const result: Record<string, RepoEntry> = {};
  for (const [name, value] of Object.entries(repos)) {
    if (typeof value === "string") {
      result[name] = { path: value };
    } else if (value && typeof value === "object") {
      result[name] = {
        path: (value as any).path as string,
        github: (value as any).github as string | undefined,
        hostname: (value as any).hostname as string | undefined,
      };
    }
  }
  return result;
}

/**
 * Build candidate repositories for Linear's issueRepositorySuggestions API.
 * Extracts GitHub identity from enriched repo entries.
 */
export function buildCandidateRepositories(
  pluginConfig?: Record<string, unknown>,
): Array<{ hostname: string; repositoryFullName: string }> {
  const entries = getRepoEntries(pluginConfig);
  return Object.values(entries)
    .filter(e => e.github)
    .map(e => ({
      hostname: e.hostname ?? "github.com",
      repositoryFullName: e.github!,
    }));
}

/**
 * Find configured repo names explicitly mentioned in free text (issue body,
 * comments, prior-work context). Whole-token, case-insensitive, and hyphen-aware
 * so "ld-shopify" does NOT match inside "ld-shopify-admin" — each is detected
 * only by its own full name. Used to rescue repo resolution from silently
 * defaulting to codexBaseRepo when the issue text names a repo (e.g. a comment
 * saying "the bug is in ld-shopify").
 * @param text - the text to scan
 * @param repoNames - the configured repo names
 * @returns distinct configured repo names mentioned, in config order
 */
export function detectMentionedRepos(text: string, repoNames: string[]): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const name of repoNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // No word/hyphen char immediately around the name → exact-token match.
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
    if (re.test(text)) found.push(name);
  }
  return [...new Set(found)];
}

/**
 * Resolve which repos a dispatch should work with.
 */
export function resolveRepos(
  description: string | null | undefined,
  labels: string[],
  pluginConfig?: Record<string, unknown>,
  teamKey?: string,
): RepoResolution {
  // 1. Check issue body for repo markers
  // Match: <!-- repos: name1, name2 --> or [repos: name1, name2]
  const htmlComment = description?.match(/<!--\s*repos:\s*([^>]+?)\s*-->/i);
  const bracketMatch = description?.match(/\[repos:\s*([^\]]+)\]/i);
  const bodyMatch = htmlComment?.[1] ?? bracketMatch?.[1];

  if (bodyMatch) {
    const names = bodyMatch.split(",").map(s => s.trim()).filter(Boolean);
    if (names.length > 0) {
      const repoMap = getRepoMap(pluginConfig);
      const repos = names.map(name => ({
        name,
        path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
      }));
      return { repos, source: "issue_body" };
    }
  }

  // 2. Check labels for repo: prefix
  const repoLabels = labels
    .filter(l => l.startsWith("repo:"))
    .map(l => l.slice(5).trim())
    .filter(Boolean);

  if (repoLabels.length > 0) {
    const repoMap = getRepoMap(pluginConfig);
    const repos = repoLabels.map(name => ({
      name,
      path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
    }));
    return { repos, source: "labels" };
  }

  // 3. Team mapping: teamMappings[teamKey].repos
  if (teamKey) {
    const teamMappings = pluginConfig?.teamMappings as Record<string, Record<string, unknown>> | undefined;
    const teamRepoNames = teamMappings?.[teamKey]?.repos as string[] | undefined;
    if (teamRepoNames && teamRepoNames.length > 0) {
      const repoMap = getRepoMap(pluginConfig);
      const repos = teamRepoNames.map(name => ({
        name,
        path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
      }));
      return { repos, source: "team_mapping" };
    }
  }

  // 4. Config default: single repo
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? path.join(homedir(), "ai-workspace");
  return {
    repos: [{ name: "default", path: baseRepo }],
    source: "config_default",
  };
}

function getRepoMap(pluginConfig?: Record<string, unknown>): Record<string, string> {
  const entries = getRepoEntries(pluginConfig);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) {
    result[name] = entry.path;
  }
  return result;
}

function resolveRepoPath(name: string, pluginConfig?: Record<string, unknown>): string {
  // Convention: {parentDir}/{name}
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? path.join(homedir(), "ai-workspace");
  const parentDir = path.dirname(baseRepo);
  return path.join(parentDir, name);
}

/**
 * Resolve an explicit list of repo names into a RepoResolution.
 * Used by interactive repo selection once the user has chosen.
 * @param names - repo names (keys in the `repos` config)
 * @param pluginConfig - the plugin config object
 * @returns a RepoResolution over the named repos
 */
export function resolveReposByNames(
  names: string[],
  pluginConfig?: Record<string, unknown>,
): RepoResolution {
  const repoMap = getRepoMap(pluginConfig);
  const repos = names.map((name) => ({
    name,
    path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
  }));
  return { repos, source: "issue_body" };
}

export function isMultiRepo(resolution: RepoResolution): boolean {
  return resolution.repos.length > 1;
}

/**
 * Validate a repo path: exists, is a git repo, and whether it's a submodule.
 * Submodules have a `.git` *file* (not directory) that points to the parent's
 * `.git/modules/` — `git worktree add` won't work on them.
 */
export function validateRepoPath(repoPath: string): {
  exists: boolean;
  isGitRepo: boolean;
  isSubmodule: boolean;
} {
  if (!existsSync(repoPath)) {
    return { exists: false, isGitRepo: false, isSubmodule: false };
  }

  const gitPath = path.join(repoPath, ".git");
  if (!existsSync(gitPath)) {
    return { exists: true, isGitRepo: false, isSubmodule: false };
  }

  const stat = statSync(gitPath);
  if (stat.isFile()) {
    // .git is a file → submodule (points to parent's .git/modules/)
    return { exists: true, isGitRepo: true, isSubmodule: true };
  }

  return { exists: true, isGitRepo: true, isSubmodule: false };
}
