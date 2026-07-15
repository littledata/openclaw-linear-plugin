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

export type PhaseType = "plan-implement" | "review" | "product";

/** Pipeline role an agent plays in a phase (drives GitHub key + tool policy). */
export type PhaseKind = "plan-implement" | "review" | "qa";

export interface PlanPhase {
  type: PhaseType;
  /**
   * The OpenClaw agent id assigned to this phase. Any configured agent can be
   * mapped to any Linear status. Falls back to `role` (legacy) when unset.
   */
  agentId?: string;
  /**
   * Legacy role id for `review` / `product` phases. Superseded by `agentId`;
   * still honored so existing configs keep working. Ignored for plan-implement.
   */
  role?: string;
  /**
   * The pipeline kind this phase runs as — selects the GitHub key, tool policy,
   * and workspace-prompt mode. Defaults from `type` (review→review, product→qa)
   * but a review-status running QA can set `kind:"qa"` explicitly.
   */
  kind?: PhaseKind;
  /** A failing verdict gates (triggers bounded rework). Defaults true for reviews. */
  gate?: boolean;
}

/** The effective agent id for a phase: explicit `agentId`, else legacy `role`. */
export function phaseAgentId(phase: PlanPhase): string | undefined {
  return phase.agentId ?? phase.role;
}

/** The effective pipeline kind for a phase (explicit `kind`, else derived from `type`). */
export function phaseKind(phase: PlanPhase): PhaseKind {
  if (phase.kind) return phase.kind;
  return phase.type === "plan-implement" ? "plan-implement" : "review";
}

export interface SuccessTarget {
  /** Candidate Linear state NAMES to move to (first team-state match wins). */
  names: string[];
  /** Fallback state TYPE if no name matches (e.g. "started", "completed"). */
  type?: string;
}

export interface StatePlan {
  /** Human label for logs (the matched state / plan). */
  stateLabel: string;
  phases: PlanPhase[];
  /** Candidate next state after every phase passes. Null = don't move. */
  onSuccess: SuccessTarget | null;
  /** Candidate state on a gated failure. Null/undefined = don't move. */
  onFailure?: SuccessTarget | null;
  /** Release the Linear delegate after a terminal pass/fail. Defaults true. */
  clearDelegate?: boolean;
}

export interface WorkflowState {
  name: string;
  type: string;
}

/** True when a state plan contains reviewers only and must skip implementation preflight. */
export function isReviewOnlyPlan(plan: StatePlan | null | undefined): plan is StatePlan {
  return !!plan?.phases.length && plan.phases.every((phase) => phase.type === "review");
}

// ---------------------------------------------------------------------------
// Built-in default plans
// ---------------------------------------------------------------------------

/** Todo / In Progress → build (Apex-led, in-session subagents) → Code Review. */
const IMPLEMENT_PLAN: StatePlan = {
  stateLabel: "implement",
  phases: [{ type: "plan-implement", agentId: "apex", kind: "plan-implement" }],
  onSuccess: { names: ["In Review", "Code Review", "Review"], type: "started" },
  onFailure: { names: ["In Progress", "Doing"], type: "started" },
  clearDelegate: true,
};

/** Code Review → lead review (apex-reviewer) + security review (warden) gate → QA. */
const CODE_REVIEW_PLAN: StatePlan = {
  stateLabel: "code-review",
  phases: [
    { type: "review", agentId: "apex-reviewer", kind: "review", gate: true },
    { type: "review", agentId: "warden", kind: "review", gate: true },
  ],
  onSuccess: { names: ["QA", "Testing", "In QA", "Ready for QA"], type: "started" },
  onFailure: { names: ["In Progress", "Doing"], type: "started" },
  clearDelegate: true,
};

/** QA → Proof QA gate → Done. */
const QA_PLAN: StatePlan = {
  stateLabel: "qa",
  phases: [{ type: "review", agentId: "proof", kind: "qa", gate: true }],
  onSuccess: { names: ["Done", "Merged", "Complete", "Completed"], type: "completed" },
  onFailure: { names: ["In Review", "Code Review", "Review"], type: "started" },
  clearDelegate: true,
};

/**
 * Ordered matchers. Review/QA are checked BEFORE implement because custom
 * Linear states like "In Review" and "QA" usually carry type "started", which
 * the implement matcher would otherwise swallow.
 */
