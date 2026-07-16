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
 * TRANSITIONS ARE CONFIG-DRIVEN: the ticket advances to onSuccess only when
 * every phase succeeds, or moves to onFailure after a gated failure. Terminal
 * runs close the Agent Session and release Issue.delegate by default.
 *
 * This path is opt-in via config `orchestrationMode: "stateplan"`; the default
 * single-worker pipeline (spawnWorker) is untouched.
 */
import { runAgent, READ_ONLY_DENY, HOST_CODE_RUNNER_DENY } from "../agent/agent.js";
import { execCodexInContainer, containerGitStatus, checkoutPullRequestInContainer, openPrInContainer, publishPullRequestReviewInContainer, repoWorkdir, WORK_ROOT, } from "../infra/container-runner.js";
import { readManifest, writeManifest, updateManifest, savePlan, saveWorkerOutput, appendLog } from "./artifacts.js";
import { completeDispatch, updateDispatchProgress } from "./dispatch-state.js";
import { ROLES, resolveRole, implementerRoles, buildRolePrompt, parseReviewVerdict, resolveRoleModel, resolveRoleBackend, loadSkillGuidance, roleToolsDeny, } from "./roles.js";
import { resolveTargetState, phaseAgentId, phaseKind } from "./state-plan.js";
import { buildWorkspacePrompt } from "./workspace-prompt.js";
import { getPlanApproval, savePlanApproval, clearPlanApproval } from "./plan-approval-state.js";
import { optionsSignal } from "./select-signal.js";
import { isCancelled, clearCancel } from "./cancellation.js";
import { isCodexHarnessSteeringEnabled } from "../agent/codex-steering.js";
import { createSessionPlan, getSessionPlan, disposeSessionPlan } from "./agent-plan.js";
import { captureNativeSubagentGeneration, waitForNativeSubagentBatch, } from "./native-subagent-batch.js";
/**
 * Deny list for the coding LEAD: host writes/exec/code-runners are blocked (all
 * mutation goes through container_* tools), but sessions_spawn/sessions_send
 * stay ALLOWED so the lead can delegate to its implementer subagents in-session.
 */
const CODING_LEAD_DENY = [
    ...READ_ONLY_DENY.filter((tool) => tool !== "sessions_spawn" && tool !== "sessions_send"),
    ...HOST_CODE_RUNNER_DENY,
];
/** The agent id that leads the coding phase (delegates to subagents). */
function codingLeadAgentId(pluginConfig) {
    return pluginConfig?.codingLeadAgentId || pluginConfig?.implementerAgentId || "apex";
}
/** Whether the Apex plan-approval gate is active (default on). */
function planApprovalEnabled(pluginConfig) {
    return pluginConfig?.planApprovalGate !== false;
}
/** Whether to publish the native Linear agent-session plan checklist (default on). */
function agentPlansEnabled(pluginConfig) {
    return pluginConfig?.agentPlans !== false;
}
/**
 * Whether a terminal outcome moves the ticket to the plan's next defined state
 * (onSuccess / onFailure). Default on. Turn off to leave the ticket where it is
 * (e.g. when a human drives the column changes).
 */
function moveTicketOnFinish(pluginConfig) {
    return pluginConfig?.moveTicketOnFinish !== false;
}
/**
 * Whether a terminal outcome releases (unassigns) the app from Issue.delegate.
 * Default on. Set false to keep the agent delegated across the transition so the
 * next state's own webhook re-triggers it — letting one agent carry a ticket
 * end-to-end through every stage without a human re-delegating each step.
 */
function unassignSelfOnFinish(pluginConfig) {
    return pluginConfig?.unassignSelfOnFinish !== false;
}
/**
 * Human label for a phase's row in the agent-session plan checklist.
 * @param phase - the plan phase
 * @returns a short label, e.g. "Implement", "Code review (Warden)", "QA"
 */
function phaseLabel(phase) {
    const kind = phaseKind(phase);
    const agentLabel = (() => {
        const id = phaseAgentId(phase);
        return id ? (resolveRole(id)?.label ?? id) : undefined;
    })();
    if (kind === "plan-implement")
        return "Implement";
    if (kind === "qa")
        return agentLabel ? `QA (${agentLabel})` : "QA";
    return agentLabel ? `Code review (${agentLabel})` : "Code review";
}
/** Max bounded rework attempts (config `maxReworkAttempts`, default 2). */
function maxRework(pluginConfig) {
    const v = pluginConfig?.maxReworkAttempts;
    return typeof v === "number" && v >= 0 ? v : 2;
}
/** Codex inactivity + hard timeouts (config `inactivitySec`/`toolTimeoutSec`). */
function resolveCodexTimeouts(cfg) {
    const inactivitySec = typeof cfg?.inactivitySec === "number" ? cfg.inactivitySec : 3600;
    const toolTimeoutSec = typeof cfg?.toolTimeoutSec === "number" ? cfg.toolTimeoutSec : 7200;
    return { inactivityMs: inactivitySec * 1000, timeoutMs: toolTimeoutSec * 1000 };
}
/**
 * Ensure a `.claw/manifest.json` exists so updateManifest / buildSummaryFromArtifacts
 * work and a future session can read this run's status. Best-effort.
 */
function ensureManifest(dispatch) {
    try {
        if (readManifest(dispatch.worktreePath))
            return;
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
    }
    catch { /* best effort */ }
}
/** Update the manifest status (best-effort). */
function setStatus(dispatch, status) {
    try {
        updateManifest(dispatch.worktreePath, { status });
    }
    catch { /* best effort */ }
}
/** Stream an activity line to the ticket's Linear agent session (best-effort). */
function emit(ctx, dispatch, content) {
    if (!dispatch.agentSessionId)
        return;
    ctx.linearApi.emitActivity(dispatch.agentSessionId, content).catch(() => { });
}
/** Post a comment to the ticket (best-effort). */
async function comment(ctx, dispatch, body) {
    await ctx.linearApi.createComment(dispatch.issueId, body).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] comment failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
