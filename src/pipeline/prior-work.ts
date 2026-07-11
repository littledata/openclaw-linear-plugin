/**
 * prior-work.ts — gather everything previous runs did on an issue.
 *
 * On a new dispatch, the resume gate needs to know whether prior work exists and
 * to show the user a recap before asking "resume or start fresh?". The richest
 * source is Linear itself: every prior Agent Session carries a plan/summary, PR
 * links, and a full activity feed. We combine those with the local `.claw`
 * artifacts (plan + per-attempt outputs) when a worktree is present.
 *
 * Two renderings are produced:
 *  - `summary`     — concise markdown for the elicitation shown to the user.
 *  - `fullContext` — a fuller transcript fed to the resume-analysis step, which
 *                    re-derives the correct repo(s) and a continuation brief.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi } from "../api/linear-api.js";
import { buildSummaryFromArtifacts } from "./artifacts.js";
import { resolveDefaultAgent } from "../infra/shared-profiles.js";
import { detectMentionedRepos } from "../infra/multi-repo.js";

export interface PriorWork {
  hasPriorWork: boolean;
  sessionCount: number;
  /** Substantive prior comments found (plans/verdicts/user steering, noise excluded). */
  commentCount: number;
  /** Concise markdown recap for the resume/fresh elicitation. */
  summary: string;
  /** Fuller transcript for the resume-analysis agent (plan + activities + artifacts). */
  fullContext: string;
  /** Distinct PR URLs seen across prior sessions. */
  pullRequestUrls: string[];
}

export interface PriorComment {
  body: string;
  author: string | null;
  createdAt: string;
}

/**
 * Is a comment substantive prior work worth recapping — as opposed to the bot's
 * own gate prompts, system thread markers, and stop/error chatter? Keeps Apex
 * plans, review verdicts, and the user's steering; drops the noise the resume
 * gate itself (and prior runs) generate.
 * @param c - the comment to classify
 * @returns true when the comment is worth showing in a resume recap
 */
