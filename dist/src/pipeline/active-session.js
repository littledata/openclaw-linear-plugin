/**
 * active-session.ts — Idempotent registry of active Linear agent sessions.
 *
 * When the pipeline starts work on an issue, it registers the session here.
 * Any tool (cli_codex, cli_claude, etc.) can look up the active session for the current
 * issue to stream activities without relying on the LLM agent to pass params.
 *
 * This runs in the gateway process. Tool execution also happens in the gateway,
 * so tools can read from this registry directly.
 *
 * The in-memory Map is the fast-path for tool lookups. On startup, the
 * dispatch service calls hydrateFromDispatchState() to rebuild it from
 * the persistent dispatch-state.json file.
 */
import { readDispatchState } from "./dispatch-state.js";
// Keyed by issue ID — one active session per issue at a time.
const sessions = new Map();
// Embedded specialist runs use their own agent/session ids while operating on
// an issue-owned container. Bind those trusted runtime identities explicitly so
// container tools never guess from a global "current session" under concurrency.
const agentRunIssueBySession = new Map();
const agentRunIssuesByAgent = new Map();
/** Bind an embedded agent run to the Linear issue whose container it may use. */
export function bindAgentRunToIssue(sessionId, agentId, issueIdentifier) {
    agentRunIssueBySession.set(sessionId, issueIdentifier);
    const runs = agentRunIssuesByAgent.get(agentId) ?? new Map();
    runs.set(sessionId, issueIdentifier);
    agentRunIssuesByAgent.set(agentId, runs);
}
/** Remove a completed embedded-run binding. */
export function unbindAgentRunFromIssue(sessionId, agentId) {
    agentRunIssueBySession.delete(sessionId);
    const runs = agentRunIssuesByAgent.get(agentId);
    if (!runs)
        return;
    runs.delete(sessionId);
    if (!runs.size)
        agentRunIssuesByAgent.delete(agentId);
}
/**
 * Remove a run binding by session id/key alone (agent id unknown). Used to clean
 * up a spawned subagent binding on subagent_ended, where only the child session
 * key is available. Scrubs the session from the session map and every agent map.
 * @param sessionId - the child session id/key to unbind
 */
export function unbindAgentRunSession(sessionId) {
    agentRunIssueBySession.delete(sessionId);
    for (const [agentId, runs] of agentRunIssuesByAgent) {
        if (runs.delete(sessionId) && !runs.size)
            agentRunIssuesByAgent.delete(agentId);
    }
}
/**
 * Resolve the issue identifier a spawn REQUESTER (the coding lead) is bound to,
 * so a cross-agent (isolated) subagent it spawns can be bound to the same ticket
 * container. Tries the requester's own session-key binding first; falls back to
 * the single active bound issue when exactly one exists (mirrors how the lead's
 * own container resolves — safe while tickets run one lead at a time).
 * @param requesterSessionKey - the spawn requester's session key (may be absent)
 * @returns the bound issue identifier, or null when it cannot be resolved
 */
export function resolveRequesterIssueIdentifier(requesterSessionKey) {
    if (requesterSessionKey && agentRunIssueBySession.has(requesterSessionKey)) {
        return agentRunIssueBySession.get(requesterSessionKey);
    }
    const identifiers = new Set(agentRunIssueBySession.values());
    return identifiers.size === 1 ? identifiers.values().next().value ?? null : null;
}
/** Resolve a trusted tool context to its explicitly-bound issue identifier. */
export function getIssueIdentifierForAgentRun(sessionId, sessionKey, agentId) {
    if (sessionId && agentRunIssueBySession.has(sessionId))
        return agentRunIssueBySession.get(sessionId);
    if (sessionKey && agentRunIssueBySession.has(sessionKey))
        return agentRunIssueBySession.get(sessionKey);
    if (!agentId)
        return null;
    const identifiers = new Set(agentRunIssuesByAgent.get(agentId)?.values() ?? []);
    return identifiers.size === 1 ? identifiers.values().next().value ?? null : null;
}
const issueAgentAffinity = new Map();
let _affinityTtlMs = 30 * 60_000; // 30 minutes default
/**
 * Register the active session for an issue. Idempotent — calling again
 * for the same issue just updates the session.
 *
 * Also eagerly records agent affinity so that follow-up webhooks arriving
 * during or after the run resolve to the correct agent — even if the
 * gateway restarts before clearActiveSession is called.
 */