// ---------------------------------------------------------------------------
// Task-body builder (the DATA; the persona/skill lives in the system prompt)
// ---------------------------------------------------------------------------
function buildRoleTask(issue, dispatch, extra) {
    const repos = dispatch.containerRepos ?? [];
    const workspace = repos.length
        ? repos.map((r) => `${r}: ${repoWorkdir(r)}`).join("\n")
        : WORK_ROOT;
    return [
        `Linear issue ${issue.identifier}: ${issue.title}`,
        issue.description ? `\nIssue body:\n${issue.description}` : "",
        `\nRepositories prepared in the ticket container:\n${workspace}`,
        dispatch.reviewPullRequests?.length
            ? `\nLinked pull request(s) — these exact diffs are authoritative:\n${dispatch.reviewPullRequests
                .map((pr) => `- ${pr.repoName}: ${pr.url}`)
                .join("\n")}`
            : "",
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
async function runRole(ctx, dispatch, role, phase, extra, issue) {
    // With harness steering enabled, every specialist runs through OpenClaw's
    // embedded Codex app-server turn and operates on the ticket container via
    // container_* tools. Otherwise preserve the direct in-container Codex review
    // path that avoids connector-based serial GitHub reads.
    const harnessSteering = isCodexHarnessSteeringEnabled(ctx.pluginConfig);
    const backend = harnessSteering
        ? "embedded"
        : phase === "review"
            ? "codex"
            : resolveRoleBackend(role, ctx.pluginConfig);
    const system = buildRolePrompt(role, { identifier: dispatch.issueIdentifier, phase, backend, extra });
    const task = buildRoleTask(issue, dispatch, extra);
    emit(ctx, dispatch, { type: "thought", body: `[${role.label}] starting ${phase} (${backend})` });
    ctx.api.logger.info(`[orchestrator] ${dispatch.issueIdentifier} role=${role.id} phase=${phase} backend=${backend}`);
    if (backend === "codex") {
        // codex has no OpenClaw skill system — inline the role's SKILL.md body so
        // the specialist guidance actually reaches it (falls back to the persona
        // line already in `system` when the skill file isn't deployed).
        const skillBody = loadSkillGuidance(role, ctx.pluginConfig);
        const codexSystem = skillBody
            ? `${system}\n\n## Your specialist guidance (${role.skill})\n${skillBody}`
            : system;
        if (!dispatch.containerName) {
            return { success: false, output: "No container provisioned for this dispatch — cannot run codex." };
        }
        // Single target repo → run inside it; multiple → run at /work so the agent
        // can work across the cloned repos.
        const repos = dispatch.containerRepos ?? [];
        const workdir = repos.length === 1 ? repoWorkdir(repos[0]) : WORK_ROOT;
        const { inactivityMs, timeoutMs } = resolveCodexTimeouts(ctx.pluginConfig);
        const r = await execCodexInContainer({
            containerName: dispatch.containerName,
            workdir,
            prompt: `${codexSystem}\n\n${task}`,
            model: resolveRoleModel(role, ctx.pluginConfig) ?? ctx.pluginConfig?.codexModel,
            effort: ctx.pluginConfig?.codexReasoningEffort,
            timeoutMs,
            inactivityMs,
            linearApi: ctx.linearApi,
            agentSessionId: dispatch.agentSessionId,
            // Reviewers need only the already-synced local checkout. The orchestrator
            // performs authenticated PR refresh/publication outside the model turn,
            // so no GitHub credential is exposed to review Codex.
            githubRole: phase === "implement" ? "coding" : undefined,
            githubRepositories: repos,
            pluginConfig: ctx.pluginConfig,
            logger: ctx.api.logger,
        });
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
        issueIdentifier: dispatch.issueIdentifier,
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
export function parseAssignments(output, issue) {
    const validIds = new Set(implementerRoles().map((r) => r.id));
    const fallback = [
        {
            role: "spine",
            task: `Implement issue ${issue.identifier} end to end.`,
            steps: [
                "Read the issue and locate the affected code in the ticket container.",
                "Make the change, keeping it scoped to what the issue asks for.",
                "Verify with the project's build/tests and commit on the ticket branch.",
            ],
        },
    ];
    const match = output.match(/\{[\s\S]*\}/);
    if (!match)
        return fallback;
    try {
        const o = JSON.parse(match[0]);
        if (!Array.isArray(o.assignments))
            return fallback;
        const parsed = o.assignments
            .filter((a) => a && typeof a === "object")
            .map((a) => ({
            role: String(a.role ?? "").toLowerCase(),
            task: String(a.task ?? "").trim(),
            steps: Array.isArray(a.steps)
                ? a.steps.map((s) => String(s).trim()).filter(Boolean)
                : undefined,
        }))
            .filter((a) => validIds.has(a.role) && a.task);
        return parsed.length ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
/**
 * Render an assignment list as a Markdown plan — one section per specialist with
 * its ordered, step-by-step breakdown nested beneath. Shared by the Apex plan
 * comment, the persisted plan, and the plan-approval prompt so every surface
 * shows the same step-by-step detail (never a bare "implement the issue" line).
 * @param assignments - the plan assignments
 * @returns Markdown suitable for a Linear comment body
 */
function renderPlanMarkdown(assignments) {
    return assignments
        .map((a) => {
        const label = ROLES[a.role]?.label ?? a.role;
        const header = `- **${label}** — ${a.task}`;
        if (!a.steps?.length)
            return header;
        const steps = a.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n");
        return `${header}\n${steps}`;
    })
        .join("\n");
}
async function runApexPlan(ctx, dispatch, issue, feedback) {
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
        "Lay the work out STEP BY STEP: every assignment MUST carry an ordered `steps` array of",
        "concrete actions (files/areas to touch, what to build, how to verify) — enough that a",
        "reviewer could follow along. Do NOT hand a specialist a single vague task like",
        '"implement the issue"; decompose it into real steps.',
        feedback ? `\nThe user reviewed your previous plan and asked for changes:\n${feedback}\nRevise the plan accordingly.` : "",
        "",
        "Respond with ONLY this JSON object (no prose):",
        '{"assignments":[{"role":"<id>","task":"<one-line goal for this specialist>","steps":["<ordered concrete action>","<next action>"]}],"notes":"<optional>"}',
    ].filter(Boolean).join("\n");
    const { output } = await runRole(ctx, dispatch, ROLES.apex, "plan", extra, issue);
    const assignments = parseAssignments(output, issue);
    const planText = renderPlanMarkdown(assignments);
    await comment(ctx, dispatch, `## 🧭 Apex plan\n\n${planText}`);
    // Persist the plan so a future session can read it back on resume.
    try {
        savePlan(dispatch.worktreePath, `# Plan for ${dispatch.issueIdentifier}\n\n${planText}`);
    }
    catch { /* best effort */ }
    return assignments;
}
/**
 * Present Apex's plan to the user and ask for approval before any implementer
 * runs. Emits a clickable Approve / Request-changes elicitation into the agent
 * session (falls back to a Linear comment when there is no session).
 * @param ctx - hook context
 * @param dispatch - the active dispatch
 * @param assignments - the plan to present
 */
async function presentPlanForApproval(ctx, dispatch, assignments) {
    const planText = renderPlanMarkdown(assignments);
    const body = `## 🧭 Plan ready for your approval\n\n${planText}\n\n` +
        `Reply **approve** to proceed, or tell me what to change.`;
    if (dispatch.agentSessionId) {
        await ctx.linearApi
            .emitActivity(dispatch.agentSessionId, { type: "elicitation", body }, optionsSignal(["Approve", "Request changes"]))
            .catch((err) => ctx.api.logger.warn(`[orchestrator] plan-approval elicitation failed for ${dispatch.issueIdentifier}: ${err}`));
    }
    else {
        await comment(ctx, dispatch, body);
    }
}
// ---------------------------------------------------------------------------
// Phase: plan-implement (Apex → implementers → Apex self-review → PR)
// ---------------------------------------------------------------------------
/**
 * Whether implementers run as a single steerable OpenClaw agent driving the
 * container via tools, versus direct `codex exec` per specialist. The public
 * `workerBackend` setting selects the path so stateplan and single-worker
 * orchestration obey the same configuration.
 * @param cfg - plugin config
 * @returns true when the container-agent path should be used
 */
export function implementerUsesContainerAgent(cfg) {
    return isCodexHarnessSteeringEnabled(cfg) || cfg?.workerBackend !== "codex";
}
/**
 * Run ONE OpenClaw agent that implements the issue inside its per-ticket
 * container. The agent's host filesystem is read-only (READ_ONLY_DENY); its only
 * way to change anything is the container_* tools, so all writes are isolated to
 * the container. A stable per-ticket session id keeps it continuous/steerable
 * across turns.
 * @param ctx - hook context
 * @param dispatch - the active dispatch
 * @param issue - the issue context
 * @param assignments - Apex's specialist plan (used as the implementation brief)
 * @param reworkNote - review findings to address on a rework attempt
 * @returns the agent run result
 */
async function runContainerImplement(ctx, dispatch, issue, assignments, reworkNote) {
    const repos = dispatch.containerRepos ?? [];
    const plan = assignments
        .map((a) => `- ${resolveRole(a.role)?.label ?? a.role}: ${a.task}`)
        .join("\n");
    const lead = resolveRole(codingLeadAgentId(ctx.pluginConfig)) ?? ROLES.apex;
    const workspace = buildWorkspacePrompt({
        identifier: dispatch.issueIdentifier,
        repos: repos.map((r) => ({ name: r, workdir: repoWorkdir(r) })),
        kind: "plan-implement",
    });
    const delegates = (lead.subagents ?? [])
        .map((id) => `${id} (${resolveRole(id)?.summary ?? id})`)
        .join("\n- ");
    const system = [
        `You are ${lead.label}, ${lead.summary}`,
        workspace,
        "",
        "## Leading this implementation",
        "HARD RULES — everything runs INSIDE this ticket's container:",
        "- Run EVERY shell command (including the first inspection like `git status`/`git log`) through `container_exec`.",
        "  NEVER use the host `bash`/shell tool — the host is read-only and such calls are declined and waste the turn.",
        "- NEVER use `cli_codex`, `cli_claude`, or `cli_gemini` — those spawn a code process on the HOST, outside the",
        "  container. You do not have them. Delegate to specialists with `sessions_spawn`; do the rest with `container_*`.",
        "Scope the change, then DELEGATE each piece to the right specialist SUBAGENT via sessions_spawn — do not write",
        "the code yourself. Your subagents:",
        delegates ? `- ${delegates}` : "- (no subagents configured — implement directly via container_* tools)",
        "Your specialists are DIFFERENT agents from you, so you MUST spawn each with `context: \"isolated\"`. Do NOT use",
        "`context: \"fork\"` — fork only works for a same-agent spawn and will error for a specialist. Each isolated",
        `subagent is automatically bound to THIS ticket's container (Linear ${issue.identifier}), shares your exact`,
        "workspace, and — like you — may only mutate through the container_* tools (host is read-only), so every change",
        "lands in the same repos. When you spawn one, name the ticket and give it a precise task plus the repos/paths to",
        "touch; it starts fresh, so include the context it needs. Tell it explicitly: run ALL commands via container_exec",
        "(never the host bash tool), and its FIRST action is to publish its OWN short, numbered plan for its slice (the",
        "files it will touch and how it will verify) as a brief progress update BEFORE editing — so each specialist's",
        "plan, not just yours, is visible — then post a one-line progress note every few tool batches so it never goes",
        "silent. Wait for each subagent before reviewing its work.",
        "After they finish, VERIFY by running the project's build/tests via container_exec, and make sure every",
        `change is committed in each repo on branch \`${dispatch.branch}\` with this structured message:`,
        "",
        `  ${issue.identifier}: <concise summary>`,
        "",
        "  Changelog:",
        "  - <observable code change>",
        "",
        "  Validation:",
        "  - <command>: pass",
        "",
        "On a self-review remediation turn, create a NEW commit with the same structure; never amend, squash, or",
        "overwrite an earlier commit. Do NOT push, open a PR, or start a reviewer — the orchestrator owns push, PR",
        "creation, and review after you return control.",
        dispatch.grillGuidance ? `\n## Clarified requirements\n${dispatch.grillGuidance}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    const task = [
        `Issue ${issue.identifier}: ${issue.title}`,
        issue.description ? `\nIssue body:\n${issue.description}` : "",
        plan ? `\nSuggested breakdown:\n${plan}` : "",
        reworkNote ? `\n${reworkNote}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    // Run as the coding LEAD agent (default "apex") so its configured
    // subagents.allowAgents apply and it can delegate via sessions_spawn.
    const agentId = codingLeadAgentId(ctx.pluginConfig);
    const subagentGeneration = captureNativeSubagentGeneration(dispatch.issueIdentifier);
    const r = await runAgent({
        api: ctx.api,
        agentId,
        // Stable per-ticket session → one continuous, steerable lead.
        sessionId: `linear-impl-${dispatch.issueIdentifier}`,
        message: task,
        extraSystemPrompt: system,
        // Deny host writes/exec (mutations go through container_* only) but KEEP
        // sessions_spawn/sessions_send so the lead can delegate to subagents.
        toolsDeny: CODING_LEAD_DENY,
        issueIdentifier: dispatch.issueIdentifier,
        streaming: dispatch.agentSessionId
            ? { linearApi: ctx.linearApi, agentSessionId: dispatch.agentSessionId }
            : undefined,
        abortKey: dispatch.issueId,
    });
    const batch = await waitForNativeSubagentBatch(dispatch.issueIdentifier, subagentGeneration, {
        timeoutMs: typeof ctx.pluginConfig?.subagentWaitTimeoutMs === "number"
            ? ctx.pluginConfig.subagentWaitTimeoutMs
            : undefined,
        isCancelled: () => isCancelled(dispatch.issueId),
    });
    if (!batch.spawned)
        return { success: r.success, output: r.output };
    if (batch.cancelled) {
        return { success: false, output: "Specialist batch was cancelled." };
    }
    if (batch.timedOut) {
        return { success: false, output: "Timed out waiting for the delegated specialist batch." };
    }
    const failures = batch.outcomes.filter((entry) => entry.outcome !== "ok");
    const specialistSummary = batch.outcomes
        .map((entry) => `${entry.key}: ${entry.outcome}${entry.detail ? ` — ${entry.detail}` : ""}`)
        .join("\n");
    return {
        success: r.success && failures.length === 0,
        output: [r.output, specialistSummary].filter(Boolean).join("\n\n"),
    };
}
async function runImplementPhase(ctx, dispatch, issue, resumeGuidance) {
    const limit = maxRework(ctx.pluginConfig);
    const gateOn = planApprovalEnabled(ctx.pluginConfig);
    const approval = gateOn ? getPlanApproval(dispatch.issueId) : undefined;
    const inApprovalLoop = gateOn && approval && approval.status !== "approved";
    const continuationAssignment = (guidance) => [{
            role: "spine",
            task: [
                "Continue the existing implementation in the preserved ticket workspace and OpenClaw session.",
                "Inspect the current work before changing it; do not restart completed work.",
                `User continuation: ${guidance}`,
            ].join("\n"),
        }];
    // Resolve the plan. Approved plans win (use the exact assignments the user
    // signed off on). In the approval loop a user reply is change-request feedback
    // → re-plan with it. Otherwise: a normal resume continues, a fresh turn plans.
    let assignments;
    if (approval?.status === "approved") {
        assignments = approval.assignments?.length ? approval.assignments : await runApexPlan(ctx, dispatch, issue);
    }
    else if (inApprovalLoop) {
        assignments = await runApexPlan(ctx, dispatch, issue, resumeGuidance);
    }
    else if (resumeGuidance) {
        assignments = continuationAssignment(resumeGuidance);
    }
    else {
        assignments = await runApexPlan(ctx, dispatch, issue);
    }
    // Nest Apex's plan under the Implement row of the session plan as a per-
    // specialist tree: one row per specialist (Spine, Forge, …), with that
    // specialist's ordered steps beneath it. Statuses flip live as each spawned
    // subagent starts/finishes (see the subagent lifecycle hooks). Shown at the
    // approval gate too. A specialist with no steps falls back to its task line.
    const sessionPlan = getSessionPlan(dispatch.issueIdentifier);
    const implementPhaseIndex = dispatch.phaseIndex ?? 0;
    const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const planAssignments = assignments.map((a) => ({
        key: a.role,
        label: ROLES[a.role]?.label ?? a.role,
        steps: (a.steps?.length ? a.steps : [a.task]).map((step) => clip(step, 90)),
    }));
    sessionPlan?.setAssignments(implementPhaseIndex, planAssignments);
    sessionPlan?.clearPreparing();
    await sessionPlan?.flush();
    // Plan-approval gate: pause for the user's sign-off BEFORE any implementer runs.
    // Fires on a fresh planning turn or while iterating the plan (pending approval);
    // a plain STOP→continue (resumeGuidance with no pending approval) is NOT gated.
    if (gateOn && approval?.status === "approved") {
        clearPlanApproval(dispatch.issueId);
        emit(ctx, dispatch, { type: "thought", body: "✅ Plan approved — implementing." });
    }
    else if (gateOn && (approval?.status === "pending" || !resumeGuidance)) {
        await presentPlanForApproval(ctx, dispatch, assignments);
        const rounds = (approval?.rounds ?? 0) + 1;
        savePlanApproval({
            issueId: dispatch.issueId,
            issueIdentifier: dispatch.issueIdentifier,
            agentSessionId: dispatch.agentSessionId,
            status: "pending",
            assignments,
            rounds,
            createdAt: new Date().toISOString(),
        });
        // Pause like a STOP — the webhook resumes on the user's approve/feedback reply.
        return { success: false, reason: "halted" };
    }
    let lastReason = "";
    let lastReviewFindings = "";
    const useContainerAgent = implementerUsesContainerAgent(ctx.pluginConfig);
    // Container path: each specialist's row flips live via the subagent lifecycle
    // hooks as Apex spawns/finishes it. The direct-codex path has no such signal,
    // so mark the whole breakdown in-progress up front there.
    if (!useContainerAgent) {
        sessionPlan?.setPhaseAssignmentsStatus(implementPhaseIndex, "inProgress");
        await sessionPlan?.flush();
    }
    for (let attempt = 0; attempt <= limit; attempt++) {
        if (isCancelled(dispatch.issueId))
            return { success: false, reason: "halted" };
        let beforeStatuses;
        let beforeCommits;
        try {
            beforeStatuses = readRepoStatuses(dispatch);
            beforeCommits = new Map(beforeStatuses.map(({ repo, status }) => [repo, status.lastCommit]));
        }
        catch (err) {
            return { success: false, reason: `could not inspect the ticket workspace before implementation: ${err}` };
        }
        setStatus(dispatch, attempt === 0 ? "implementing" : `reworking (attempt ${attempt + 1})`);
        const attemptOutputs = [];
        if (useContainerAgent) {
            // One steerable agent per ticket, editing + running ONLY inside its container.
            const { success, output } = await runContainerImplement(ctx, dispatch, issue, assignments, reworkNoteFrom(lastReviewFindings || lastReason, attempt));
            attemptOutputs.push(output);
            lastReason = success ? "" : `implementation agent failed: ${output.slice(-300)}`;
        }
        else {
            // Direct codex exec per specialist, sharing the container.
            let attemptFailure = "";
            for (const a of assignments) {
                if (isCancelled(dispatch.issueId))
                    return { success: false, reason: "halted" };
                const role = resolveRole(a.role) ?? ROLES.spine;
                const commitContract = [
                    a.task,
                    "",
                    `Commit all changes on ${dispatch.branch} using this structure:`,
                    `${issue.identifier}: <concise summary>`,
                    "",
                    "Changelog:",
                    "- <observable code change>",
                    "",
                    "Validation:",
                    "- <command>: pass",
                    attempt > 0
                        ? "This is self-review remediation: create a NEW commit; do not amend or squash the coder commit."
                        : "",
                ].filter(Boolean).join("\n");
                const { success, output } = await runRole(ctx, dispatch, role, "implement", commitContract, issue);
                attemptOutputs.push(`## ${role.label}\n${output}`);
                if (!success) {
                    attemptFailure = `${role.label} implementation failed: ${summarizeImplementationFailure(output)}`;
                    // Keep going to self-review — codex may have partially applied changes.
                }
            }
            lastReason = attemptFailure;
        }
        // Persist this attempt's implementer output for future-session recall.
        try {
            saveWorkerOutput(dispatch.worktreePath, attempt, attemptOutputs.join("\n\n"));
        }
        catch { /* best effort */ }
        try {
            appendLog(dispatch.worktreePath, { ts: new Date().toISOString(), phase: "worker", attempt, agent: assignments.map((a) => a.role).join("+"), prompt: "", outputPreview: attemptOutputs.join("\n\n").slice(0, 500), success: !lastReason, durationMs: 0 });
        }
        catch { /* best effort */ }
        // STOP may land while the worker is in-flight. Do not run the no-change
        // guard (or leak the worker's final tool output into Linear) after that.
        if (isCancelled(dispatch.issueId))
            return { success: false, reason: "halted" };
        let repoStatuses;
        try {
            repoStatuses = readRepoStatuses(dispatch);
        }
        catch (err) {
            return { success: false, reason: `could not verify committed implementation output: ${err}` };
        }
        // The summary/validation turn is preserved, but the review gate only sees
        // explicit commits. Publication must never manufacture a fallback commit.
        const dirtyRepos = repoStatuses
            .filter(({ status }) => status.hasUncommitted)
            .map(({ repo }) => repo);
        if (dirtyRepos.length) {
            lastReason = `implementation left uncommitted changes in ${dirtyRepos.join(", ")}`;
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚠️ ${lastReason} (attempt ${attempt + 1}/${limit + 1})`,
            });
            if (attempt < limit)
                continue;
            break; // budget spent — ship whatever is committed (self-review is advisory)
        }
        // No-change guard: never review an untouched workspace, even when an agent
        // reports success. Commits already preserved before a resumed turn remain
        // valid; a self-review remediation attempt must add a distinct new commit.
        if (!repoStatuses.some(({ status }) => status.hasChanges)) {
            lastReason = lastReason || "implementation agent completed without producing code changes or commits";
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚠️ No code changes were produced (attempt ${attempt + 1}/${limit + 1}): ${lastReason}`,
            });
            if (attempt < limit) {
                if (!useContainerAgent) {
                    assignments = assignments.map((a) => ({
                        role: a.role,
                        task: `The previous implementation attempt produced no code changes or commits. Implement the assigned work now and verify it:\n${a.task}`,
                    }));
                }
                continue; // give rework a shot before giving up
            }
            break; // budget spent — shipImplementation blocks only if nothing is committed
        }
        const newlyCommitted = repoStatuses.filter(({ repo, status }) => beforeCommits.get(repo) !== status.lastCommit);
        const unstructuredCommits = newlyCommitted
            .filter(({ status }) => !status.lastCommitMessage.startsWith(`${issue.identifier}:`) ||
            !/(?:^|\n)Changelog:\s*(?:\n|$)/.test(status.lastCommitMessage) ||
            !/(?:^|\n)Validation:\s*(?:\n|$)/.test(status.lastCommitMessage))
            .map(({ repo }) => repo);
        if (unstructuredCommits.length) {
            lastReason =
                `commit message in ${unstructuredCommits.join(", ")} must start with ` +
                    `"${issue.identifier}:" and include Changelog: and Validation: sections`;
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚠️ ${lastReason} (attempt ${attempt + 1}/${limit + 1})`,
            });
            if (attempt < limit)
                continue;
            break; // budget spent — ship the committed work; format is a code-review note
        }
        const requiresNewCommit = attempt > 0 ||
            (!resumeGuidance && beforeStatuses.some(({ status }) => status.hasChanges));
        if (requiresNewCommit &&
            !repoStatuses.some(({ repo, status }) => beforeCommits.get(repo) !== status.lastCommit)) {
            lastReason = "remediation did not create a separate commit";
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚠️ ${lastReason} (attempt ${attempt + 1}/${limit + 1})`,
            });
            if (attempt < limit)
                continue;
            break; // budget spent — ship the commits we do have rather than block
        }
        // Apex self-review — read-only, gates the phase.
        if (isCancelled(dispatch.issueId))
            return { success: false, reason: "halted" };
        setStatus(dispatch, "reviewing");
        const reviewedCommits = repoStatuses
            .filter(({ status }) => status.hasChanges)
            .map(({ repo, status }) => `- ${repo}: ${status.lastCommit}`)
            .join("\n");
        const verdict = await runStructuredReview(ctx, dispatch, issue, 
        // Read-only reviewer for the self-review gate (apex is now the writable lead).
        ROLES["apex-reviewer"] ?? ROLES.apex, [
            "Self-review the coder commits in the existing Docker workspace against the issue's acceptance criteria.",
            "Inspect the local refs/openclaw/base..HEAD diff in every changed repository; do not use GitHub APIs or connector tools.",
            "Confirm the code is complete and the reported validation is credible. This is the gate before code review.",
            "Commits under review:",
            reviewedCommits,
        ].join("\n"));
        if (verdict.pass) {
            sessionPlan?.setPhaseAssignmentsStatus(implementPhaseIndex, "completed");
            await sessionPlan?.flush();
            const publication = await openPr(ctx, dispatch, issue);
            if (publication.success)
                return { success: true };
            return publication;
        }
        lastReason = verdict.reason;
        lastReviewFindings = verdict.output.trim().slice(-12_000) || verdict.reason;
        if (verdict.infrastructureFailure) {
            // Self-review tooling broke — it's advisory, not a code verdict, so ship
            // the committed work (a human code review remains the real gate) rather
            // than block; don't attach the tooling error as a review finding.
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚙️ Apex self-review tooling failed (attempt ${attempt + 1}/${limit + 1}) — shipping for human code review: ${verdict.reason}`,
            });
            lastReviewFindings = "";
            break;
        }
        emit(ctx, dispatch, {
            type: "thought",
            body: attempt < limit
                ? `🔁 Apex self-review found issues (attempt ${attempt + 1}/${limit + 1}) — fixing autonomously: ${verdict.reason}`
                : `🚢 Apex self-review still has findings after ${limit + 1} attempt(s) — shipping for human code review: ${verdict.reason}`,
        });
        if (attempt < limit && !useContainerAgent) {
            // Legacy codex rework: re-task each implementer on the reviewer's findings.
            // (The container agent gets the findings via reworkNoteFrom(lastReason).)
            assignments = assignments.map((a) => ({
                role: a.role,
                task: `Fix the following review findings, preserving working code:\n${verdict.reason}`,
            }));
        }
    }
    // Attempt budget spent. Self-review is advisory — publish whatever valid
    // committed work exists so a human code review can proceed, attaching any
    // unresolved findings to the PR. Blocks only when nothing is committed.
    return shipImplementation(ctx, dispatch, issue, lastReason || "implementation did not pass self-review", lastReviewFindings);
}
/**
 * Reduce a failed worker transcript to a short, human-readable reason. Codex
 * transcripts contain command output; the last command can be a multi-megabyte
 * base64 payload, which must never become a Linear failure message.
 * @param output - raw worker output
 * @returns bounded failure summary with encoded/tool payloads removed
 */
export function summarizeImplementationFailure(output) {
    const explicit = output.match(/(?:Codex (?:failed|timed out|killed)[^\n]*|inactivity watchdog[^\n]*|exit \d+)/i)?.[0];
    if (explicit)
        return explicit.slice(0, 300);
    const cleaned = output
        .replace(/```[\s\S]*?```/g, " [tool output omitted] ")
        .replace(/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, "[encoded tool output omitted]")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned)
        return "worker exited without a readable error";
    return cleaned.slice(-300);
}
/**
 * Build the rework instruction for a container-agent retry, or undefined on the
 * first attempt / when there's nothing to address.
 * @param lastReason - the previous attempt's failure/verdict reason
 * @param attempt - the current attempt index (0-based)
 * @returns a rework note, or undefined
 */
function reworkNoteFrom(lastReason, attempt) {
    if (attempt === 0 || !lastReason)
        return undefined;
    return `This is rework attempt ${attempt + 1}. Address these review findings, preserving working code:\n${lastReason}`;
}
/** Read every prepared repository's local git state from the ticket container. */
function readRepoStatuses(dispatch) {
    const repos = dispatch.containerRepos ?? [];
    if (!dispatch.containerName || !repos.length) {
        throw new Error("no ticket container or repositories are available");
    }
    return repos.map((repo) => ({
        repo,
        status: containerGitStatus(dispatch.containerName, repo),
    }));
}
/**
 * Whether any target repo has working-tree changes or commits since provisioning.
 * Best-effort: a git-status probe that throws is treated as "no changes" for that
 * repo. Used as a hard gate to avoid running a self-review over an untouched
 * workspace, even when the implementation agent reported success.
 * @param dispatch - the active dispatch (needs containerName + containerRepos)
 * @returns true if at least one repo shows changes
 */
export function hasAnyChanges(dispatch) {
    const repos = dispatch.containerRepos ?? [];
    if (!dispatch.containerName || !repos.length)
        return false;
    for (const repo of repos) {
        try {
            if (containerGitStatus(dispatch.containerName, repo).hasChanges)
                return true;
        }
        catch {
            /* treat probe failure as no-signal */
        }
    }
    return false;
}
/**
 * Open a PR per changed repo (cross-repo aware) from inside the container so the
 * Code Review phase has something to review. Repos with no changes are skipped.
 */
async function openPr(ctx, dispatch, issue, selfReviewNote) {
    const repos = dispatch.containerRepos ?? [];
    if (!dispatch.containerName || !repos.length) {
        ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no container/repos to open a PR`);
        return { success: false, reason: "no ticket container or repositories were available for publication" };
    }
    const opened = [];
    const failures = [];
    const note = selfReviewNote?.trim();
    const flagged = note
        ? `> ⚠️ **Unresolved self-review findings** — the autonomous fix loop did not fully clear these; ` +
            `flagged here for code review:\n>\n${note.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
        : "";
    const body = `Implements ${issue.identifier}.\n\n${flagged}_Opened by the state-driven agent pipeline (Apex → implementers → self-review)._`;
    for (const repo of repos) {
        try {
            const status = containerGitStatus(dispatch.containerName, repo);
            if (!status.hasChanges) {
                continue;
            }
            const prUrl = await openPrInContainer(dispatch.containerName, repo, dispatch.branch, `${issue.identifier}: ${issue.title}`, body, ctx.pluginConfig);
            if (prUrl)
                opened.push(`**${repo}**: ${prUrl}`);
        }
        catch (err) {
            ctx.api.logger.warn(`[orchestrator] PR failed for ${issue.identifier}/${repo}: ${err}`);
            failures.push(`**${repo}**: ${String(err).slice(0, 200)}`);
        }
    }
    if (opened.length) {
        const caveat = note
            ? `\n\n> ⚠️ Shipped with unresolved self-review findings (carried on the PR for code review):\n> ${note.split("\n").join("\n> ")}`
            : "";
        await comment(ctx, dispatch, `## ✅ Implementation complete\n\nPR(s):\n${opened.map((o) => `- ${o}`).join("\n")}${caveat}`);
        if (!failures.length)
            return { success: true };
    }
    if (failures.length) {
        await comment(ctx, dispatch, `## ⚠️ Implementation complete, PR creation failed\n\n${failures.map((f) => `- ${f}`).join("\n")}`);
        return {
            success: false,
            reason: `could not publish every changed repository: ${failures.join("; ")}`,
        };
    }
    ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no pull request URL was produced`);
    emit(ctx, dispatch, { type: "thought", body: "No pull request URL was produced for the committed changes." });
    return { success: false, reason: "committed changes were not published to a pull request" };
}
/**
 * Publish the committed implementation to a PR once the attempt budget is spent,
 * REGARDLESS of the self-review verdict. Self-review is advisory: it drives the
 * autonomous fix loop within the budget, but must never block shipping — a human
 * code review is the real gate. Any unresolved findings ride along on the PR.
 * Blocks only when there is genuinely nothing committed to publish.
 * @param ctx - hook context
 * @param dispatch - the active dispatch
 * @param issue - the issue context
 * @param reason - the last blocking reason (self-review or commit-hygiene)
 * @param findings - unresolved self-review findings to attach to the PR
 * @returns the publication result
 */
async function shipImplementation(ctx, dispatch, issue, reason, findings) {
    let repoStatuses;
    try {
        repoStatuses = readRepoStatuses(dispatch);
    }
    catch (err) {
        return { success: false, reason: `could not verify committed implementation output: ${err}` };
    }
    // Only committed work is shippable — a PR needs commits ahead of base.
    if (!repoStatuses.some(({ status }) => status.commitsAhead > 0)) {
        return {
            success: false,
            reason: reason || "implementation produced no committed changes to publish",
            details: findings || undefined,
        };
    }
    // Only real self-review findings ride along as a PR note; commit-hygiene
    // reasons are operational, not code review, so they never become a note.
    const note = findings.trim();
    if (note) {
        emit(ctx, dispatch, {
            type: "thought",
            body: "🚢 Self-review still has open findings — shipping anyway; the PR carries them for code review.",
        });
    }
    return openPr(ctx, dispatch, issue, note || undefined);
}
// ---------------------------------------------------------------------------
// Phase: review (Warden / Apex code-review / Proof QA) — gates
// ---------------------------------------------------------------------------
/** The role-specific audit angle appended to the shared workspace prompt. */
function reviewAuditFocus(role) {
    switch (role.id) {
        case "warden":
            return "Audit this change for security issues: authz/authn, secrets, injection, unsafe deserialization, and supply-chain risk.";
        case "proof":
            return "QA this change against the issue's acceptance criteria. Run the test suite. Check edge cases and regressions.";
        case "apex":
        case "apex-reviewer":
            return "Code-review this change for correctness, design, and adherence to project conventions.";
        default:
            return "Review this change.";
    }
}
/** Re-fetch and reset every linked PR head in the issue's existing container. */
async function syncReviewSandbox(ctx, dispatch) {
    const pullRequests = dispatch.reviewPullRequests ?? [];
    if (!pullRequests.length)
        return null;
    if (!dispatch.containerName)
        return "no ticket container is available for review";
    for (const pullRequest of pullRequests) {
        const synced = await checkoutPullRequestInContainer(dispatch.containerName, pullRequest.repoName, pullRequest.url, pullRequest.number, ctx.pluginConfig);
        if (synced.status !== 0) {
            return `could not refresh ${pullRequest.url} in ${pullRequest.repoName}: ${synced.stderr.trim().slice(0, 500)}`;
        }
    }
    return null;
}
/** Detect a denied/missing tool outcome that cannot be treated as a code verdict. */
function reviewInfrastructureFailure(output) {
    const compact = output.trim().replace(/\s+/g, " ").slice(-600);
    if (!compact)
        return null;
    const patterns = [
        /["']?status["']?\s*:\s*["']?(?:declined|approval-unavailable)/i,
        /(?:bash|exec|container_[\w-]+|tool)[^\n]{0,160}\b(?:failed|declined|unavailable|not available)\b/i,
        /No active Linear issue for this session|cannot resolve a container|No container is registered/i,
    ];
    return patterns.some((pattern) => pattern.test(output)) ? compact : null;
}
/**
 * Publish one formal verdict for the complete review bundle to every linked PR.
 *
 * Reviewers now publish their OWN reviews from inside the container (agent-driven,
 * like a human — see the workspace prompt), so this orchestrator-side publication
 * is an opt-in FALLBACK only, enabled with `orchestratorPublishesReviews: true`.
 * The verdict GATE is independent of publication, so leaving this off never
 * affects whether a ticket advances.
 */
async function publishReviewBundle(ctx, dispatch, reviews, failures) {
    // On the embedded/harness path reviewers self-publish (they hold the reviewer
    // App token in-container), so the orchestrator stays out of the way. On the
    // legacy codex path the reviewer has no token, so the orchestrator publishes.
    // `orchestratorPublishesReviews: true` forces orchestrator publication either way.
    const agentSelfPublishes = isCodexHarnessSteeringEnabled(ctx.pluginConfig) && ctx.pluginConfig?.orchestratorPublishesReviews !== true;
    if (agentSelfPublishes)
        return;
    const pullRequests = dispatch.reviewPullRequests ?? [];
    if (!pullRequests.length || (!reviews.length && !failures.length))
        return;
    if (failures.some(({ result }) => result.infrastructureFailure))
        return;
    const passed = failures.length === 0 && reviews.every(({ verdict }) => verdict.pass);
    const body = [
        "## Automated review bundle",
        "",
        `**Overall verdict:** ${passed ? "pass" : "fail"}`,
        "",
        ...reviews.flatMap(({ role, verdict }) => [
            `### ${role.label}`,
            "",
            `**Verdict:** ${verdict.pass ? "pass" : "fail"}${verdict.reason ? ` — ${verdict.reason}` : ""}`,
            "",
            verdict.output.trim(),
            "",
        ]),
        ...failures
            .filter(({ result }) => !result.review)
            .flatMap(({ label, result }) => [
            `### ${label}`,
            "",
            `**Verdict:** fail — ${result.reason ?? "review failed"}`,
            "",
        ]),
        "",
        `_Automated review for Linear issue ${dispatch.issueIdentifier}._`,
    ].join("\n").slice(0, 30_000);
    const publicationFailures = [];
    for (const pullRequest of pullRequests) {
        if (!dispatch.containerName) {
            publicationFailures.push(`${pullRequest.url}: no ticket container`);
            continue;
        }
        const published = await publishPullRequestReviewInContainer(dispatch.containerName, pullRequest.repoName, pullRequest.url, body, passed, ctx.pluginConfig);
        if (published.status !== 0) {
            publicationFailures.push(`${pullRequest.url}: ${published.stderr.trim().slice(0, 300)}`);
        }
    }
    if (!publicationFailures.length)
        return;
    ctx.api.logger.warn(`[orchestrator] ${dispatch.issueIdentifier} GitHub review publication failed: ${publicationFailures.join("; ")}`);
    await ctx.linearApi.createComment(dispatch.issueId, `${body}\n\n> GitHub publication failed; preserved in Linear instead.\n> ${publicationFailures.join("\n> ")}`).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] Linear review fallback failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
