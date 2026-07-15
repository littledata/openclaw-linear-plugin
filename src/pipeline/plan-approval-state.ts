/**
 * plan-approval-state.ts — persistence for the Apex plan-approval gate.
 *
 * When `planApprovalGate` is on, the implement phase pauses AFTER Apex produces
 * its plan and BEFORE any implementer subagent runs: the plan is posted to Linear
 * with a clickable Approve / Request-changes elicitation, and the dispatch parks
 * here. The webhook's `prompted` handler reads this park to interpret the user's
 * reply — approve → resume and implement; feedback → Apex revises and re-presents.
 *
 * Kept separate from dispatch-state.ts (which owns the run status machine) so the
 * gate is a thin overlay: the dispatch simply pauses and resumes like a STOP.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type PlanApprovalStatus = "pending" | "approved";

export interface PlanApprovalState {
  issueId: string;
  issueIdentifier: string;
  agentSessionId?: string;
  /** "pending" while awaiting the user's decision; "approved" once they sign off. */
  status: PlanApprovalStatus;
  /** The plan text presented for approval (for re-display / audit). */
  plan?: string;
  /** The approved assignments to reuse verbatim once the user signs off. */
  assignments?: Array<{ role: string; task: string }>;
  /** How many times a plan has been presented (bounds the revise loop). */
  rounds: number;
  createdAt: string;
}

type Store = Record<string, PlanApprovalState>;

function storePath(): string {
  return path.join(homedir(), ".openclaw", "linear-plan-approval.json");
}

function read(): Store {
  const p = storePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const p = storePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), "utf8");
}

/**
 * The parked plan-approval state for an issue, if any.
 * @param issueId - the Linear issue id
 * @returns the state, or undefined when no gate is active
 */
export function getPlanApproval(issueId: string): PlanApprovalState | undefined {
  return read()[issueId];
}

/**
 * Save/replace the plan-approval state for an issue.
 * @param state - the state to persist
 */
export function savePlanApproval(state: PlanApprovalState): void {
  const store = read();
  store[state.issueId] = state;
  write(store);
}

/**
 * Clear the plan-approval state for an issue (after approval consumed or reset).
 * @param issueId - the Linear issue id
 */
export function clearPlanApproval(issueId: string): void {
  const store = read();
  if (store[issueId]) {
    delete store[issueId];
    write(store);
  }
}

/** Reply words that count as approval (case-insensitive, whole-ish message). */
const APPROVE_PATTERNS = [
  /^\s*approve[d]?\s*$/i,
  /^\s*(lgtm|ok|okay|yes|yep|yup|go|ship it|proceed|sounds good|👍|✅)\s*$/i,
  /\bapprove(d)?\b/i,
  /\blooks good\b/i,
];

/**
 * Decide whether a user's reply approves the plan (vs. requests changes).
 * Conservative: only an explicit affirmative approves; anything else is treated
 * as change-request feedback so we never implement an unapproved plan.
 * @param reply - the user's reply text
 * @returns true when the reply is an approval
 */
export function isApprovalReply(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return false;
  return APPROVE_PATTERNS.some((re) => re.test(text));
}