export function setActiveSession(session) {
    sessions.set(session.issueId, session);
    if (session.agentId) {
        recordIssueAffinity(session.issueId, session.agentId);
    }
}
/**
 * Clear the active session for an issue.
 * If the session had an agentId, records it as affinity for future routing.
 */
export function clearActiveSession(issueId) {
    const session = sessions.get(issueId);
    if (session?.agentId) {
        recordIssueAffinity(issueId, session.agentId);
    }
    sessions.delete(issueId);
}
/**
 * Look up the active session for an issue by issue ID.
 */
export function getActiveSession(issueId) {
    return sessions.get(issueId) ?? null;
}
/**
 * Look up the active session by issue identifier (e.g. "API-472").
 * Slower than by ID — scans all sessions.
 */
export function getActiveSessionByIdentifier(identifier) {
    for (const session of sessions.values()) {
        if (session.issueIdentifier === identifier)
            return session;
    }
    return null;
}
/**
 * Get the current active session. If there's exactly one, return it.
 * If there are multiple (concurrent pipelines), returns null — caller
 * must specify which issue.
 */
export function getCurrentSession() {
    if (sessions.size === 1) {
        return sessions.values().next().value ?? null;
    }
    return null;
}
/**
 * Look up the most recent active session for a given agent ID.
 * When multiple sessions exist for the same agent, returns the most
 * recently started one. This is the primary lookup for tool execution
 * contexts where the agent ID is known but the issue isn't.
 */
export function getActiveSessionByAgentId(agentId) {
    let best = null;
    for (const session of sessions.values()) {
        if (session.agentId === agentId) {
            if (!best || session.startedAt > best.startedAt) {
                best = session;
            }
        }
    }
    return best;
}
/**
 * Hydrate the in-memory session Map from dispatch-state.json.
 * Called on startup by the dispatch service to restore sessions
 * that were active before a gateway restart.
 *
 * Returns the number of sessions restored.
 */
export async function hydrateFromDispatchState(configPath) {
    const state = await readDispatchState(configPath);
    const active = state.dispatches.active;
    let restored = 0;
    for (const [, dispatch] of Object.entries(active)) {
        if (dispatch.status === "dispatched" || dispatch.status === "working") {
            sessions.set(dispatch.issueId, {
                agentSessionId: dispatch.agentSessionId ?? "",
                issueIdentifier: dispatch.issueIdentifier,
                issueId: dispatch.issueId,
                startedAt: new Date(dispatch.dispatchedAt).getTime(),
            });
            restored++;
        }
    }
    return restored;
}
/**
 * Get the count of currently tracked sessions.
 */
export function getSessionCount() {
    return sessions.size;
}
// ---------------------------------------------------------------------------
// Issue-agent affinity — public API
// ---------------------------------------------------------------------------
/**
 * Record which agent last handled an issue.
 * Called automatically from clearActiveSession when an agentId is present.
 */
export function recordIssueAffinity(issueId, agentId) {
    issueAgentAffinity.set(issueId, { agentId, recordedAt: Date.now() });
}
/**
 * Look up which agent last handled an issue.
 * Returns null if no affinity recorded or if the entry has expired.
 */
export function getIssueAffinity(issueId) {
    const entry = issueAgentAffinity.get(issueId);
    if (!entry)
        return null;
    if (Date.now() - entry.recordedAt > _affinityTtlMs) {
        issueAgentAffinity.delete(issueId);
        return null;
    }
    return entry.agentId;
}
/** @internal — configure affinity TTL from pluginConfig. */
export function _configureAffinityTtl(ttlMs) {
    _affinityTtlMs = ttlMs ?? 30 * 60_000;
}
/** @internal — read current affinity TTL (for testing). */
export function _getAffinityTtlMs() {
    return _affinityTtlMs;
}
/** @internal — test-only; clears all affinity state and resets TTL. */
export function _resetAffinityForTesting() {
    issueAgentAffinity.clear();
    agentRunIssueBySession.clear();
    agentRunIssuesByAgent.clear();
    _affinityTtlMs = 30 * 60_000;
}
