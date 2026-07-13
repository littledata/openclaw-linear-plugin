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
import { runAgent, READ_ONLY_DENY } from "../agent/agent.js";
import { execCodexInContainer, containerGitStatus, openPrInContainer, repoWorkdir, WORK_ROOT, } from "../infra/container-runner.js";
import { readManifest, writeManifest, updateManifest, savePlan, saveWorkerOutput, appendLog } from "./artifacts.js";
import { ROLES, resolveRole, implementerRoles, buildRolePrompt, parseReviewVerdict, resolveRoleModel, resolveRoleBackend, loadSkillGuidance, roleToolsDeny, } from "./roles.js";
import { resolveTargetState } from "./state-plan.js";
import { isCancelled, clearCancel } from "./cancellation.js";
import { getActiveSession } from "./active-session.js";
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
        `\nRepositories (edit + commit here; you may clone others from /repos-ro):\n${workspace}`,
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
    const backend = resolveRoleBackend(role, ctx.pluginConfig);
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
        { role: "spine", task: `Implement issue ${issue.identifier} end to end.` },
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
        }))
            .filter((a) => validIds.has(a.role) && a.task);
        return parsed.length ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
async function runApexPlan(ctx, dispatch, issue) {
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
    try {
        savePlan(dispatch.worktreePath, `# Plan for ${dispatch.issueIdentifier}\n\n${planText}`);
    }
    catch { /* best effort */ }
    return assignments;
}
// ---------------------------------------------------------------------------
// Phase: plan-implement (Apex → implementers → Apex self-review → PR)
// ---------------------------------------------------------------------------
/**
 * Whether implementers run as a single steerable OpenClaw agent driving the
 * container via tools (the default), vs. the legacy one-shot `codex exec` per
 * specialist. Config `implementMode: "codex"` opts back into the old path.
 * @param cfg - plugin config
 * @returns true when the container-agent path should be used
 */
