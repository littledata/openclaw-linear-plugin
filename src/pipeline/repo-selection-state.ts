/**
 * repo-selection-state.ts — persistence for interactive repository selection.
 *
 * When a dispatch is triggered without an explicit repository and
 * `repoSelectionMode` asks the user to choose, the dispatch is NOT created yet.
 * Instead we emit an elicitation in the Agent Session and park a lightweight
 * pending record here. The `prompted` webhook handler reads it back, parses the
 * user's reply, clears it, and resumes the dispatch with the chosen repos.
 *
 * Deliberately independent of dispatch-state.ts so repo selection never touches
 * the dispatch status machine (lower blast radius).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PendingRepoSelection {
  issueId: string;
  issueIdentifier: string;
  /** Repo names in the exact order presented to the user (for numeric replies). */
  candidates: string[];
  agentSessionId?: string;
  createdAt: string;
}

type Store = Record<string, PendingRepoSelection>;

function storePath(): string {
  return path.join(homedir(), ".openclaw", "linear-repo-selection.json");
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
 * Park a pending repo selection for an issue.
 * @param sel - the pending selection record
 */
export function savePendingRepoSelection(sel: PendingRepoSelection): void {
  const store = read();
  store[sel.issueId] = sel;
  write(store);
}

/**
 * Look up a parked repo selection for an issue.
 * @param issueId - the Linear issue id
 * @returns the pending record, or undefined if none is parked
 */
export function getPendingRepoSelection(issueId: string): PendingRepoSelection | undefined {
  return read()[issueId];
}

/**
 * Clear a parked repo selection once it has been resolved.
 * @param issueId - the Linear issue id
 */
export function clearPendingRepoSelection(issueId: string): void {
  const store = read();
  if (store[issueId]) {
    delete store[issueId];
    write(store);
  }
}

/**
 * Parse a user's free-text reply into selected repo names. Accepts 1-based
 * numbers, exact repo names (case-insensitive), comma/space separated, or the
 * keywords "all"/"both"/"everything".
 * @param reply - the user's reply text
 * @param candidates - the repo names in the order they were presented
 * @returns the resolved, de-duplicated repo names (empty if nothing matched)
 */
export function parseRepoSelection(reply: string, candidates: string[]): string[] {
  if (/\b(all|both|everything|every\s+repo)\b/i.test(reply)) return [...candidates];
  const tokens = reply.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const selected: string[] = [];
  for (const tok of tokens) {
    const num = Number(tok);
    if (Number.isInteger(num) && num >= 1 && num <= candidates.length) {
      selected.push(candidates[num - 1]);
      continue;
    }
    const match = candidates.find((c) => c.toLowerCase() === tok.toLowerCase());
    if (match) selected.push(match);
  }
  return [...new Set(selected)];
}
