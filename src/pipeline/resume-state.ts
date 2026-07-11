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
