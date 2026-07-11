/**
 * orchestrator.ts — the state-driven specialist pipeline.
 *
 * Given a StatePlan resolved from the ticket's Linear workflow state, run the
 * plan's phases in order:
 *
 *   plan-implement : Apex plans + routes implementer specialists → they build
 *                    (via codex, in the worktree) → Apex self-reviews → PR.
 *   review         : a reviewer (Warden / Apex / Proof) reads the change and
 *                    emits a pass/fail verdict; a fail gates and triggers a
 *                    bounded codex fix, then re-review.
 *   product        : a product role (Helm / Lumen) emits a written brief.
 *
 * TRANSITIONS ARE AGENT-DECIDED: the ticket only advances to the plan's
 * onSuccess state when EVERY phase succeeds. Any phase failure leaves the
 * ticket where it is and posts a comment explaining what blocked it.
 *
 * This path is opt-in via config `orchestrationMode: "stateplan"`; the default
 * single-worker pipeline (spawnWorker) is untouched.
 */

import { runAgent } from "../agent/agent.js";
import { runCodex } from "../tools/codex-tool.js";
import { createPullRequest, getWorktreeStatus } from "../infra/codex-worktree.js";
import { readManifest, writeManifest, updateManifest, savePlan, saveWorkerOutput, appendLog } from "./artifacts.js";
import type { ActiveDispatch } from "./dispatch-state.js";
import type { HookContext } from "./pipeline.js";
import type { ActivityContent } from "../api/linear-api.js";
import {
  ROLES,
  resolveRole,
  implementerRoles,
  buildRolePrompt,
  parseReviewVerdict,
  resolveRoleModel,
  resolveRoleBackend,
  loadSkillGuidance,
  roleToolsDeny,
  type RoleDef,
  type RoleKind,
} from "./roles.js";
import { resolveTargetState, type StatePlan, type PlanPhase } from "./state-plan.js";

interface OrchIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  teamId?: string;
}

interface Assignment {
  role: string;
  task: string;
}

interface RoleRunResult {
  success: boolean;
  output: string;
}

/** Max bounded rework attempts (config `maxReworkAttempts`, default 2). */
function maxRework(pluginConfig?: Record<string, unknown>): number {
  const v = pluginConfig?.maxReworkAttempts;
  return typeof v === "number" && v >= 0 ? v : 2;
}

/**
 * Ensure a `.claw/manifest.json` exists so updateManifest / buildSummaryFromArtifacts
 * work and a future session can read this run's status. Best-effort.
 */
function ensureManifest(dispatch: ActiveDispatch): void {
  try {
    if (readManifest(dispatch.worktreePath)) return;
    writeManifest(dispatch.worktreePath, {
      issueIdentifier: dispatch.issueIdentifier,
      issueTitle: dispatch.issueTitle ?? dispatch.issueIdentifier,
      issueId: dispatch.issueId,
      tier: dispatch.tier,
      model: dispatch.model,
      dispatchedAt: dispatch.dispatchedAt,
      worktreePath: dispatch.worktreePath,
      branch: dispatch.branch,
      attempts: dispatch.attempt,
      status: "orchestrating",
      plugin: "openclaw-linear",
    });
  } catch { /* best effort */ }
}

/** Update the manifest status (best-effort). */
function setStatus(dispatch: ActiveDispatch, status: string): void {
  try { updateManifest(dispatch.worktreePath, { status }); } catch { /* best effort */ }
}

/** Stream an activity line to the ticket's Linear agent session (best-effort). */
function emit(ctx: HookContext, dispatch: ActiveDispatch, content: ActivityContent): void {
  if (!dispatch.agentSessionId) return;
  ctx.linearApi.emitActivity(dispatch.agentSessionId, content).catch(() => {});
}

/** Post a comment to the ticket (best-effort). */
async function comment(ctx: HookContext, dispatch: ActiveDispatch, body: string): Promise<void> {
  await ctx.linearApi.createComment(dispatch.issueId, body).catch((err) => {
    ctx.api.logger.warn(`[orchestrator] comment failed for ${dispatch.issueIdentifier}: ${err}`);
  });
}

// ---------------------------------------------------------------------------
// Task-body builder (the DATA; the persona/skill lives in the system prompt)
// ---------------------------------------------------------------------------

