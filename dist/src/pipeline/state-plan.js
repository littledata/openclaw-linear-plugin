/**
 * state-plan.ts — maps a Linear ticket's workflow state to a phase plan.
 *
 * The state-driven orchestrator runs a DIFFERENT set of specialist phases
 * depending on where the ticket sits in the workflow:
 *
 *   Todo / In Progress  → Apex plans + routes implementers → they build →
 *                         Apex self-reviews → (on success) move to Code Review
 *   Code Review         → Warden + Apex code-review gate → (on success) move to QA,
 *                         or (on failure) return to In Progress
 *   QA                  → Proof QAs → (on success) move to Done
 *
 * Every mapping is overridable via plugin config `statePlans` (keyed by the
 * exact Linear state NAME, case-insensitive). When no config entry matches, a
 * built-in matcher picks a plan by state name/type. States with no plan (e.g.
 * Done, Canceled, Backlog) return null — the orchestrator no-ops for those.
 *
 * Transitions are CONFIG-DRIVEN: a plan names candidate success/failure states,
 * and the orchestrator moves the ticket only after the corresponding terminal
 * verdict. Targets and terminal delegate release are independently configurable
 * for every Linear state.
 */
/** True when a state plan contains reviewers only and must skip implementation preflight. */
export function isReviewOnlyPlan(plan) {
    return !!plan?.phases.length && plan.phases.every((phase) => phase.type === "review");
}
// ---------------------------------------------------------------------------
// Built-in default plans
// ---------------------------------------------------------------------------
/** Todo / In Progress → build (Apex-led) → Code Review. */
const IMPLEMENT_PLAN = {
    stateLabel: "implement",
    phases: [{ type: "plan-implement" }],
    onSuccess: { names: ["In Review", "Code Review", "Review"], type: "started" },
    onFailure: { names: ["In Progress", "Doing"], type: "started" },
    clearDelegate: true,
};
/** Code Review → security + lead review gate → QA. */
const CODE_REVIEW_PLAN = {
    stateLabel: "code-review",
    phases: [
        { type: "review", role: "warden", gate: true },
        { type: "review", role: "apex", gate: true },
    ],
    onSuccess: { names: ["QA", "Testing", "In QA", "Ready for QA"], type: "started" },
    onFailure: { names: ["In Progress", "Doing"], type: "started" },
    clearDelegate: true,
};
/** QA → Proof QA gate → Done. */
const QA_PLAN = {
    stateLabel: "qa",
    phases: [{ type: "review", role: "proof", gate: true }],
    onSuccess: { names: ["Done", "Merged", "Complete", "Completed"], type: "completed" },
    onFailure: { names: ["In Review", "Code Review", "Review"], type: "started" },
    clearDelegate: true,
};
/**
 * Ordered matchers. Review/QA are checked BEFORE implement because custom
 * Linear states like "In Review" and "QA" usually carry type "started", which
 * the implement matcher would otherwise swallow.
 */
const MATCHERS = [
    {
        test: (s) => /\bqa\b|testing|quality assurance/i.test(s.name),
        plan: QA_PLAN,
    },
    {
        test: (s) => /review/i.test(s.name),
        plan: CODE_REVIEW_PLAN,
    },
    {
        test: (s) => /todo|to do|in progress|doing|selected|ready|triage|backlog/i.test(s.name) ||
            ["unstarted", "started", "triage"].includes(s.type),
        plan: IMPLEMENT_PLAN,
    },
];
// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------
/**
 * Normalize a raw config phase entry into a PlanPhase. Accepts either a string
 * shorthand (a role id or "plan-implement") or a full object.
 * @param raw - the raw config value
 * @returns a PlanPhase, or null if unrecognizable
 */
