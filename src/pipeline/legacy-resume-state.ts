/**
 * Compatibility cleanup for state written by releases that used the removed
 * resume/fresh gate. New releases never create or read these records.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LEGACY_STORE_NAMES = [
  "linear-resume-state.json",
  "linear-resume-handled.json",
];

/**
 * Remove an issue from both legacy resume-gate stores.
 * @param issueId - Linear issue id whose stale gate records should be deleted
 */
export function clearLegacyResumeState(issueId: string): void {
  for (const name of LEGACY_STORE_NAMES) {
    const file = path.join(homedir(), ".openclaw", name);
    if (!existsSync(file)) continue;
    let store: Record<string, unknown>;
    try {
      store = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!(issueId in store)) continue;
    delete store[issueId];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
  }
}
