/**
 * grill.ts — the /grill-me interview step (one question at a time).
 *
 * Uses the orchestrator agent to generate the next interview question, or to
 * signal it has a shared understanding (returning the target repo(s) + an
 * implementation brief). Modeled on Matt Pocock's grill-me: relentless one-at-a-
 * time questioning, each with a recommended answer, until the plan is clear.
 */
import { resolveDefaultAgent } from "../infra/shared-profiles.js";
/** Hard cap on interview length so it can't run away. */
export const MAX_GRILL_QUESTIONS = 6;
function grillSystemPrompt(repoNames) {
    return [
        "You are running the /grill-me protocol: interview the user BEFORE any code is written,",
        "so the implementer builds the right thing in the right repository.",
        "",
        "Rules:",
        "- Ask ONE question at a time. For each, give your RECOMMENDED answer + a one-line why,",
        "  so the user can just reply 'yes'.",
        "- FIRST resolve WHICH repository(ies) the work belongs in. Available repos:",
        "  " + repoNames.join(", "),
        "- Then clarify scope, acceptance criteria, and edge cases that materially change the build.",
        "- Skip anything the issue text already answers. Stop once the plan is clear (usually 2-5 questions).",
        "- When a question has a DISCRETE set of answers (which repo, yes/no, or an enumerated",
        "  choice), ALSO return an `options` array of the allowed answer strings so the user can",
        "  tap one instead of typing. For the repo question, the options ARE the repo names above.",
        "  Omit `options` entirely for open-ended questions.",
        "",
        "Respond with ONLY a single JSON object, no prose:",
        '  to ask (open):    {"question":"<question incl. your recommended answer>"}',
        '  to ask (choices): {"question":"<question incl. your recommended answer>","options":["<choice>","<choice>"]}',
        '  when ready:       {"ready":true,"repos":["<repo name>"],"guidance":"<concise implementation brief: target repo(s)/paths, decisions, acceptance criteria>"}',
    ].join("\n");
}
/**
 * Produce the next interview step for an issue.
 * @param api - the plugin API
 * @param issue - the Linear issue (identifier, title, description)
 * @param repoNames - configured repo names the user can choose from
 * @param qa - the interview so far
 * @param agentId - the orchestrator agent id
 * @returns the next question, or a ready signal with repos + guidance
 */
export async function runGrillStep(api, issue, repoNames, qa, agentId) {
    const convo = qa.map((x, i) => `Q${i + 1}: ${x.question}\nA${i + 1}: ${x.answer}`).join("\n\n");
    const message = [
        grillSystemPrompt(repoNames),
        "",
        `Issue ${issue.identifier}: ${issue.title}`,
        issue.description ? `Description:\n${issue.description.slice(0, 2000)}` : "",
        convo ? `\nInterview so far:\n${convo}` : "",
        qa.length >= MAX_GRILL_QUESTIONS ? '\nYou have asked enough — respond with {"ready":true,...} now.' : "",
    ].filter(Boolean).join("\n");
    try {
        const { runAgent } = await import("../agent/agent.js");
        const result = await runAgent({
            api,
            agentId: agentId ?? resolveDefaultAgent(api),
            sessionId: `grill-${issue.identifier}-${Date.now()}`,
            message,
            timeoutMs: 60_000,
        });
        const parsed = result.output ? parseGrillStep(result.output) : null;
        if (parsed)
            return parsed;
        api.logger.warn(`grill step for ${issue.identifier}: unparseable output — proceeding`);
    }
    catch (err) {
        api.logger.warn(`grill step error for ${issue.identifier}: ${err}`);
    }
    // Fallback: don't block the dispatch — proceed with no extra guidance.
    return { ready: true };
}
/**
 * Parse a grill step from possibly-fenced agent output.
 * @param raw - the agent's raw output
 * @returns a GrillStep, or null if unparseable
 */
export function parseGrillStep(raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match)
        return null;
    try {
        const o = JSON.parse(match[0]);
        if (o.ready === true) {
            return {
                ready: true,
                repos: Array.isArray(o.repos) ? o.repos.filter((r) => typeof r === "string") : undefined,
                guidance: typeof o.guidance === "string" ? o.guidance : "",
            };
        }
        if (typeof o.question === "string" && o.question.trim()) {
            const options = Array.isArray(o.options)
                ? o.options
                    .filter((x) => typeof x === "string" && x.trim().length > 0)
                    .map((x) => x.trim())
                : undefined;
            return {
                ready: false,
                question: o.question,
                ...(options && options.length ? { options } : {}),
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