function buildRoleTask(issue: OrchIssue, dispatch: ActiveDispatch, extra?: string): string {
  const worktree = dispatch.worktrees
    ? dispatch.worktrees.map((w) => `${w.repoName}: ${w.path}`).join("\n")
    : dispatch.worktreePath;
  return [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.description ? `\nIssue body:\n${issue.description}` : "",
    `\nWorktree(s):\n${worktree}`,
    dispatch.grillGuidance ? `\nClarified requirements:\n${dispatch.grillGuidance}` : "",
    extra ? `\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Single role invocation (backend-aware)
// ---------------------------------------------------------------------------

/**
 * Run one specialist role for the current phase.
 * @param ctx - hook context (api, linearApi, config)
 * @param dispatch - the active dispatch (worktree, session, attempt)
 * @param role - the role to run
 * @param phase - the phase-kind (drives the role prompt)
 * @param extra - invocation-specific instructions (assignment / review focus)
 * @param issue - the Linear issue context
 * @returns the run result (success + text output)
 */
async function runRole(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  role: RoleDef,
  phase: RoleKind,
  extra: string | undefined,
  issue: OrchIssue,
): Promise<RoleRunResult> {
  const backend = resolveRoleBackend(role, ctx.pluginConfig);
  const system = buildRolePrompt(role, { identifier: dispatch.issueIdentifier, phase, backend, extra });
  const task = buildRoleTask(issue, dispatch, extra);

  emit(ctx, dispatch, { type: "thought", body: `[${role.label}] starting ${phase} (${backend})` });
  ctx.api.logger.info(
    `[orchestrator] ${dispatch.issueIdentifier} role=${role.id} phase=${phase} backend=${backend}`,
  );

  if (backend === "codex") {
    // codex has no OpenClaw skill system — inline the role's SKILL.md body so
    // the specialist guidance actually reaches it (falls back to the persona
    // line already in `system` when the skill file isn't deployed).
    const skillBody = loadSkillGuidance(role, ctx.pluginConfig);
    const codexSystem = skillBody
      ? `${system}\n\n## Your specialist guidance (${role.skill})\n${skillBody}`
      : system;
    const r = await runCodex(
      ctx.api,
      {
        prompt: `${codexSystem}\n\n${task}`,
        workingDir: dispatch.worktreePath,
        agentSessionId: dispatch.agentSessionId,
        issueId: dispatch.issueId,
        issueIdentifier: dispatch.issueIdentifier,
        ...(resolveRoleModel(role, ctx.pluginConfig)
          ? { model: resolveRoleModel(role, ctx.pluginConfig) }
          : {}),
      },
      ctx.pluginConfig,
    );
    return { success: r.success, output: r.output };
  }

  const r = await runAgent({
    api: ctx.api,
    agentId: role.id,
    sessionId: `linear-${role.id}-${dispatch.issueIdentifier}-${dispatch.attempt}`,
    message: task,
    extraSystemPrompt: system,
    readOnly: role.readOnly,
    // No role agent may touch the Linear issue — all ticket-lifecycle changes
    // are the orchestrator's job (deterministic, config-driven, on success only).
    toolsDeny: roleToolsDeny(role),
    streaming: dispatch.agentSessionId
      ? { linearApi: ctx.linearApi, agentSessionId: dispatch.agentSessionId }
      : undefined,
    abortKey: dispatch.issueId,
  });
  return { success: r.success, output: r.output };
}

// ---------------------------------------------------------------------------
// Apex planning → assignments
// ---------------------------------------------------------------------------

/**
 * Parse Apex's routing JSON into implementer assignments. Falls back to a
 * single backend (Spine) assignment covering the whole issue when Apex's
 * output is unparseable or names no known implementer.
 * @param output - Apex's raw output
 * @param issue - the issue (used for the fallback task)
 * @returns the validated assignments (always at least one)
 */