/**
 * Run a reviewer and obtain a structured verdict. A backend/tool failure is
 * surfaced directly. If the review is substantive but omitted the required
 * verdict syntax, the same reviewer gets one format-correction turn instead of
 * sending the implementation back through meaningless rework.
 */
async function runStructuredReview(ctx, dispatch, issue, role, focus) {
    const tag = role.verdictTag ?? "REVIEW";
    const review = await runRole(ctx, dispatch, role, "review", focus, issue);
    if (!review.success) {
        const detail = review.output.trim().slice(-500);
        return {
            pass: false,
            reason: `${role.label} review agent failed${detail ? `: ${detail}` : " without output"}`,
            output: review.output,
            infrastructureFailure: true,
        };
    }
    const verdict = parseReviewVerdict(review.output, tag);
    if (!verdict.reason.startsWith(`no ${tag} verdict`))
        return { ...verdict, output: review.output };
    const infrastructureFailure = reviewInfrastructureFailure(review.output);
    if (infrastructureFailure) {
        return {
            pass: false,
            reason: `${role.label} review tooling failed: ${infrastructureFailure}`,
            output: review.output,
            infrastructureFailure: true,
        };
    }
    const correction = await runRole(ctx, dispatch, role, "review", [
        "Your review completed, but its verdict format was missing or invalid.",
        "Do not repeat the review. Based on your conclusion below, respond with ONLY:",
        `${tag}: pass`,
        `or ${tag}: fail — <one-line reason>`,
        "",
        review.output.slice(-4_000),
    ].join("\n"), issue);
    if (!correction.success) {
        const detail = correction.output.trim().slice(-500);
        return {
            pass: false,
            reason: `${role.label} verdict-format retry failed${detail ? `: ${detail}` : " without output"}`,
            output: review.output,
            infrastructureFailure: true,
        };
    }
    const corrected = parseReviewVerdict(correction.output, tag);
    if (!corrected.reason.startsWith(`no ${tag} verdict`)) {
        return { ...corrected, output: review.output };
    }
    const preview = review.output.trim().replace(/\s+/g, " ").slice(-500);
    return {
        pass: false,
        reason: `${role.label} review completed without a structured verdict${preview ? `; output: ${preview}` : ""}`,
        output: review.output,
    };
}
/**
 * Run a single review role for a code-review / QA state. REVIEW-ONLY: reviewers
 * read the change and emit a pass/fail verdict — they NEVER trigger an
 * implementer. In a code-review state only review agents run; the complete
 * configured bundle is collected into one formal GitHub verdict. A gated fail
 * returns the ticket to the configured remediation state.
 * @param gate - true when the phase blocks on failure; false = annotate-only
 */
