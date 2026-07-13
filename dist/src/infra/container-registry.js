/**
 * container-registry.ts — per-issue container bookkeeping with a SLIDING TTL.
 *
 * Each Linear issue owns one Docker container (see container-runner.ts). This
 * registry records what that container is (name, cloned repos, branch) and when
 * it was last used, so:
 *   - the container tools can revive/reuse the right container for the active
 *     issue without re-deriving config, and
 *   - the reaper can expire containers that have been IDLE past the TTL (reset on
 *     every use), rather than a fixed lifetime from creation.
 *
 * Backed by a JSON file in ~/.openclaw so it survives gateway restarts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function storePath() {
    return path.join(homedir(), ".openclaw", "linear-containers.json");
}
function read() {
    const p = storePath();
    if (!existsSync(p))
        return {};
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        return {};
    }
}
function write(store) {
    const p = storePath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store, null, 2), "utf8");
}
/**
 * Create or replace the container record for an issue.
 * @param rec - the container record to persist
 */
export function setContainerRecord(rec) {
    const store = read();
    store[rec.issueIdentifier] = rec;
    write(store);
}
/**
 * Look up the container record for an issue.
 * @param issueIdentifier - the Linear issue identifier (e.g. "CORE-1740")
 * @returns the record, or undefined if none exists
 */
export function getContainerRecord(issueIdentifier) {
    return read()[issueIdentifier];
}
/**
 * Reset the sliding TTL for an issue's container by stamping lastUsed.
 * No-op if there's no record (e.g. an ad-hoc container).
 * @param issueIdentifier - the Linear issue identifier
 * @param nowMs - current time in ms (injectable for tests)
 */
export function touchContainer(issueIdentifier, nowMs = Date.now()) {
    const store = read();
    const rec = store[issueIdentifier];
    if (!rec)
        return;
    rec.lastUsedMs = nowMs;
    write(store);
}
/**
 * Remove a container record (after the container is destroyed/reaped).
 * @param issueIdentifier - the Linear issue identifier
 */
export function removeContainerRecord(issueIdentifier) {
    const store = read();
    if (store[issueIdentifier]) {
        delete store[issueIdentifier];
        write(store);
    }
}
/**
 * List all container records.
 * @returns every persisted container record
 */
export function listContainerRecords() {
    return Object.values(read());
}
/**
 * Select the records whose containers have been idle longer than the TTL.
 * Pure — takes the records + clock so it's unit-testable.
 * @param records - the container records to check
 * @param nowMs - current time in ms
 * @param ttlMs - idle time-to-live in ms
 * @returns the records that should be reaped
 */
export function selectIdleExpired(records, nowMs, ttlMs) {
    return records.filter((r) => {
        const last = Number.isFinite(r.lastUsedMs) ? r.lastUsedMs : r.createdAtMs;
        // Treat an unparseable/missing timestamp as expired so it can't linger forever.
        if (!Number.isFinite(last))
            return true;
        return nowMs - last > ttlMs;
    });
}
