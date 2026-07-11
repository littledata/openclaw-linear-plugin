/**
 * grill-state.ts — persistence for the /grill-me startup interview.
 *
 * When `grillMode` is on, a dispatch first interviews the user (one question at a
 * time via Agent Session elicitations) to establish WHICH repo(s) the work belongs
 * in and to clarify requirements, BEFORE spawning the coding worker. The Q&A is
 * parked here between the elicitation and the user's reply; the `prompted` handler
 * appends each answer and resumes the dispatch. Independent of dispatch-state.ts
 * so the interview never touches the dispatch status machine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface GrillQA {
  question: string;
  answer: string;
}

export interface GrillState {
  issueId: string;
  issueIdentifier: string;
  agentSessionId?: string;
  qa: GrillQA[];
  /** The question awaiting a user answer (set when parked on an elicitation). */
  pendingQuestion?: string;
  createdAt: string;
}

type Store = Record<string, GrillState>;

function storePath(): string {
  return path.join(homedir(), ".openclaw", "linear-grill-state.json");
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
 * Look up the parked interview state for an issue.
 * @param issueId - the Linear issue id
 * @returns the grill state, or undefined if no interview is in progress
 */
export function getGrill(issueId: string): GrillState | undefined {
  return read()[issueId];
}

/**
 * Save/replace the interview state for an issue.
 * @param state - the grill state to persist
 */
export function saveGrill(state: GrillState): void {
  const store = read();
  store[state.issueId] = state;
  write(store);
}

/**
 * Clear the interview state once the dispatch has been resumed.
 * @param issueId - the Linear issue id
 */
export function clearGrill(issueId: string): void {
  const store = read();
  if (store[issueId]) {
    delete store[issueId];
    write(store);
  }
}