async function runReviewPhase(ctx, dispatch, issue, role, gate, resumeGuidance, kind = "review") {
    const syncFailure = await syncReviewSandbox(ctx, dispatch);
    if (syncFailure) {
        return {
            success: false,
            reason: `${role.label} review sandbox sync failed: ${syncFailure}`,
            details: syncFailure,
            infrastructureFailure: true,
        };
    }
    const workspace = buildWorkspacePrompt({
        identifier: dispatch.issueIdentifier,
        repos: (dispatch.containerRepos ?? []).map((r) => ({ name: r, workdir: repoWorkdir(r) })),
        kind,
        reviewStyle: role.reviewStyle,
        inlineComments: role.inlineComments,
        verdictTag: role.verdictTag,
        pullRequests: (dispatch.reviewPullRequests ?? []).map((pr) => ({ repoName: pr.repoName, url: pr.url })),
    });
    const focus = [
        workspace,
        reviewAuditFocus(role),
        resumeGuidance ? `User continuation after pausing: ${resumeGuidance}` : "",
    ].filter(Boolean).join("\n\n");
    const verdict = await runStructuredReview(ctx, dispatch, issue, role, focus);
    emit(ctx, dispatch, {
        type: "thought",
        body: `${verdict.pass ? "✅" : "❌"} ${role.label} review — ${verdict.pass ? "pass" : "fail"}: ${verdict.reason}`,
    });
    const review = verdict.infrastructureFailure ? undefined : { role, verdict };
    if (verdict.pass)
        return { success: true, review };
    if (!gate) {
        return { success: true, review, infrastructureFailure: verdict.infrastructureFailure };
    } // annotate-only reviewers never block
    return {
        success: false,
        reason: `${role.label}: ${verdict.reason}`,
        details: verdict.output.trim().slice(-12_000) || undefined,
        review,
        infrastructureFailure: verdict.infrastructureFailure,
    };
}
async function transitionToTarget(ctx, dispatch, issue, targetConfig, outcome) {
    if (!targetConfig)
        return { success: true };
    if (!moveTicketOnFinish(ctx.pluginConfig)) {
        ctx.api.logger.info(`[orchestrator] ${issue.identifier} moveTicketOnFinish=false — leaving ticket in place (${outcome} target ${JSON.stringify(targetConfig)})`);
        return { success: true };
    }
    if (!issue.teamId)
        return { success: false, reason: "the issue has no team id for state resolution" };
    try {
        const states = await ctx.linearApi.getTeamStates(issue.teamId);
        const target = resolveTargetState(targetConfig, states);
        if (!target) {
            const reason = `no team state matched ${outcome} target ${JSON.stringify(targetConfig)}`;
            ctx.api.logger.warn(`[orchestrator] ${issue.identifier} ${reason}`);
            return { success: false, reason };
        }
        await ctx.linearApi.updateIssue(dispatch.issueId, { stateId: target.id });
        await comment(ctx, dispatch, `## ➡️ Moving to **${target.name}**\n\n${outcome === "success" ? "All phases passed." : "A gated phase requested changes."}`);
        ctx.api.logger.info(`[orchestrator] ${issue.identifier} → ${target.name}`);
        return { success: true, stateName: target.name };
    }
    catch (err) {
        const reason = `state transition failed: ${String(err).slice(0, 300)}`;
        ctx.api.logger.warn(`[orchestrator] ${reason} for ${issue.identifier}`);
        return { success: false, reason };
    }
}
/** Release the app from Issue.delegate after a terminal workflow outcome. */
async function releaseDelegate(ctx, dispatch, plan) {
    if (!unassignSelfOnFinish(ctx.pluginConfig)) {
        ctx.api.logger.info(`[orchestrator] ${dispatch.issueIdentifier} unassignSelfOnFinish=false — keeping delegate assigned for end-to-end continuation`);
        return;
    }
    if (plan.clearDelegate === false)
        return;
    if (typeof ctx.linearApi.updateIssue !== "function") {
        ctx.api.logger.warn(`[orchestrator] Linear API cannot release delegate for ${dispatch.issueIdentifier}`);
        return;
    }
    await ctx.linearApi.updateIssue(dispatch.issueId, { delegateId: null }).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] delegate release failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
