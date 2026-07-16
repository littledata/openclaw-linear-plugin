/** Prefix that visually nests a specialist assignment under its phase. */
const ASSIGNMENT_PREFIX = "↳ ";
/** Prefix that visually nests a step under its specialist (glyph conveys depth
 *  even if a renderer collapses the leading whitespace). */
const STEP_PREFIX = "    • ";
/** Normalize an agent/role id for tolerant matching (lowercase, strip namespace). */
function normalizeKey(id) {
    const raw = id.trim().toLowerCase();
    const parts = raw.split(/[:/]/);
    return parts[parts.length - 1] || raw;
}
/**
 * Builds and pushes a Linear agent-session plan for one dispatch. Phases are
 * top-level rows; each specialist assignment nests under its phase, and its
 * steps nest under it. Each `flush()` replaces the entire plan (Linear requires
 * full replacement).
 */
export class SessionPlan {
    opts;
    phases = [];
    /** When set, the plan shows only this single placeholder row (e.g. while Apex
     *  is still preparing the plan) and hides the phase/assignment tree. */
    preparing = null;
    /**
     * @param opts - Linear API handle, target session id, enable flag, logger
     */
    constructor(opts) {
        this.opts = opts;
    }
    /** Whether this plan can actually be pushed (enabled + a session to target). */
    get active() {
        return this.opts.enabled && typeof this.opts.agentSessionId === "string" && !!this.opts.agentSessionId;
    }
    /**
     * Seed the top-level phase rows (all `pending`), in execution order.
     * @param labels - human phase labels, e.g. ["Implement", "Code review", "QA"]
     */
    initPhases(labels) {
        this.phases = labels.map((label) => ({ label, status: "pending", assignments: [] }));
    }
    /**
     * Show a single placeholder row instead of the tree (e.g. "Apex is preparing
     * the plan…") until the real plan is ready. Cleared by `clearPreparing()`.
     * @param message - the placeholder row text
     */
    setPreparing(message) {
        this.preparing = message;
    }
    /** Reveal the phase/assignment tree, dropping any preparing placeholder. */
    clearPreparing() {
        this.preparing = null;
    }
    /**
     * Set a phase row's status by its index in the phase list.
     * @param index - phase index (matches the orchestrator's phaseIndex)
     * @param status - new lifecycle status
     */
    setPhaseStatus(index, status) {
        const node = this.phases[index];
        if (node)
            node.status = status;
    }
    /**
     * Attach (replace) the specialist assignments — each with its own steps —
     * nested under a phase.
     * @param index - phase index to nest under
     * @param assignments - specialist rows (key + label + ordered steps)
     */
    setAssignments(index, assignments) {
        const node = this.phases[index];
        if (!node)
            return;
        node.assignments = assignments.map((a) => ({
            key: normalizeKey(a.key),
            label: a.label,
            status: "pending",
            steps: a.steps.map((content) => ({ content, status: "pending" })),
        }));
    }
    /**
     * Update one specialist assignment's status (and cascade to its steps) by its
     * match key, searching every phase. `inProgress` marks the specialist active
     * (steps stay pending — we can't see individual step progress); `completed`
     * marks the specialist and all its steps done; `canceled` cancels the
     * specialist and any not-yet-done steps.
     * @param key - the specialist agent/role id (matched case-insensitively)
     * @param status - the new status
     * @returns true if a matching assignment was found and updated
     */
    setAssignmentStatus(key, status) {
        const target = normalizeKey(key);
        for (const phase of this.phases) {
            const assignment = phase.assignments.find((a) => a.key === target);
            if (!assignment)
                continue;
            assignment.status = status;
            if (status === "completed") {
                assignment.steps = assignment.steps.map((s) => ({ ...s, status: "completed" }));
            }
            else if (status === "canceled") {
                assignment.steps = assignment.steps.map((s) => s.status === "completed" ? s : { ...s, status: "canceled" });
            }
            return true;
        }
        return false;
    }
    /**
     * Set every specialist assignment (and its steps) of a phase to one status —
     * used as a fallback when no per-specialist lifecycle signal is available
     * (e.g. the direct-codex path) or when a phase completes wholesale.
     * @param index - phase index whose assignments to update
     * @param status - new lifecycle status
     */
    setPhaseAssignmentsStatus(index, status) {
        const node = this.phases[index];
        if (!node)
            return;
        node.assignments = node.assignments.map((a) => ({
            ...a,
            status,
            steps: a.steps.map((s) => ({ ...s, status })),
        }));
    }
    /** Flatten the three-level model into Linear's flat, prefixed step list. */
    toSteps() {
        if (this.preparing)
            return [{ content: this.preparing, status: "inProgress" }];
        const steps = [];
        for (const phase of this.phases) {
            steps.push({ content: phase.label, status: phase.status });
            for (const assignment of phase.assignments) {
                steps.push({ content: `${ASSIGNMENT_PREFIX}${assignment.label}`, status: assignment.status });
                for (const step of assignment.steps) {
                    steps.push({ content: `${STEP_PREFIX}${step.content}`, status: step.status });
                }
            }
        }
        return steps;
    }
    /** Push the current plan to Linear (full replacement). Best-effort. */
    async flush() {
        if (!this.active)
            return;
        try {
            await this.opts.linearApi.updateSession(this.opts.agentSessionId, { plan: this.toSteps() });
        }
        catch (err) {
            this.opts.logger?.warn(`[agent-plan] could not update session plan: ${err}`);
        }
    }
}
const plansByIssue = new Map();
/**
 * Create (and register) a SessionPlan for a dispatch, replacing any prior one.
 * @param key - dispatch registry key (the ticket identifier, e.g. "CORE-1751")
 * @param opts - SessionPlan options
 * @returns the new SessionPlan
 */
export function createSessionPlan(key, opts) {
    const plan = new SessionPlan(opts);
    plansByIssue.set(key, plan);
    return plan;
}
/**
 * Look up the SessionPlan registered for a dispatch, if any.
 * @param key - dispatch registry key (ticket identifier)
 * @returns the SessionPlan or undefined
 */
export function getSessionPlan(key) {
    return plansByIssue.get(key);
}
/**
 * Drop the SessionPlan registered for a dispatch (end of run).
 * @param key - dispatch registry key (ticket identifier)
 */
export function disposeSessionPlan(key) {
    plansByIssue.delete(key);
}
/**
 * Flip a specialist assignment's live status on the registered plan and push it
 * to Linear. Called from the subagent lifecycle hooks as each spawned specialist
 * starts (`inProgress`) and finishes (`completed` / `canceled`). Best-effort.
 * @param key - dispatch registry key (ticket identifier)
 * @param agentKey - the specialist agent/role id that spawned or ended
 * @param status - the new status for that specialist
 */
export async function updateAssignmentStatus(key, agentKey, status) {
    const plan = plansByIssue.get(key);
    if (!plan)
        return;
    if (plan.setAssignmentStatus(agentKey, status))
        await plan.flush();
}