export function isSubstantiveComment(c: PriorComment): boolean {
  const b = (c.body ?? "").trim();
  if (!b) return false;
  const noise: RegExp[] = [
    /^This thread is for an agent session/i, // Linear system marker (author null)
    /^Please reply with an option/i, // our own select-signal mirror comment
    /^Which repo(sitory)? should/i, // grill repo question (recommendation, not a decision)
    /^🛑\s*Stop received/i, // stop acknowledgements
    /Something went wrong while processing/i, // transient failure notices
    /`command -v /i, // codex capability-probe failures
  ];
  if (noise.some((re) => re.test(b))) return false;
  // Pure one-word gate replies carry no standalone context.
  if (/^(resume|fresh|yes|no|all|both)\.?$/i.test(b)) return false;
  return true;
}

/** Collapse a comment body to a single recap line (drop markdown headers/blank lines). */
function oneLine(body: string): string {
  return body
    .replace(/^#+\s*/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/** Render one Linear agent-activity's content object to a compact line. */
function activityText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, any>;
  switch (c.type) {
    case "thought":
      return c.body ? `think: ${String(c.body)}` : "";
    case "action":
      return `do: ${c.action ?? ""}${c.parameter ? ` — ${c.parameter}` : ""}`.trim();
    case "response":
      return c.body ? `end: ${String(c.body)}` : "";
    case "elicitation":
      return c.body ? `ask: ${String(c.body)}` : "";
    case "error":
      return c.body ? `error: ${String(c.body)}` : "";
    default:
      return typeof c.body === "string" ? c.body : "";
  }
}

/**
 * Gather prior work for an issue from Linear sessions + local artifacts.
 * @param linearApi - the Linear API
 * @param issueId - the issue id
 * @param opts - excludeSessionId (the current session, skipped) + worktreePath (.claw)
 * @returns a PriorWork bundle (hasPriorWork=false when nothing meaningful found)
 */
export async function gatherPriorWork(
  linearApi: LinearAgentApi,
  issueId: string,
  opts?: { excludeSessionId?: string; worktreePath?: string },
): Promise<PriorWork> {
  const sessions = (await linearApi.listAgentSessions(issueId).catch(() => []))
    .filter((s) => s.id !== opts?.excludeSessionId);

  const prUrls = new Set<string>();
  for (const s of sessions) for (const pr of s.pullRequests) if (pr.url) prUrls.add(pr.url);

  // Issue comments carry the durable record — the Apex plan / verdicts the
  // orchestrator posts, plus the user's own steering — independent of any
  // worktree that may have been wiped (and, on this workspace, more reliable
  // than the agent-session API). Fetch a wide window and keep only substantive
  // comments, de-duplicating identical bodies (the same steering often repeats).
  const rawComments = await linearApi.getRecentComments(issueId, 60).catch(() => [] as PriorComment[]);
  const seen = new Set<string>();
  const comments = rawComments.filter(isSubstantiveComment).filter((c) => {
    const key = c.body.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const clawSummary = opts?.worktreePath ? buildSummaryFromArtifacts(opts.worktreePath) : null;

  const hasPriorWork = sessions.length > 0 || comments.length > 0 || !!clawSummary;

  // ---- Concise summary (elicitation) ----
  const summaryParts: string[] = [];
  sessions.slice(0, 4).forEach((s, i) => {
    const when = s.createdAt.slice(0, 16).replace("T", " ");
    const lines = [`**Session ${sessions.length - i}** — ${when}${s.status ? ` · ${s.status}` : ""}`];
    const planText = s.plan || s.summary;
    if (planText) lines.push(`  ${String(planText).slice(0, 300)}`);
    // Last terminal-ish activity (response/error), if any.
    const lastEnd = [...s.activities].reverse().find((a) => {
      const t = (a.content as any)?.type;
      return t === "response" || t === "error";
    });
    if (lastEnd) lines.push(`  ↳ ${activityText(lastEnd.content).slice(0, 200)}`);
    if (s.pullRequests.length) lines.push(`  PR: ${s.pullRequests.map((p) => p.url).join(", ")}`);
    summaryParts.push(lines.join("\n"));
  });
  // Comment recap — the primary signal when there are no live sessions. Show the
  // most recent substantive comments (plans + steering), newest last.
  if (comments.length) {
    const lines = comments.slice(-6).map((c) => {
      const who = c.author ? `**${c.author}**` : "note";
      return `- ${who}: ${oneLine(c.body).slice(0, 220)}`;
    });
    summaryParts.push(`**Prior planning & steering:**\n${lines.join("\n")}`);
  }
  if (prUrls.size) summaryParts.push(`\n**PRs:** ${[...prUrls].join(", ")}`);

  // ---- Full context (resume-analysis agent) ----
  const ctxParts: string[] = [];
  sessions.slice(0, 6).forEach((s, i) => {
    ctxParts.push(`## Prior session ${sessions.length - i} (${s.createdAt}, status=${s.status ?? "?"})`);
    if (s.plan) ctxParts.push(`Plan:\n${String(s.plan).slice(0, 1500)}`);
    if (s.summary) ctxParts.push(`Summary:\n${String(s.summary).slice(0, 1000)}`);
    if (s.pullRequests.length) ctxParts.push(`PRs: ${s.pullRequests.map((p) => p.url).join(", ")}`);
    const feed = s.activities
      .map((a) => activityText(a.content))
      .filter(Boolean)
      .slice(-25)
      .join("\n");
    if (feed) ctxParts.push(`Activity:\n${feed.slice(0, 2500)}`);
    ctxParts.push("");
  });
  if (comments.length) {
    ctxParts.push("## Issue comments (plan, verdicts, and user steering)");
    for (const c of comments.slice(-15)) {
      ctxParts.push(`[${c.author ?? "note"}] ${c.body.slice(0, 800)}`);
    }
    ctxParts.push("");
  }
  if (clawSummary) ctxParts.push(`## Local worktree artifacts\n${clawSummary.slice(0, 3000)}`);

  return {
    hasPriorWork,
    sessionCount: sessions.length,
    commentCount: comments.length,
    summary: summaryParts.join("\n\n") || "(no readable prior activity)",
    fullContext: ctxParts.join("\n").slice(0, 12000),
    pullRequestUrls: [...prUrls],
  };
}

