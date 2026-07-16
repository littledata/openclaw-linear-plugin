/**
 * agent-plan.ts — Linear Agent Session "plan" (the native progress checklist).
 *
 * Linear renders an evolving checklist on the agent session when we push a
 * `plan` via the `agentSessionUpdate` mutation. The plan is a FLAT array of
 * steps — `{ content, status }` — and every update REPLACES the whole array
 * (there are no partial/step updates). See linear.app/developers agent plans.
 *
 * Our pipeline is three levels deep: state-plan PHASES (Implement, Code review,
 * QA), each specialist ASSIGNMENT (Spine, Forge, …) nested under its phase, and
 * that specialist's own ordered STEPS nested under it. Linear's plan is flat, so
 * we model the three levels here and flatten to a flat step list, rendering
 * assignments and steps as prefixed rows under their parent.
 *
 * Status is driven live: the orchestrator flips phase rows; the subagent
 * lifecycle hooks flip a specialist's assignment (and its steps) as the spawned
 * subagent starts and finishes. A `SessionPlan` is created per dispatch and kept
 * in a module registry keyed by the ticket identifier (e.g. "CORE-1751") so both
 * the orchestrator and the lifecycle hooks — which only know the identifier —
 * can reach it. Every mutator is best-effort and never throws into the pipeline.
 */
import type { LinearAgentApi } from "../api/linear-api.js";

/** Linear agent-plan step lifecycle states. */
export type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

/** A single flat plan row as Linear stores it. */
export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

/** One concrete action within a specialist's assignment. */
interface StepNode {
  content: string;
  status: PlanStepStatus;
}

/** A specialist's assignment plus its ordered steps. */
interface AssignmentNode {
  /** Match key for live status updates — the specialist agent/role id (e.g. "spine"). */
  key: string;
  label: string;
  task: string;
  status: PlanStepStatus;
  steps: StepNode[];
}

/** A pipeline phase plus its (optional) nested specialist assignments. */
interface PhaseNode {
  label: string;
  status: PlanStepStatus;
  assignments: AssignmentNode[];
}

/** Prefix that visually nests a specialist assignment under its phase. */
const ASSIGNMENT_PREFIX = "↳ ";
/** Prefix that visually nests a step under its specialist (glyph conveys depth
 *  even if a renderer collapses the leading whitespace). */
const STEP_PREFIX = "    • ";

/** Normalize an agent/role id for tolerant matching (lowercase, strip namespace). */
function normalizeKey(id: string): string {
  const raw = id.trim().toLowerCase();
  const parts = raw.split(/[:/]/);
  return parts[parts.length - 1] || raw;
}

export interface SessionPlanOptions {
  linearApi: Pick<LinearAgentApi, "updateSession">;
  agentSessionId?: string;
  enabled: boolean;
  logger?: { warn: (msg: string) => void };
}

/** Input shape for seeding a phase's specialist assignments. */
export interface AssignmentInput {
  /** The specialist agent/role id used to match live status updates. */
  key: string;
  /** Human label shown in the checklist (e.g. "Spine"). */
  label: string;
  /** One-line goal shown on Apex's “wait for specialist” row. */
  task?: string;
  /** The specialist's ordered step-by-step actions. */
  steps: string[];
}

/**
 * Builds and pushes a Linear agent-session plan for one dispatch. Phases are
 * top-level rows; each specialist assignment nests under its phase, and its
 * steps nest under it. Each `flush()` replaces the entire plan (Linear requires
 * full replacement).
 */
export class SessionPlan {
  private phases: PhaseNode[] = [];
  /** When set, the plan shows only this single placeholder row (e.g. while Apex
   *  is still preparing the plan) and hides the phase/assignment tree. */
  private preparing: string | null = null;
  /** Implement phase rendered as Apex orchestration stages instead of one
   * opaque "Implement" row. */
  private apexPhaseIndex: number | null = null;
  private apexPlanningStatus: PlanStepStatus = "pending";
  private apexReviewStatus: PlanStepStatus = "pending";

  /**
   * @param opts - Linear API handle, target session id, enable flag, logger
   */
  constructor(private readonly opts: SessionPlanOptions) {}

  /** Whether this plan can actually be pushed (enabled + a session to target). */
  private get active(): boolean {
    return this.opts.enabled && typeof this.opts.agentSessionId === "string" && !!this.opts.agentSessionId;
  }

