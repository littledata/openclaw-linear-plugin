import { resolveDefaultAgent } from "../infra/shared-profiles.js";
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
export async function recommendRepos(api, input, agentId) {
    const empty = { repos: [], reasoning: "" };
    if (!input.repoNames.length)
        return empty;
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
    }
    catch (err) {
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
export function parseRecommendation(raw, repoNames) {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        return null;
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const valid = new Set(repoNames);
        const repos = Array.isArray(parsed.repos)
            ? parsed.repos.filter((r) => typeof r === "string" && valid.has(r))
            : [];
        return { repos, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "" };
    }
    catch {
        return null;
    }
}