export function parseAssignments(output: string, issue: OrchIssue): Assignment[] {
  const validIds = new Set(implementerRoles().map((r) => r.id));
  const fallback: Assignment[] = [
    { role: "spine", task: `Implement issue ${issue.identifier} end to end.` },
  ];

  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const o = JSON.parse(match[0]);
    if (!Array.isArray(o.assignments)) return fallback;
    const parsed: Assignment[] = o.assignments
      .filter((a: unknown) => a && typeof a === "object")
      .map((a: Record<string, unknown>) => ({
        role: String(a.role ?? "").toLowerCase(),
        task: String(a.task ?? "").trim(),
      }))
      .filter((a: Assignment) => validIds.has(a.role) && a.task);
    return parsed.length ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function runApexPlan(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  issue: OrchIssue,
): Promise<Assignment[]> {
  const roster = implementerRoles()
    .map((r) => `- ${r.id}: ${r.summary}`)
    .join("\n");
  const extra = [
    "Available implementer specialists:",
    roster,
    "",
    "Decide which specialists are needed and exactly what each must build.",
    "Assign the MINIMUM set that covers the work — prefer a single specialist unless",
    "the issue clearly spans concerns (e.g. backend + frontend).",
    "",
    "Respond with ONLY this JSON object (no prose):",
    '{"assignments":[{"role":"<id>","task":"<what this specialist must implement>"}],"notes":"<optional>"}',
  ].join("\n");

  const { output } = await runRole(ctx, dispatch, ROLES.apex, "plan", extra, issue);
  const assignments = parseAssignments(output, issue);

  const planText = assignments
    .map((a) => `- **${ROLES[a.role]?.label ?? a.role}** — ${a.task}`)
    .join("\n");
  await comment(ctx, dispatch, `## 🧭 Apex plan\n\n${planText}`);
  // Persist the plan so a future session can read it back on resume.
  try { savePlan(dispatch.worktreePath, `# Plan for ${dispatch.issueIdentifier}\n\n${planText}`); } catch { /* best effort */ }
  return assignments;
}

// ---------------------------------------------------------------------------
// Phase: plan-implement (Apex → implementers → Apex self-review → PR)
// ---------------------------------------------------------------------------

async function runImplementPhase(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  issue: OrchIssue,
): Promise<{ success: boolean; reason?: string }> {
  const limit = maxRework(ctx.pluginConfig);
  let assignments = await runApexPlan(ctx, dispatch, issue);
  let lastReason = "";

  for (let attempt = 0; attempt <= limit; attempt++) {
    setStatus(dispatch, attempt === 0 ? "implementing" : `reworking (attempt ${attempt + 1})`);
    // Implementers run sequentially — they share one worktree.
    const attemptOutputs: string[] = [];
    for (const a of assignments) {
      const role = resolveRole(a.role) ?? ROLES.spine;
      const { success, output } = await runRole(ctx, dispatch, role, "implement", a.task, issue);
      attemptOutputs.push(`## ${role.label}\n${output}`);
      if (!success) {
        lastReason = `${role.label} implementation failed: ${output.slice(-300)}`;
        // Keep going to self-review — codex may have partially applied changes.
      }
    }
    // Persist this attempt's implementer output for future-session recall.
    try { saveWorkerOutput(dispatch.worktreePath, attempt, attemptOutputs.join("\n\n")); } catch { /* best effort */ }
    try { appendLog(dispatch.worktreePath, { ts: new Date().toISOString(), phase: "worker", attempt, agent: assignments.map((a) => a.role).join("+"), prompt: "", outputPreview: attemptOutputs.join("\n\n").slice(0, 500), success: !lastReason, durationMs: 0 }); } catch { /* best effort */ }

    // Apex self-review — read-only, gates the phase.
    setStatus(dispatch, "reviewing");
    const review = await runRole(
      ctx,
      dispatch,
      ROLES.apex,
      "review",
      "Self-review the implemented work against the issue's acceptance criteria. " +
        "Confirm the code is complete and the tests pass. This is the gate before code review.",
      issue,
    );
    const verdict = parseReviewVerdict(review.output, "REVIEW");
    if (verdict.pass) {
      await openPr(ctx, dispatch, issue);
      return { success: true };
    }

    lastReason = verdict.reason;
    await comment(
      ctx,
      dispatch,
      `## 🔁 Apex self-review failed (attempt ${attempt + 1}/${limit + 1})\n\n${verdict.reason}`,
    );
    if (attempt < limit) {
      // Rework: re-run each implementer focused on the reviewer's findings.
      assignments = assignments.map((a) => ({
        role: a.role,
        task: `Fix the following review findings, preserving working code:\n${verdict.reason}`,
      }));
    }
  }

  return { success: false, reason: lastReason || "implementation did not pass self-review" };
}

/** Open a PR from the worktree so the Code Review phase has something to review. */
async function openPr(ctx: HookContext, dispatch: ActiveDispatch, issue: OrchIssue): Promise<void> {
  try {
    const status = getWorktreeStatus(dispatch.worktreePath);
    if (!status.hasUncommitted && !status.lastCommit) {
      ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no changes to open a PR`);
      return;
    }
    const { prUrl } = createPullRequest(
      dispatch.worktreePath,
      `${issue.identifier}: ${issue.title}`,
      `Implements ${issue.identifier}.\n\n_Opened by the state-driven agent pipeline (Apex → implementers → self-review)._`,
    );
    await comment(ctx, dispatch, `## ✅ Implementation complete\n\nPR: ${prUrl}`);
  } catch (err) {
    ctx.api.logger.warn(`[orchestrator] PR creation failed for ${issue.identifier}: ${err}`);
    await comment(ctx, dispatch, `## ⚠️ Implementation complete, PR creation failed\n\n\`${String(err).slice(0, 300)}\``);
  }
}

// ---------------------------------------------------------------------------
// Phase: review (Warden / Apex code-review / Proof QA) — gates
// ---------------------------------------------------------------------------

function reviewFocus(role: RoleDef): string {
  switch (role.id) {
    case "warden":
      return "Audit this change for security issues: authz/authn, secrets, injection, unsafe deserialization, and supply-chain risk.";
    case "proof":
      return "QA this change against the issue's acceptance criteria. Run the test suite. Check edge cases and regressions.";
    case "apex":
      return "Code-review this change for correctness, design, and adherence to project conventions.";
    default:
      return "Review this change.";
  }
}

async function runReviewPhase(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  issue: OrchIssue,
  role: RoleDef,
  gate: boolean,
): Promise<{ success: boolean; reason?: string }> {
  const limit = gate ? maxRework(ctx.pluginConfig) : 0;
  const tag = role.verdictTag ?? "REVIEW";
  let lastReason = "";

  for (let attempt = 0; attempt <= limit; attempt++) {
    const { output } = await runRole(ctx, dispatch, role, "review", reviewFocus(role), issue);
    const verdict = parseReviewVerdict(output, tag);
    await comment(
      ctx,
      dispatch,
      `## ${verdict.pass ? "✅" : "❌"} ${role.label} review — ${verdict.pass ? "pass" : "fail"}\n\n${verdict.reason}`,
    );

    if (verdict.pass) return { success: true };
    lastReason = verdict.reason;
    if (!gate) return { success: true }; // annotate-only reviewers never block

    if (attempt < limit) {
      // Bounded rework: send the finding back to a codex fix in the worktree.
      await runFix(ctx, dispatch, issue, `${role.label} found: ${verdict.reason}`);
    }
  }

  return { success: false, reason: lastReason || `${role.label} review failed` };
}

/** Re-open the worktree and have a codex implementer address a review finding. */
async function runFix(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  issue: OrchIssue,
  finding: string,
): Promise<void> {
  await runRole(
    ctx,
    dispatch,
    ROLES.spine,
    "implement",
    `A reviewer blocked this change. Fix it, preserving working code:\n${finding}`,
    issue,
  );
}

// ---------------------------------------------------------------------------
// Agent-decided state transition
// ---------------------------------------------------------------------------

async function transitionOnSuccess(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  plan: StatePlan,
  issue: OrchIssue,
): Promise<void> {
  if (!plan.onSuccess || !issue.teamId) return;
  try {
    const states = await ctx.linearApi.getTeamStates(issue.teamId);
    const target = resolveTargetState(plan.onSuccess, states);
    if (!target) {
      ctx.api.logger.warn(
        `[orchestrator] ${issue.identifier} no team state matched onSuccess ${JSON.stringify(plan.onSuccess)}`,
      );
      return;
    }
    await ctx.linearApi.updateIssue(dispatch.issueId, { stateId: target.id });
    await comment(ctx, dispatch, `## ➡️ Moving to **${target.name}**\n\nAll phases passed.`);
    ctx.api.logger.info(`[orchestrator] ${issue.identifier} → ${target.name}`);
  } catch (err) {
    ctx.api.logger.warn(`[orchestrator] transition failed for ${issue.identifier}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run a resolved state plan for a dispatch. Executes phases in order; on the
 * first phase failure it stops and posts a blocking comment WITHOUT moving the
 * ticket. On full success it advances the ticket to the plan's onSuccess state.
 * @param ctx - hook context (api, linearApi, notify, config, configPath)
 * @param dispatch - the active dispatch (worktree, session, attempt)
 * @param plan - the resolved state plan
 */
export async function runStatePlan(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  plan: StatePlan,
): Promise<void> {
  const details = await ctx.linearApi.getIssueDetails(dispatch.issueId).catch(() => null);
  const issue: OrchIssue = {
    id: dispatch.issueId,
    identifier: dispatch.issueIdentifier,
    title: details?.title ?? dispatch.issueTitle ?? dispatch.issueIdentifier,
    description: details?.description,
    teamId: details?.team?.id,
  };

  ensureManifest(dispatch);
  setStatus(dispatch, "orchestrating");
  emit(ctx, dispatch, {
    type: "thought",
    body: `Orchestrating "${plan.stateLabel}" — ${plan.phases.length} phase(s)`,
  });
  ctx.api.logger.info(
    `[orchestrator] ${issue.identifier} plan=${plan.stateLabel} phases=${plan.phases.map((p) => p.role ?? p.type).join(",")}`,
  );

  try {
    for (const phase of plan.phases) {
      const result = await runPhase(ctx, dispatch, issue, phase);
      if (!result.success) {
        const label = phase.role ? `${phase.type}:${phase.role}` : phase.type;
        const reason = result.reason ?? "phase failed";
        await comment(
          ctx,
          dispatch,
          `## ⛔ Blocked at ${label}\n\n${reason}\n\nThe ticket stays in its current state until this is resolved.`,
        );
        await ctx.notify("stuck", {
          identifier: dispatch.issueIdentifier,
          title: issue.title,
          status: "stuck",
          attempt: dispatch.attempt,
          reason: result.reason,
        }).catch(() => {});
        setStatus(dispatch, `blocked: ${label}`);
        // Terminal activity — ends the Linear agent turn (otherwise it hangs "active").
        endSession(ctx, dispatch, "response", `⛔ Blocked at ${label}: ${reason}\n\nThe ticket was left in its current state. Reply with guidance to retry.`);
        return;
      }
    }

    await transitionOnSuccess(ctx, dispatch, plan, issue);
    setStatus(dispatch, "done");
    await ctx.notify("audit_pass", {
      identifier: dispatch.issueIdentifier,
      title: issue.title,
      status: "done",
      attempt: dispatch.attempt,
    }).catch(() => {});
    endSession(ctx, dispatch, "response", `✅ Completed "${plan.stateLabel}" — all phases passed.`);
  } catch (err) {
    ctx.api.logger.error(`[orchestrator] ${issue.identifier} unexpected error: ${err}`);
    setStatus(dispatch, "error");
    endSession(ctx, dispatch, "error", `The pipeline hit an unexpected error: ${String(err).slice(0, 400)}`);
  }
}