  /**
   * Seed the top-level phase rows (all `pending`), in execution order.
   * @param labels - human phase labels, e.g. ["Implement", "Code review", "QA"]
   */
  initPhases(labels: string[]): void {
    this.phases = labels.map((label) => ({ label, status: "pending", assignments: [] }));
  }

  /**
   * Render one phase as Apex's explicit orchestration lifecycle: formulate the
   * plan, wait for each specialist, then review their combined work.
   * @param index - the plan-implement phase index
   */
  configureApexOrchestration(index: number): void {
    this.apexPhaseIndex = index;
    this.apexPlanningStatus = "inProgress";
    this.apexReviewStatus = "pending";
  }

  /**
   * Show a single placeholder row instead of the tree (e.g. "Apex is preparing
   * the plan…") until the real plan is ready. Cleared by `clearPreparing()`.
   * @param message - the placeholder row text
   */
  setPreparing(message: string): void {
    this.preparing = message;
  }

  /** Reveal the phase/assignment tree, dropping any preparing placeholder. */
  clearPreparing(): void {
    this.preparing = null;
  }

  /**
   * Set a phase row's status by its index in the phase list.
   * @param index - phase index (matches the orchestrator's phaseIndex)
   * @param status - new lifecycle status
   */
  setPhaseStatus(index: number, status: PlanStepStatus): void {
    const node = this.phases[index];
    if (!node) return;
    node.status = status;
    if (index !== this.apexPhaseIndex) return;
    if (status === "completed") {
      this.apexPlanningStatus = "completed";
      this.apexReviewStatus = "completed";
    } else if (status === "canceled") {
      if (this.apexPlanningStatus !== "completed") this.apexPlanningStatus = "canceled";
      if (this.apexReviewStatus !== "completed") this.apexReviewStatus = "canceled";
    }
  }