const MATCHERS: Array<{ test: (s: WorkflowState) => boolean; plan: StatePlan }> = [
  {
    test: (s) => /\bqa\b|testing|quality assurance/i.test(s.name),
    plan: QA_PLAN,
  },
  {
    test: (s) => /review/i.test(s.name),
    plan: CODE_REVIEW_PLAN,
  },
  {
    test: (s) =>
      /todo|to do|in progress|doing|selected|ready|triage|backlog/i.test(s.name) ||
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
function normalizePhase(raw: unknown): PlanPhase | null {
  if (typeof raw === "string") {
    if (raw === "plan-implement") return { type: "plan-implement", agentId: "apex", kind: "plan-implement" };
    // Bare agent/role id → infer review vs product. `apex` at a bare mapping is
    // the coding lead (plan-implement); product agents are product; else review.
    if (raw === "apex") return { type: "plan-implement", agentId: "apex", kind: "plan-implement" };
    const productRoles = ["helm", "lumen"];
    return productRoles.includes(raw)
      ? { type: "product", agentId: raw }
      : { type: "review", agentId: raw, kind: raw === "proof" ? "qa" : "review", gate: true };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const type = o.type as PhaseType | undefined;
    const agentId = typeof o.agentId === "string" ? o.agentId : typeof o.role === "string" ? o.role : undefined;
    const kind = o.kind === "plan-implement" || o.kind === "review" || o.kind === "qa" ? (o.kind as PhaseKind) : undefined;
    if (type === "plan-implement") return { type, agentId: agentId ?? "apex", kind: kind ?? "plan-implement" };
    if (type === "review" || type === "product") {
      return {
        type,
        agentId,
        role: typeof o.role === "string" ? o.role : undefined,
        kind: kind ?? (type === "product" ? "qa" : "review"),
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
function parseConfigPlan(raw: unknown, label: string): StatePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const phases = Array.isArray(o.phases)
    ? o.phases.map(normalizePhase).filter((p): p is PlanPhase => p !== null)
    : [];
  if (phases.length === 0) return null;

  const normalizeTarget = (rawTarget: unknown): SuccessTarget | null => {
    if (typeof rawTarget === "string") return { names: [rawTarget] };
    if (Array.isArray(rawTarget)) {
      return { names: rawTarget.filter((x): x is string => typeof x === "string") };
    }
    if (rawTarget && typeof rawTarget === "object") {
      const target = rawTarget as Record<string, unknown>;
      return {
        names: Array.isArray(target.names)
          ? target.names.filter((x): x is string => typeof x === "string")
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
export function resolveStatePlan(
  state: WorkflowState,
  pluginConfig?: Record<string, unknown>,
): StatePlan | null {
  // 1. Config override by exact state name (case-insensitive)
  const configPlans = pluginConfig?.statePlans as Record<string, unknown> | undefined;
  if (configPlans) {
    const key = Object.keys(configPlans).find(
      (k) => k.toLowerCase() === state.name.toLowerCase(),
    );
    if (key) {
      const plan = parseConfigPlan(configPlans[key], state.name);
      if (plan) return plan;
    }
  }

  // 2. Built-in matcher
  for (const m of MATCHERS) {
    if (m.test(state)) return { ...m.plan, stateLabel: `${m.plan.stateLabel} (${state.name})` };
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
export function resolveTargetState(
  target: SuccessTarget | null,
  teamStates: Array<{ id: string; name: string; type: string }>,
): { id: string; name: string } | null {
  if (!target) return null;
  // 1. Exact name match (case-insensitive).
  for (const candidate of target.names) {
    const hit = teamStates.find((s) => s.name.toLowerCase() === candidate.toLowerCase());
    if (hit) return { id: hit.id, name: hit.name };
  }
  // 2. Contains match either direction — handles boards that name the state
  //    "Design Review" / "In QA" while our candidate is "Review" / "QA".
  for (const candidate of target.names) {
    const c = candidate.toLowerCase();
    const hit = teamStates.find(
      (s) => s.name.toLowerCase().includes(c) || c.includes(s.name.toLowerCase()),
    );
    if (hit) return { id: hit.id, name: hit.name };
  }
  // 3. Type fallback (e.g. any "started" / "completed" state).
  if (target.type) {
    const hit = teamStates.find((s) => s.type === target.type);
    if (hit) return { id: hit.id, name: hit.name };
  }
  return null;
}

/** Orchestration mode from config: "single" (default worker) or "stateplan". */
export function orchestrationMode(pluginConfig?: Record<string, unknown>): "single" | "stateplan" {
  return pluginConfig?.orchestrationMode === "stateplan" ? "stateplan" : "single";
}