/**
 * Emit the terminal Linear activity that ENDS the agent turn. Without this the
 * session shows "active" forever. `response` closes a normal turn (success or a
 * clean block); `error` marks a failed turn.
 * @param ctx - hook context
 * @param dispatch - the active dispatch (for the agent session id)
 * @param type - "response" for a normal end, "error" for a failure
 * @param body - the closing message shown in the session
 */
function endSession(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  type: "response" | "error",
  body: string,
): void {
  if (!dispatch.agentSessionId) return;
  ctx.linearApi.emitActivity(dispatch.agentSessionId, { type, body }).catch((err) => {
    ctx.api.logger.warn(`[orchestrator] terminal ${type} emit failed for ${dispatch.issueIdentifier}: ${err}`);
  });
}

/** Dispatch a single plan phase to its handler. */
async function runPhase(
  ctx: HookContext,
  dispatch: ActiveDispatch,
  issue: OrchIssue,
  phase: PlanPhase,
): Promise<{ success: boolean; reason?: string }> {
  if (phase.type === "plan-implement") {
    return runImplementPhase(ctx, dispatch, issue);
  }
  if (phase.type === "review") {
    const role = phase.role ? resolveRole(phase.role) : undefined;
    if (!role) return { success: false, reason: `unknown review role "${phase.role}"` };
    return runReviewPhase(ctx, dispatch, issue, role, phase.gate !== false);
  }
  if (phase.type === "product") {
    const role = phase.role ? resolveRole(phase.role) : undefined;
    if (!role) return { success: false, reason: `unknown product role "${phase.role}"` };
    const focus =
      role.id === "helm"
        ? "Turn this feature idea into a crisp product brief with goals, scope, and acceptance criteria."
        : "Define the metrics, funnels, and measurement plan for this feature.";
    const { success, output } = await runRole(ctx, dispatch, role, "product", focus, issue);
    if (success) await comment(ctx, dispatch, `## 📄 ${role.label}\n\n${output.slice(0, 4000)}`);
    return { success };
  }
  return { success: false, reason: `unknown phase type "${(phase as PlanPhase).type}"` };
}