/** Archive a terminal dispatch so a later manual delegation starts a fresh run. */
async function archiveDispatch(ctx, dispatch, status) {
    if (typeof completeDispatch !== "function")
        return;
    await completeDispatch(dispatch.issueIdentifier, {
        tier: dispatch.tier,
        status,
        completedAt: new Date().toISOString(),
        project: dispatch.project,
    }, ctx.configPath).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] dispatch archival failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
/** Finish a gated workflow failure, preserving findings for the next delegation. */
async function finishFailedPlan(ctx, dispatch, plan, issue, label, result) {
    let reason = result.reason ?? "phase failed";
    const transition = await transitionToTarget(ctx, dispatch, issue, plan.onFailure ?? null, "failure");
    if (!transition.success && transition.reason) {
        reason = `${reason}\n\nWorkflow transition warning: ${transition.reason}`;
    }
    const findings = result.details
        ? `\n\n## Review findings\n\n${result.details.slice(-8_000)}`
        : "";
    await comment(ctx, dispatch, `## ⛔ Blocked at ${label}\n\n${reason}${findings}\n\n` +
        (transition.stateName
            ? `The ticket was returned to **${transition.stateName}** for remediation.`
            : "The ticket requires remediation before this workflow can continue."));
    await ctx.notify("stuck", {
        identifier: dispatch.issueIdentifier,
        title: issue.title,
        status: "stuck",
        attempt: dispatch.attempt,
        reason,
    }).catch(() => { });
    setStatus(dispatch, `blocked: ${label}`);
    await endSession(ctx, dispatch, "response", `⛔ Blocked at ${label}: ${reason}${findings}\n\n` +
        (transition.stateName
            ? `Moved to ${transition.stateName}. Delegate the coding agent again when you want remediation to start.`
            : "Delegate the agent again when you want to retry."));
    await releaseDelegate(ctx, dispatch, plan);
    await archiveDispatch(ctx, dispatch, "failed");
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Run a resolved state plan for a dispatch. Executes phases in order; on the
 * first gated failure it moves to the configured onFailure state; on full
 * success it advances to onSuccess. Both terminal paths complete the Linear
 * session, release the delegate (unless disabled), and archive the dispatch.
 * @param ctx - hook context (api, linearApi, notify, config, configPath)
 * @param dispatch - the active dispatch (worktree, session, attempt)
 * @param plan - the resolved state plan
 */
export async function runStatePlan(ctx, dispatch, plan, options = {}) {
    const details = await ctx.linearApi.getIssueDetails(dispatch.issueId).catch(() => null);
    const issue = {
        id: dispatch.issueId,
        identifier: dispatch.issueIdentifier,
        title: details?.title ?? dispatch.issueTitle ?? dispatch.issueIdentifier,
        description: details?.description,
        teamId: details?.team?.id,
    };
    // A resumed turn deliberately clears the STOP flag while retaining the same
    // Linear session, OpenClaw session ids, repos, and container.
    clearCancel(dispatch.issueId);
    const startPhaseIndex = options.resume && typeof dispatch.phaseIndex === "number"
        ? Math.min(Math.max(dispatch.phaseIndex, 0), Math.max(plan.phases.length - 1, 0))
        : 0;
    await updateDispatchProgress(dispatch.issueIdentifier, { status: "working", phaseIndex: startPhaseIndex, pausedAt: null }, ctx.configPath).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] could not persist resume state for ${issue.identifier}: ${err}`);
    });
    ensureManifest(dispatch);
    setStatus(dispatch, options.resume ? "resuming" : "orchestrating");
    emit(ctx, dispatch, {
        type: "thought",
        body: options.resume
            ? `Resuming "${plan.stateLabel}" at phase ${startPhaseIndex + 1}/${plan.phases.length}`
            : `Orchestrating "${plan.stateLabel}" — ${plan.phases.length} phase(s)`,
    });
    ctx.api.logger.info(`[orchestrator] ${issue.identifier} plan=${plan.stateLabel} phases=${plan.phases.map((p) => phaseAgentId(p) ?? p.type).join(",")}`);
    // Native Linear agent-session plan checklist: phases as top-level rows, each
    // specialist assignment nested under Implement with its own steps (populated
    // in runImplementPhase). Rows flip to inProgress/completed/canceled as the
    // pipeline runs — phases by the orchestrator, specialists by the subagent
    // lifecycle hooks. Keyed by the ticket identifier so those hooks can reach it.
    const sessionPlan = createSessionPlan(dispatch.issueIdentifier, {
        linearApi: ctx.linearApi,
        agentSessionId: dispatch.agentSessionId,
        enabled: agentPlansEnabled(ctx.pluginConfig),
        logger: ctx.api.logger,
    });
    sessionPlan.initPhases(plan.phases.map(phaseLabel));
    // On resume, phases before the resume point already completed.
    for (let i = 0; i < startPhaseIndex; i++)
        sessionPlan.setPhaseStatus(i, "completed");
    // Fresh plan-implement start: Apex hasn't produced the breakdown yet, so show
    // a single placeholder ("preparing the plan…") instead of an empty tree until
    // runImplementPhase reveals the real per-specialist plan.
    if (!options.resume && plan.phases[startPhaseIndex]?.type === "plan-implement") {
        sessionPlan.setPreparing("🧭 Apex is preparing the plan…");
    }
    await sessionPlan.flush();
    // A pause (STOP / plan-approval) keeps the plan for the resuming run; only a
    // terminal outcome disposes it.
    let paused = false;
    try {
        const reviewFailures = [];
        const reviewRecords = [];
        for (let phaseIndex = startPhaseIndex; phaseIndex < plan.phases.length; phaseIndex++) {
            const phase = plan.phases[phaseIndex];
            dispatch.phaseIndex = phaseIndex;
            await updateDispatchProgress(dispatch.issueIdentifier, { status: "working", phaseIndex, pausedAt: null }, ctx.configPath).catch((err) => {
                ctx.api.logger.warn(`[orchestrator] could not persist phase ${phaseIndex} for ${issue.identifier}: ${err}`);
            });
            // Honor a STOP requested between phases — bail cleanly, don't advance.
            if (isCancelled(dispatch.issueId)) {
                setStatus(dispatch, "cancelled");
                await updateDispatchProgress(dispatch.issueIdentifier, { status: "paused", phaseIndex, pausedAt: new Date().toISOString() }, ctx.configPath).catch(() => { });
                paused = true;
                return;
            }
            sessionPlan.setPhaseStatus(phaseIndex, "inProgress");
            await sessionPlan.flush();
            const result = await runPhase(ctx, dispatch, issue, phase, phaseIndex === startPhaseIndex ? options.resumeGuidance : undefined);
            if (result.reason === "halted") {
                setStatus(dispatch, "cancelled");
                await updateDispatchProgress(dispatch.issueIdentifier, { status: "paused", phaseIndex, pausedAt: new Date().toISOString() }, ctx.configPath).catch(() => { });
                paused = true;
                return;
            }
            if (result.review)
                reviewRecords.push(result.review);
            if (!result.success) {
                sessionPlan.setPhaseStatus(phaseIndex, "canceled");
                sessionPlan.setPhaseAssignmentsStatus(phaseIndex, "canceled");
                await sessionPlan.flush();
                const label = phaseAgentId(phase) ? `${phase.type}:${phaseAgentId(phase)}` : phase.type;
                const nextPhase = plan.phases[phaseIndex + 1];
                if (phase.type === "review") {
                    reviewFailures.push({ label, result });
                    // Run the complete configured review bundle (e.g. Warden + Apex) so
                    // one delegation produces all actionable findings in one pass.
                    if (nextPhase?.type === "review")
                        continue;
                    await publishReviewBundle(ctx, dispatch, reviewRecords, reviewFailures);
                    const combined = {
                        success: false,
                        reason: reviewFailures
                            .map((failure) => `${failure.label}: ${failure.result.reason ?? "review failed"}`)
                            .join("; "),
                        details: reviewFailures
                            .map((failure) => `### ${failure.label}\n\n${failure.result.details ?? failure.result.reason ?? "review failed"}`)
                            .join("\n\n"),
                    };
                    await finishFailedPlan(ctx, dispatch, plan, issue, reviewFailures.map((failure) => failure.label).join(" + "), combined);
                    return;
                }
                await finishFailedPlan(ctx, dispatch, plan, issue, label, result);
                return;
            }
            sessionPlan.setPhaseStatus(phaseIndex, "completed");
            // A passed phase means every specialist under it finished — mark them (and
            // their steps) completed, covering any subagent whose lifecycle hook was
            // missed and the direct-codex path (which has no per-specialist signal).
            sessionPlan.setPhaseAssignmentsStatus(phaseIndex, "completed");
            await sessionPlan.flush();
            const nextPhase = plan.phases[phaseIndex + 1];
            if (phase.type === "review" && nextPhase?.type !== "review") {
                await publishReviewBundle(ctx, dispatch, reviewRecords, reviewFailures);
            }
            if (phase.type === "review" && reviewFailures.length && nextPhase?.type !== "review") {
                const combined = {
                    success: false,
                    reason: reviewFailures
                        .map((failure) => `${failure.label}: ${failure.result.reason ?? "review failed"}`)
                        .join("; "),
                    details: reviewFailures
                        .map((failure) => `### ${failure.label}\n\n${failure.result.details ?? failure.result.reason ?? "review failed"}`)
                        .join("\n\n"),
                };
                await finishFailedPlan(ctx, dispatch, plan, issue, reviewFailures.map((failure) => failure.label).join(" + "), combined);
                return;
            }
            if (phase.type === "review" && nextPhase?.type !== "review") {
                reviewRecords.length = 0;
                reviewFailures.length = 0;
            }
        }
        const transition = await transitionToTarget(ctx, dispatch, issue, plan.onSuccess, "success");
        if (!transition.success) {
            const reason = transition.reason ?? "workflow state transition failed";
            setStatus(dispatch, "error");
            await endSession(ctx, dispatch, "error", `Implementation/review passed, but ${reason}.`);
            await releaseDelegate(ctx, dispatch, plan);
            await archiveDispatch(ctx, dispatch, "failed");
            return;
        }
        setStatus(dispatch, "done");
        await ctx.notify("audit_pass", {
            identifier: dispatch.issueIdentifier,
            title: issue.title,
            status: "done",
            attempt: dispatch.attempt,
        }).catch(() => { });
        await endSession(ctx, dispatch, "response", `✅ Completed "${plan.stateLabel}" — all phases passed.` +
            (transition.stateName ? ` Moved to ${transition.stateName}.` : ""));
        await releaseDelegate(ctx, dispatch, plan);
        await archiveDispatch(ctx, dispatch, "done");
    }
    catch (err) {
        ctx.api.logger.error(`[orchestrator] ${issue.identifier} unexpected error: ${err}`);
        setStatus(dispatch, "error");
        await endSession(ctx, dispatch, "error", `The pipeline hit an unexpected error: ${String(err).slice(0, 400)}`);
        await releaseDelegate(ctx, dispatch, plan);
        await archiveDispatch(ctx, dispatch, "failed");
    }
    finally {
        // Keep the plan across a pause (the resuming run reuses it); drop it only
        // once the run reaches a terminal outcome.
        if (!paused)
            disposeSessionPlan(dispatch.issueIdentifier);
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
async function endSession(ctx, dispatch, type, body) {
    if (!dispatch.agentSessionId)
        return;
    await ctx.linearApi.emitActivity(dispatch.agentSessionId, { type, body }).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] terminal ${type} emit failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
/** Dispatch a single plan phase to its handler. */
async function runPhase(ctx, dispatch, issue, phase, resumeGuidance) {
    if (phase.type === "plan-implement") {
        return runImplementPhase(ctx, dispatch, issue, resumeGuidance);
    }
    if (phase.type === "review") {
        const agentId = phaseAgentId(phase);
        const role = agentId ? resolveRole(agentId) : undefined;
        if (!role)
            return { success: false, reason: `unknown review agent "${agentId}"` };
        return runReviewPhase(ctx, dispatch, issue, role, phase.gate !== false, resumeGuidance, phaseKind(phase));
    }
    if (phase.type === "product") {
        const agentId = phaseAgentId(phase);
        const role = agentId ? resolveRole(agentId) : undefined;
        if (!role)
            return { success: false, reason: `unknown product agent "${agentId}"` };
        const focus = role.id === "helm"
            ? "Turn this feature idea into a crisp product brief with goals, scope, and acceptance criteria."
            : "Define the metrics, funnels, and measurement plan for this feature.";
        const productFocus = [focus, resumeGuidance ? `User continuation after pausing: ${resumeGuidance}` : ""]
            .filter(Boolean)
            .join("\n\n");
        const { success, output } = await runRole(ctx, dispatch, role, "product", productFocus, issue);
        if (success)
            await comment(ctx, dispatch, `## 📄 ${role.label}\n\n${output.slice(0, 4000)}`);
        return { success };
    }
    return { success: false, reason: `unknown phase type "${phase.type}"` };
}