// ---------------------------------------------------------------------------
// Resume analysis — re-derive the correct repo(s) + a continuation brief
// ---------------------------------------------------------------------------

export interface ResumeAnalysis {
  /** Repo name(s) the work belongs in, RE-EVALUATED from the prior context. */
  repos: string[];
  /** Continuation brief: what's done, what remains, how to finish. */
  brief: string;
}

/**
 * Read the prior-work transcript and decide (a) which repo(s) the work actually
 * belongs in — re-evaluated, because a prior run may have used the WRONG repo —
 * and (b) a continuation brief so the orchestrator picks up where it left off.
 * @param api - the plugin API
 * @param issue - the Linear issue (identifier/title/description)
 * @param repoNames - the configured repo names to choose from
 * @param fullContext - the prior-work transcript from gatherPriorWork
 * @param agentId - the orchestrator agent id
 * @returns the re-derived repos + continuation brief (repos may be [] if unclear)
 */
export async function analyzeResume(
  api: OpenClawPluginApi,
  issue: { identifier: string; title: string; description?: string | null },
  repoNames: string[],
  fullContext: string,
  agentId?: string,
): Promise<ResumeAnalysis> {
  const message = [
    "You are RESUMING prior work on a Linear issue. Read the prior context below",
    "(plans, prior sessions, PRs, and the user's steering comments).",
    "",
    "Two jobs:",
    "1. Decide which repository(ies) the work ACTUALLY belongs in. RE-EVALUATE from",
    "   scratch — a prior run may have used the WRONG repo. Choose from:",
    "   " + repoNames.join(", "),
    "2. Write a concise continuation brief: what was already done, what remains, and",
    "   how to finish — so the implementer picks up rather than restarting.",
    "",
    `Issue ${issue.identifier}: ${issue.title}`,
    issue.description ? `Description:\n${String(issue.description).slice(0, 1500)}` : "",
    "",
    "## Prior context",
    fullContext,
    "",
    'Respond with ONLY this JSON: {"repos":["<repo name>"],"brief":"<continuation brief>"}',
  ].filter(Boolean).join("\n");

  try {
    const { runAgent } = await import("../agent/agent.js");
    const result = await runAgent({
      api,
      agentId: agentId ?? resolveDefaultAgent(api),
      sessionId: `resume-analyze-${issue.identifier}-${Date.now()}`,
      message,
      timeoutMs: 90_000,
    });
    const parsed = result.output ? parseResumeAnalysis(result.output, repoNames) : null;
    if (parsed) {
      // If the model didn't commit to a repo, don't leave it undecided (which
      // silently defaults to codexBaseRepo): rescue from an explicit mention in
      // the prior context (comments/plans naming e.g. "ld-shopify").
      if (!parsed.repos.length) {
        const mentioned = detectMentionedRepos(fullContext, repoNames);
        if (mentioned.length === 1) {
          api.logger.info(`resume analysis for ${issue.identifier}: repo from text mention → ${mentioned[0]}`);
          return { repos: mentioned, brief: parsed.brief };
        }
      }
      return parsed;
    }
    api.logger.warn(`resume analysis for ${issue.identifier}: unparseable — continuing with no repo override`);
  } catch (err) {
    api.logger.warn(`resume analysis error for ${issue.identifier}: ${err}`);
  }
  return { repos: [], brief: "" };
}

/**
 * Parse the resume-analysis JSON from possibly-fenced agent output.
 * @param raw - the agent's raw output
 * @param repoNames - valid repo names (unknown names are dropped)
 * @returns the analysis, or null if unparseable
 */
export function parseResumeAnalysis(raw: string, repoNames: string[]): ResumeAnalysis | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]);
    const valid = new Set(repoNames.map((r) => r.toLowerCase()));
    const repos = Array.isArray(o.repos)
      ? o.repos
          .filter((r: unknown) => typeof r === "string" && valid.has(r.toLowerCase()))
          .map((r: string) => repoNames.find((n) => n.toLowerCase() === r.toLowerCase()) as string)
      : [];
    const brief = typeof o.brief === "string" ? o.brief : "";
    if (!repos.length && !brief) return null;
    return { repos, brief };
  } catch {
    return null;
  }
}