function normalizePhase(raw) {
    if (typeof raw === "string") {
        if (raw === "plan-implement")
            return { type: "plan-implement" };
        // Bare role id → infer review vs product isn't possible here; the
        // orchestrator resolves the role. Treat product roles as product, else review.
        const productRoles = ["helm", "lumen"];
        return productRoles.includes(raw)
            ? { type: "product", role: raw }
            : { type: "review", role: raw, gate: true };
    }
    if (raw && typeof raw === "object") {
        const o = raw;
        const type = o.type;
        if (type === "plan-implement")
            return { type };
        if (type === "review" || type === "product") {
            return {
                type,
                role: typeof o.role === "string" ? o.role : undefined,
                gate: type === "review" ? o.gate !== false : undefined,
            };
        }
    }
    return null;
}
/**
 * Parse a raw config `statePlans[<name>]` entry into a StatePlan.
 * @param raw - the raw config object for one state
 * @param label - the state label for logging
 * @returns a StatePlan, or null if it has no usable phases
 */
function parseConfigPlan(raw, label) {
    if (!raw || typeof raw !== "object")
        return null;
    const o = raw;
    const phases = Array.isArray(o.phases)
        ? o.phases.map(normalizePhase).filter((p) => p !== null)
        : [];
    if (phases.length === 0)
        return null;
    const normalizeTarget = (rawTarget) => {
        if (typeof rawTarget === "string")
            return { names: [rawTarget] };
        if (Array.isArray(rawTarget)) {
            return { names: rawTarget.filter((x) => typeof x === "string") };
        }
        if (rawTarget && typeof rawTarget === "object") {
            const target = rawTarget;
            return {
                names: Array.isArray(target.names)
                    ? target.names.filter((x) => typeof x === "string")
                    : [],
                type: typeof target.type === "string" ? target.type : undefined,
            };
        }
        return null;
    };
    return {
        stateLabel: label,
        phases,
        onSuccess: normalizeTarget(o.onSuccess),
        onFailure: normalizeTarget(o.onFailure),
        clearDelegate: o.clearDelegate !== false,
    };
}
// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------
/**
 * Resolve the phase plan for a ticket's current workflow state.
 *
 * Precedence: config `statePlans` keyed by exact state name (case-insensitive)
 * → built-in matcher by name/type → null (no orchestration for this state).
 * @param state - the ticket's current workflow state (name + type)
 * @param pluginConfig - the plugin config object
 * @returns the plan to run, or null when this state should not be orchestrated
 */
export function resolveStatePlan(state, pluginConfig) {
    // 1. Config override by exact state name (case-insensitive)
    const configPlans = pluginConfig?.statePlans;
    if (configPlans) {
        const key = Object.keys(configPlans).find((k) => k.toLowerCase() === state.name.toLowerCase());
        if (key) {
            const plan = parseConfigPlan(configPlans[key], state.name);
            if (plan)
                return plan;
        }
    }
    // 2. Built-in matcher
    for (const m of MATCHERS) {
        if (m.test(state))
            return { ...m.plan, stateLabel: `${m.plan.stateLabel} (${state.name})` };
    }
    // 3. No plan for this state (Done, Canceled, etc.)
    return null;
}
/**
 * Resolve a SuccessTarget against a team's actual workflow states, returning
 * the concrete state id to move to (or null if none match).
 * @param target - the candidate next-state descriptor
 * @param teamStates - all workflow states for the ticket's team
 * @returns { id, name } of the matched state, or null
 */
export function resolveTargetState(target, teamStates) {
    if (!target)
        return null;
    // 1. Exact name match (case-insensitive).
    for (const candidate of target.names) {
        const hit = teamStates.find((s) => s.name.toLowerCase() === candidate.toLowerCase());
        if (hit)
            return { id: hit.id, name: hit.name };
    }
    // 2. Contains match either direction — handles boards that name the state
    //    "Design Review" / "In QA" while our candidate is "Review" / "QA".
    for (const candidate of target.names) {
        const c = candidate.toLowerCase();
        const hit = teamStates.find((s) => s.name.toLowerCase().includes(c) || c.includes(s.name.toLowerCase()));
        if (hit)
            return { id: hit.id, name: hit.name };
    }
    // 3. Type fallback (e.g. any "started" / "completed" state).
    if (target.type) {
        const hit = teamStates.find((s) => s.type === target.type);
        if (hit)
            return { id: hit.id, name: hit.name };
    }
    return null;
}
/** Orchestration mode from config: "single" (default worker) or "stateplan". */
export function orchestrationMode(pluginConfig) {
    return pluginConfig?.orchestrationMode === "stateplan" ? "stateplan" : "single";
}