  /**
   * Attach (replace) the specialist assignments — each with its own steps —
   * nested under a phase.
   * @param index - phase index to nest under
   * @param assignments - specialist rows (key + label + ordered steps)
   */
  setAssignments(index: number, assignments: AssignmentInput[]): void {
    const node = this.phases[index];
    if (!node) return;
    node.assignments = assignments.map((a) => ({
      key: normalizeKey(a.key),
      label: a.label,
      task: a.task || a.steps[0] || `${a.label} assignment`,
      status: "pending",
      steps: a.steps.map((content) => ({ content, status: "pending" as PlanStepStatus })),
    }));
    if (index === this.apexPhaseIndex) this.apexPlanningStatus = "completed";
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
  setAssignmentStatus(key: string, status: PlanStepStatus): boolean {
    const target = normalizeKey(key);
    for (const phase of this.phases) {
      const assignment = phase.assignments.find((a) => a.key === target);
      if (!assignment) continue;
      assignment.status = status;
      if (status === "completed") {
        assignment.steps = assignment.steps.map((s) => ({ ...s, status: "completed" }));
      } else if (status === "canceled") {
        assignment.steps = assignment.steps.map((s) =>
          s.status === "completed" ? s : { ...s, status: "canceled" },
        );
      }
      if (
        this.phases[this.apexPhaseIndex ?? -1]?.assignments.length &&
        this.phases[this.apexPhaseIndex ?? -1]?.assignments.every((a) =>
          a.status === "completed" || a.status === "canceled"
        )
      ) {
        this.apexReviewStatus = "inProgress";
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
  setPhaseAssignmentsStatus(index: number, status: PlanStepStatus): void {
    const node = this.phases[index];
    if (!node) return;
    node.assignments = node.assignments.map((a) => ({
      ...a,
      status,
      steps: a.steps.map((s) => ({ ...s, status })),
    }));
    if (index === this.apexPhaseIndex) {
      if (status === "completed") this.apexReviewStatus = "completed";
      else if (status === "canceled") this.apexReviewStatus = "canceled";
    }
  }

  /** Flatten the three-level model into Linear's flat, prefixed step list. */
  toSteps(): PlanStep[] {
    if (this.preparing && this.apexPhaseIndex === null) {
      return [{ content: this.preparing, status: "inProgress" }];
    }
    const steps: PlanStep[] = [];
    for (const [phaseIndex, phase] of this.phases.entries()) {
      if (phaseIndex === this.apexPhaseIndex) {
        steps.push({ content: "Formulate plan", status: this.apexPlanningStatus });
        for (const assignment of phase.assignments) {
          steps.push({
            content: `Wait for ${assignment.label} — ${assignment.task}`,
            status: assignment.status,
          });
          for (const step of assignment.steps) {
            steps.push({ content: `${STEP_PREFIX}${step.content}`, status: step.status });
          }
        }
        steps.push({
          content: "Apex reviews specialist work and validates the combined change",
          status: this.apexReviewStatus,
        });
        continue;
      }
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

  /**
   * Read one specialist assignment for child-session creation.
   * @param key - specialist agent/role id
   * @returns the assignment task and steps, or undefined when not planned
   */
  getAssignment(key: string): { label: string; task: string; steps: string[] } | undefined {
    const target = normalizeKey(key);
    for (const phase of this.phases) {
      const assignment = phase.assignments.find((candidate) => candidate.key === target);
      if (!assignment) continue;
      return {
        label: assignment.label,
        task: assignment.task,
        steps: assignment.steps.map((step) => step.content),
      };
    }
    return undefined;
  }

  /**
   * Add an unplanned specialist that Apex spawned dynamically.
   * @param assignment - specialist identity and fallback task
   */
  addAssignment(assignment: AssignmentInput): void {
    if (this.getAssignment(assignment.key)) return;
    const index = this.apexPhaseIndex ?? 0;
    const node = this.phases[index];
    if (!node) return;
    node.assignments.push({
      key: normalizeKey(assignment.key),
      label: assignment.label,
      task: assignment.task || assignment.steps[0] || `${assignment.label} assignment`,
      status: "pending",
      steps: assignment.steps.map((content) => ({ content, status: "pending" })),
    });
  }

  /** Push the current plan to Linear (full replacement). Best-effort. */
  async flush(): Promise<void> {
    if (!this.active) return;
    try {
      await this.opts.linearApi.updateSession(this.opts.agentSessionId as string, { plan: this.toSteps() });
    } catch (err) {
      this.opts.logger?.warn(`[agent-plan] could not update session plan: ${err}`);
    }
  }
}

const plansByIssue = new Map<string, SessionPlan>();

/**
 * Create (and register) a SessionPlan for a dispatch, replacing any prior one.
 * @param key - dispatch registry key (the ticket identifier, e.g. "CORE-1751")
 * @param opts - SessionPlan options
 * @returns the new SessionPlan
 */
export function createSessionPlan(key: string, opts: SessionPlanOptions): SessionPlan {
  const plan = new SessionPlan(opts);
  plansByIssue.set(key, plan);
  return plan;
}

/**
 * Look up the SessionPlan registered for a dispatch, if any.
 * @param key - dispatch registry key (ticket identifier)
 * @returns the SessionPlan or undefined
 */
export function getSessionPlan(key: string): SessionPlan | undefined {
  return plansByIssue.get(key);
}

/**
 * Read a specialist assignment from the active Apex plan.
 * @param key - ticket identifier
 * @param agentKey - specialist role id
 * @returns the planned specialist task and ordered steps
 */
export function getAssignmentSnapshot(
  key: string,
  agentKey: string,
): { label: string; task: string; steps: string[] } | undefined {
  return plansByIssue.get(key)?.getAssignment(agentKey);
}

/**
 * Ensure a dynamically spawned specialist appears in Apex's orchestration
 * checklist even when it was not in the original structured plan.
 * @param key - ticket identifier
 * @param assignment - specialist identity and fallback task
 */
export async function ensureAssignmentInPlan(
  key: string,
  assignment: AssignmentInput,
): Promise<void> {
  const plan = plansByIssue.get(key);
  if (!plan || plan.getAssignment(assignment.key)) return;
  plan.addAssignment(assignment);
  await plan.flush();
}

/**
 * Drop the SessionPlan registered for a dispatch (end of run).
 * @param key - dispatch registry key (ticket identifier)
 */
export function disposeSessionPlan(key: string): void {
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
export async function updateAssignmentStatus(
  key: string,
  agentKey: string,
  status: PlanStepStatus,
): Promise<void> {
  const plan = plansByIssue.get(key);
  if (!plan) return;
  if (plan.setAssignmentStatus(agentKey, status)) await plan.flush();
}