function implementerUsesContainer(cfg) {
    return cfg?.implementMode !== "codex";
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
    const repoLines = repos.map((r) => `- ${r}: ${repoWorkdir(r)}`).join("\n") || WORK_ROOT;
    const plan = assignments
        .map((a) => `- ${resolveRole(a.role)?.label ?? a.role}: ${a.task}`)
        .join("\n");
    const system = [
        `You are implementing Linear issue ${issue.identifier} end to end.`,
        "",
        "## Your sandbox",
        `You have a DEDICATED Docker container for this ticket — your private workspace.`,
        `These repositories are already cloned and WRITABLE inside it:`,
        repoLines,
        "",
        "Your host filesystem is READ-ONLY. The ONLY way to change files, run commands, run tests,",
        "or run the app is via the container_* tools:",
        "- container_exec — run any shell command (build, test, run the app, git, install deps)",
        "- container_write_file / container_read_file — edit/read files",
        "- container_apply_patch — apply a unified diff in a repo",
        "- container_status — git status of the repos",
        "- container_clone_repo — pull in another repo for cross-repo work",
        "- container_search_code — AST semantic code search; use it to locate code by concept",
        "  (\"where is X handled?\") when you don't know exact names — better than grep for discovery.",
        "",
        "## What to do",
        "Implement the change fully, then VERIFY it by running the project's build/tests inside the",
        `container. Commit your work in each changed repo (git add -A && git commit) on branch`,
        `\`${dispatch.branch}\`. Do NOT open a pull request — that happens after review.`,
        dispatch.grillGuidance ? `\n## Clarified requirements\n${dispatch.grillGuidance}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    const task = [
        `Issue ${issue.identifier}: ${issue.title}`,
        issue.description ? `\nIssue body:\n${issue.description}` : "",
        plan ? `\nImplementation plan (from Apex):\n${plan}` : "",
        reworkNote ? `\n${reworkNote}` : "",
    ]
        .filter(Boolean)
        .join("\n");
    // Match the agentId the dispatch registered its active session under, so the
    // container tools resolve this issue's container via getActiveSessionByAgentId.
    const agentId = ctx.pluginConfig?.implementerAgentId ??
        getActiveSession(dispatch.issueId)?.agentId ??
        "main";
    const r = await runAgent({
        api: ctx.api,
        agentId,
        // Stable per-ticket session → one continuous, steerable implementer.
        sessionId: `linear-impl-${dispatch.issueIdentifier}`,
        message: task,
        extraSystemPrompt: system,
        // Deny host writes/exec — the agent acts ONLY through the container tools.
        toolsDeny: READ_ONLY_DENY,
        streaming: dispatch.agentSessionId
            ? { linearApi: ctx.linearApi, agentSessionId: dispatch.agentSessionId }
            : undefined,
        abortKey: dispatch.issueId,
    });
    return { success: r.success, output: r.output };
}
async function runImplementPhase(ctx, dispatch, issue) {
    const limit = maxRework(ctx.pluginConfig);
    let assignments = await runApexPlan(ctx, dispatch, issue);
    let lastReason = "";
    const useContainerAgent = implementerUsesContainer(ctx.pluginConfig);
    for (let attempt = 0; attempt <= limit; attempt++) {
        if (isCancelled(dispatch.issueId))
            return { success: false, reason: "halted" };
        setStatus(dispatch, attempt === 0 ? "implementing" : `reworking (attempt ${attempt + 1})`);
        const attemptOutputs = [];
        if (useContainerAgent) {
            // One steerable agent per ticket, editing + running ONLY inside its container.
            const { success, output } = await runContainerImplement(ctx, dispatch, issue, assignments, reworkNoteFrom(lastReason, attempt));
            attemptOutputs.push(output);
            lastReason = success ? "" : `implementation agent failed: ${output.slice(-300)}`;
        }
        else {
            // Legacy: one-shot codex exec per specialist, sharing the container.
            for (const a of assignments) {
                if (isCancelled(dispatch.issueId))
                    return { success: false, reason: "halted" };
                const role = resolveRole(a.role) ?? ROLES.spine;
                const { success, output } = await runRole(ctx, dispatch, role, "implement", a.task, issue);
                attemptOutputs.push(`## ${role.label}\n${output}`);
                if (!success) {
                    lastReason = `${role.label} implementation failed: ${output.slice(-300)}`;
                    // Keep going to self-review — codex may have partially applied changes.
                }
            }
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
        // No-diff guard: an implementer failed (lastReason set) AND left zero working
        // changes — the container is effectively untouched (e.g. codex exited 1 in an
        // empty container). There's nothing for a self-review to gate on, so it would
        // just fail to find a verdict line ("no REVIEW verdict line found"). Surface the
        // REAL reason instead of that cryptic message.
        if (lastReason && !hasAnyChanges(dispatch)) {
            emit(ctx, dispatch, {
                type: "thought",
                body: `⚠️ No code changes were produced (attempt ${attempt + 1}/${limit + 1}): ${lastReason}`,
            });
            if (attempt < limit) {
                continue; // give rework a shot before giving up
            }
            return { success: false, reason: `no changes produced — ${lastReason}` };
        }
        // Apex self-review — read-only, gates the phase.
        if (isCancelled(dispatch.issueId))
            return { success: false, reason: "halted" };
        setStatus(dispatch, "reviewing");
        const review = await runRole(ctx, dispatch, ROLES.apex, "review", "Self-review the implemented work against the issue's acceptance criteria. " +
            "Confirm the code is complete and the tests pass. This is the gate before code review.", issue);
        const verdict = parseReviewVerdict(review.output, "REVIEW");
        if (verdict.pass) {
            await openPr(ctx, dispatch, issue);
            return { success: true };
        }
        lastReason = verdict.reason;
        emit(ctx, dispatch, {
            type: "thought",
            body: `🔁 Apex self-review failed (attempt ${attempt + 1}/${limit + 1}): ${verdict.reason}`,
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
    return { success: false, reason: lastReason || "implementation did not pass self-review" };
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
/**
 * Whether any target repo in the container has uncommitted working-tree changes.
 * Best-effort: a git-status probe that throws is treated as "no changes" for that
 * repo. Used only as a negative signal (combined with a failed implementer) to
 * avoid running a self-review over an untouched workspace.
 * @param dispatch - the active dispatch (needs containerName + containerRepos)
 * @returns true if at least one repo shows changes
 */
function hasAnyChanges(dispatch) {
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
async function openPr(ctx, dispatch, issue) {
    const repos = dispatch.containerRepos ?? [];
    if (!dispatch.containerName || !repos.length) {
        ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no container/repos to open a PR`);
        return;
    }
    const opened = [];
    const failures = [];
    const body = `Implements ${issue.identifier}.\n\n_Opened by the state-driven agent pipeline (Apex → implementers → self-review)._`;
    for (const repo of repos) {
        try {
            const status = containerGitStatus(dispatch.containerName, repo);
            if (!status.hasChanges) {
                // Still attempt: the agent may have committed (porcelain clean but ahead
                // of base). openPrInContainer no-ops gh when there's truly no diff.
            }
            const prUrl = openPrInContainer(dispatch.containerName, repo, dispatch.branch, `${issue.identifier}: ${issue.title}`, body);
            if (prUrl)
                opened.push(`**${repo}**: ${prUrl}`);
        }
        catch (err) {
            ctx.api.logger.warn(`[orchestrator] PR failed for ${issue.identifier}/${repo}: ${err}`);
            failures.push(`**${repo}**: ${String(err).slice(0, 200)}`);
        }
    }
    if (opened.length) {
        await comment(ctx, dispatch, `## ✅ Implementation complete\n\nPR(s):\n${opened.map((o) => `- ${o}`).join("\n")}`);
    }
    else if (failures.length) {
        await comment(ctx, dispatch, `## ⚠️ Implementation complete, PR creation failed\n\n${failures.map((f) => `- ${f}`).join("\n")}`);
    }
    else {
        ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no changes across repos — no PR opened`);
        emit(ctx, dispatch, { type: "thought", body: "No code changes to open a PR (nothing to review)." });
    }
}
// ---------------------------------------------------------------------------
// Phase: review (Warden / Apex code-review / Proof QA) — gates
// ---------------------------------------------------------------------------
function reviewFocus(role) {
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
/**
 * Run a single review role for a code-review / QA state. REVIEW-ONLY: reviewers
 * read the change and emit a pass/fail verdict — they NEVER trigger an
 * implementer. In a code-review state only review agents run; a fail GATES (the
 * ticket stays put and the findings are reported) so a human can bounce it back
 * to implementation, where fixing actually belongs. The verdict streams into the
 * agent session rather than the issue comments.
 * @param gate - true when the phase blocks on failure; false = annotate-only
 */
async function runReviewPhase(ctx, dispatch, issue, role, gate) {
    const tag = role.verdictTag ?? "REVIEW";
    const { output } = await runRole(ctx, dispatch, role, "review", reviewFocus(role), issue);
    const verdict = parseReviewVerdict(output, tag);
    emit(ctx, dispatch, {
        type: "thought",
        body: `${verdict.pass ? "✅" : "❌"} ${role.label} review — ${verdict.pass ? "pass" : "fail"}: ${verdict.reason}`,
    });
    if (verdict.pass)
        return { success: true };
    if (!gate)
        return { success: true }; // annotate-only reviewers never block
    return { success: false, reason: `${role.label}: ${verdict.reason}` };
}
// ---------------------------------------------------------------------------
// Agent-decided state transition
// ---------------------------------------------------------------------------
async function transitionOnSuccess(ctx, dispatch, plan, issue) {
    if (!plan.onSuccess || !issue.teamId)
        return;
    try {
        const states = await ctx.linearApi.getTeamStates(issue.teamId);
        const target = resolveTargetState(plan.onSuccess, states);
        if (!target) {
            ctx.api.logger.warn(`[orchestrator] ${issue.identifier} no team state matched onSuccess ${JSON.stringify(plan.onSuccess)}`);
            return;
        }
        await ctx.linearApi.updateIssue(dispatch.issueId, { stateId: target.id });
        await comment(ctx, dispatch, `## ➡️ Moving to **${target.name}**\n\nAll phases passed.`);
        ctx.api.logger.info(`[orchestrator] ${issue.identifier} → ${target.name}`);
    }
    catch (err) {
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
export async function runStatePlan(ctx, dispatch, plan) {
    const details = await ctx.linearApi.getIssueDetails(dispatch.issueId).catch(() => null);
    const issue = {
        id: dispatch.issueId,
        identifier: dispatch.issueIdentifier,
        title: details?.title ?? dispatch.issueTitle ?? dispatch.issueIdentifier,
        description: details?.description,
        teamId: details?.team?.id,
    };
    // Fresh run — drop any stale halt flag from a prior (stopped) dispatch.
    clearCancel(dispatch.issueId);
    ensureManifest(dispatch);
    setStatus(dispatch, "orchestrating");
    emit(ctx, dispatch, {
        type: "thought",
        body: `Orchestrating "${plan.stateLabel}" — ${plan.phases.length} phase(s)`,
    });
    ctx.api.logger.info(`[orchestrator] ${issue.identifier} plan=${plan.stateLabel} phases=${plan.phases.map((p) => p.role ?? p.type).join(",")}`);
    try {
        for (const phase of plan.phases) {
            // Honor a STOP requested between phases — bail cleanly, don't advance.
            if (isCancelled(dispatch.issueId)) {
                setStatus(dispatch, "cancelled");
                endSession(ctx, dispatch, "response", "🛑 Halted — stopped before completing the pipeline. Re-assign or comment to start again.");
                return;
            }
            const result = await runPhase(ctx, dispatch, issue, phase);
            if (result.reason === "halted") {
                setStatus(dispatch, "cancelled");
                endSession(ctx, dispatch, "response", "🛑 Halted mid-phase — stopped the running work. Re-assign or comment to start again.");
                return;
            }
            if (!result.success) {
                const label = phase.role ? `${phase.type}:${phase.role}` : phase.type;
                const reason = result.reason ?? "phase failed";
                await comment(ctx, dispatch, `## ⛔ Blocked at ${label}\n\n${reason}\n\nThe ticket stays in its current state until this is resolved.`);
                await ctx.notify("stuck", {
                    identifier: dispatch.issueIdentifier,
                    title: issue.title,
                    status: "stuck",
                    attempt: dispatch.attempt,
                    reason: result.reason,
                }).catch(() => { });
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
        }).catch(() => { });
        endSession(ctx, dispatch, "response", `✅ Completed "${plan.stateLabel}" — all phases passed.`);
    }
    catch (err) {
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
function endSession(ctx, dispatch, type, body) {
    if (!dispatch.agentSessionId)
        return;
    ctx.linearApi.emitActivity(dispatch.agentSessionId, { type, body }).catch((err) => {
        ctx.api.logger.warn(`[orchestrator] terminal ${type} emit failed for ${dispatch.issueIdentifier}: ${err}`);
    });
}
/** Dispatch a single plan phase to its handler. */
async function runPhase(ctx, dispatch, issue, phase) {
    if (phase.type === "plan-implement") {
        return runImplementPhase(ctx, dispatch, issue);
    }
    if (phase.type === "review") {
        const role = phase.role ? resolveRole(phase.role) : undefined;
        if (!role)
            return { success: false, reason: `unknown review role "${phase.role}"` };
        return runReviewPhase(ctx, dispatch, issue, role, phase.gate !== false);
    }
    if (phase.type === "product") {
        const role = phase.role ? resolveRole(phase.role) : undefined;
        if (!role)
            return { success: false, reason: `unknown product role "${phase.role}"` };
        const focus = role.id === "helm"
            ? "Turn this feature idea into a crisp product brief with goals, scope, and acceptance criteria."
            : "Define the metrics, funnels, and measurement plan for this feature.";
        const { success, output } = await runRole(ctx, dispatch, role, "product", focus, issue);
        if (success)
            await comment(ctx, dispatch, `## 📄 ${role.label}\n\n${output.slice(0, 4000)}`);
        return { success };
    }
    return { success: false, reason: `unknown phase type "${phase.type}"` };
}
