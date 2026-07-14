/**
 * recommend-repos.ts — LLM-based repo recommendation for Linear issues.
 *
 * When an issue doesn't pin its repo (no marker/label/team-mapping and no single
 * exact name in the text), we ask the user which repo to work on. Rather than
 * dumping the full configured-repo list or silently defaulting, this step reads
 * the issue and proposes a short, ranked list of the most relevant repos with a
 * one-line rationale. The picker then leads with that recommendation.
 *
 * Mirrors tier-assess.ts: one short agent turn, best-effort, degrades to [].
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveDefaultAgent } from "../infra/shared-profiles.js";

export interface RepoRecommendation {
  /** Ranked repo names (most relevant first), each a valid configured repo. */
  repos: string[];
  /** One-line rationale, e.g. "This concerns the Shopify storefront tracker." */
  reasoning: string;
}

export interface RecommendReposInput {
  identifier: string;
  title: string;
  description?: string | null;
  /** Extra free text (comments, prior work) to inform the guess. */
  context?: string;
  /** The full set of configured repo names the agent may choose from. */
  repoNames: string[];
}

const PROMPT = `You route engineering issues to the correct git repository.
Given an issue and the list of available repositories, pick the ones the work
most likely touches — usually ONE, occasionally two or three for cross-repo work.
Choose ONLY from the provided repository names. Order them most-relevant-first.

Respond ONLY with JSON:
{"repos":["repo-name",...],"reasoning":"one short sentence naming the repo(s) and why"}`;

/**
 * Recommend which configured repo(s) an issue concerns, using the agent model.
 * @param api - the OpenClaw plugin API (for runAgent + logging)
 * @param input - issue text, extra context, and the configured repo names
 * @param agentId - optional agent id override (defaults to the profile default)
 * @returns a ranked recommendation; `repos` is empty when nothing could be parsed
 */
export async function recommendRepos(
  api: OpenClawPluginApi,
  input: RecommendReposInput,
  agentId?: string,
): Promise<RepoRecommendation> {
  const empty: RepoRecommendation = { repos: [], reasoning: "" };
  if (!input.repoNames.length) return empty;

  const issueText = [
    `Issue: ${input.identifier} — ${input.title}`,
    input.description ? `Description: ${input.description.slice(0, 1500)}` : "",
    input.context ? `Context:\n${input.context.slice(0, 1500)}` : "",
    `\nAvailable repositories:\n${input.repoNames.join(", ")}`,
  ].filter(Boolean).join("\n");

  try {
    const { runAgent } = await import("../agent/agent.js");
    const result = await runAgent({
      api,
      agentId: agentId ?? resolveDefaultAgent(api),
      sessionId: `repo-recommend-${input.identifier}-${Date.now()}`,
      message: `${PROMPT}\n\n${issueText}`,
      timeoutMs: 30_000,
    });
    if (result.output) {
      const parsed = parseRecommendation(result.output, input.repoNames);
      if (parsed) {
        api.logger.info(`Repo recommendation for ${input.identifier}: ${parsed.repos.join(",") || "(none)"} — ${parsed.reasoning}`);
        return parsed;
      }
    }
    api.logger.warn(`Repo recommendation for ${input.identifier}: unparseable — ${result.output.slice(0, 200)}`);
  } catch (err) {
    api.logger.warn(`Repo recommendation error for ${input.identifier}: ${err}`);
  }
  return empty;
}

/**
 * Parse the recommender's JSON, keeping only names that are actually configured.
 * @param raw - the agent's raw output (may be markdown-wrapped)
 * @param repoNames - the valid configured repo names to filter against
 * @returns the parsed recommendation, or null when no JSON object is found
 */
export function parseRecommendation(raw: string, repoNames: string[]): RepoRecommendation | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const valid = new Set(repoNames);
    const repos = Array.isArray(parsed.repos)
      ? parsed.repos.filter((r: unknown): r is string => typeof r === "string" && valid.has(r))
      : [];
    return { repos, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "" };
  } catch {
    return null;
  }
}
