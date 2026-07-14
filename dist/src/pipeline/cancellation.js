/**
 * cancellation.ts — cooperative cancel for the state-driven orchestrator.
 *
 * STOP aborts the CURRENT sub-run (embedded runAgent via abortKey, or the codex
 * tmux via killActiveSession), but `runStatePlan` is a plain async loop — killing
 * one role's run doesn't stop it advancing to the next phase/role and spawning a
 * fresh run. This registry lets STOP flag an issue as cancelled; the orchestrator
 * checks it between phases and roles and bails cleanly.
 */
const cancelled = new Set();
/** Flag an issue's orchestration to halt at the next checkpoint (called by STOP). */
export function requestCancel(issueId) {
    cancelled.add(issueId);
}
/** Whether a halt has been requested for an issue. */
export function isCancelled(issueId) {
    return cancelled.has(issueId);
}
/** Clear the flag — at the start of a fresh dispatch, or once a halt is honored. */
export function clearCancel(issueId) {
    cancelled.delete(issueId);
}
