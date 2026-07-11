/**
 * resume-state.ts — persistence for the resume-or-fresh gate.
 *
 * When a new dispatch finds prior work on an issue, it asks the user "resume or
 * start fresh?" via an Agent Session elicitation and parks the decision here
 * (with the gathered prior-work context) until the user replies. The `prompted`
 * handler reads this, parses the answer, and continues the dispatch. Kept
 * separate from grill/dispatch state so the gate never touches those machines.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ResumeState {
  issueId: string;
  issueIdentifier: string;
  agentSessionId?: string;
  /** Full prior-work transcript, fed to the resume-analysis step. */
  fullContext: string;
  createdAt: string;
}

type Store = Record<string, ResumeState>;

function storePath(): string {
  return path.join(homedir(), ".openclaw", "linear-resume-state.json");
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
 * Look up a parked resume decision for an issue.
 * @param issueId - the Linear issue id
 * @returns the resume state, or undefined
 */
export function getResume(issueId: string): ResumeState | undefined {
  return read()[issueId];
}

/**
 * Save/replace the parked resume state for an issue.
 * @param state - the resume state to persist
 */
export function saveResume(state: ResumeState): void {
  const store = read();
  store[state.issueId] = state;
  write(store);
}

/**
 * Clear the parked resume state once the dispatch has continued.
 * @param issueId - the Linear issue id
 */
export function clearResume(issueId: string): void {
  const store = read();
  if (store[issueId]) {
    delete store[issueId];
    write(store);
  }
}

// ---------------------------------------------------------------------------
// "Resume handled" marker — stops the gate re-firing within one engagement.
//
// The resume gate lives at the TOP of handleDispatch, so EVERY re-entry (a grill
// reply, a repo-selection reply, or a stray Issue.update re-delegation) re-checks
// it. Once the user has decided (or the gate was skipped because there was no
// prior work), we mark the issue "handled" for a short TTL so those re-entries
// proceed straight through instead of re-asking. Genuine re-engagement after the
// TTL re-evaluates prior work as normal. Kept in its own store, independent of
// the parked-decision store above.
// ---------------------------------------------------------------------------

/** How long a "resume handled" mark suppresses the gate (sliding — refreshed on each re-entry). */
export const RESUME_HANDLED_TTL_MS = 20 * 60_000;

function handledPath(): string {
  return path.join(homedir(), ".openclaw", "linear-resume-handled.json");
}

function readHandled(): Record<string, number> {
  const p = handledPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeHandled(store: Record<string, number>): void {
  const p = handledPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), "utf8");
}

/** Pure TTL check — a mark is fresh when it exists and is within the window. */
export function isHandledFresh(
  ts: number | undefined,
  now: number,
  ttlMs: number = RESUME_HANDLED_TTL_MS,
): boolean {
  return typeof ts === "number" && now - ts < ttlMs;
}

/**
 * Record that the resume gate has been handled for an issue (idempotent; a
 * fresh call slides the TTL so an active engagement keeps the gate suppressed).
 * @param issueId - the Linear issue id
 * @param now - current epoch ms (injectable for tests)
 */
export function markResumeHandled(issueId: string, now: number = Date.now()): void {
  const store = readHandled();
  store[issueId] = now;
  writeHandled(store);
}

/**
 * Whether the resume gate was handled for this issue recently enough to skip it.
 * @param issueId - the Linear issue id
 * @param now - current epoch ms (injectable for tests)
 * @param ttlMs - suppression window
 * @returns true when a fresh mark exists
 */
export function wasResumeHandledRecently(
  issueId: string,
  now: number = Date.now(),
  ttlMs: number = RESUME_HANDLED_TTL_MS,
): boolean {
  return isHandledFresh(readHandled()[issueId], now, ttlMs);
}

/**
 * Drop the "resume handled" mark (on STOP, so the next engagement re-asks).
 * @param issueId - the Linear issue id
 */
export function clearResumeHandled(issueId: string): void {
  const store = readHandled();
  if (store[issueId] !== undefined) {
    delete store[issueId];
    writeHandled(store);
  }
}

/**
 * Parse the user's reply to the resume/fresh prompt.
 * @param reply - the raw user message
 * @returns "resume", "fresh", or null when unrecognized
 */
export function parseResumeDecision(reply: string): "resume" | "fresh" | null {
  const r = reply.toLowerCase().trim();
  if (/\b(fresh|restart|start over|start fresh|from scratch|redo|new|scratch|reset)\b/.test(r)) {
    return "fresh";
  }
  if (/\b(resume|continue|pick up|keep going|carry on|proceed|yes)\b/.test(r)) {
    return "resume";
  }
  return null;
}
