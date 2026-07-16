const states = new Map();
function stateFor(identifier) {
    let state = states.get(identifier);
    if (!state) {
        state = { generation: 0, active: new Map(), completed: [], waiters: new Set() };
        states.set(identifier, state);
    }
    return state;
}
/** Capture the current spawn generation before starting a coding-lead turn. */
export function captureNativeSubagentGeneration(identifier) {
    return stateFor(identifier).generation;
}
/** Register a specialist spawned for an issue. */
export function registerNativeSubagent(identifier, key) {
    const state = stateFor(identifier);
    state.generation += 1;
    state.active.set(key, state.generation);
}
/** Record a specialist terminal event and wake any batch waiters. */
export function completeNativeSubagent(identifier, key, outcome, detail) {
    const state = stateFor(identifier);
    const generation = state.active.get(key);
    if (generation === undefined)
        return;
    state.active.delete(key);
    state.completed.push({ key, generation, outcome, ...(detail ? { detail } : {}) });
    if (state.completed.length > 100)
        state.completed.splice(0, state.completed.length - 100);
    for (const wake of state.waiters)
        wake();
}
/**
 * Wait until every specialist spawned after `afterGeneration` reaches a
 * terminal state. Returns immediately when the lead spawned no specialists.
 * @param identifier - Linear issue identifier.
 * @param afterGeneration - Snapshot captured before the lead turn.
 * @param opts - Timeout and cancellation hooks.
 * @returns The completed specialist batch.
 */
export async function waitForNativeSubagentBatch(identifier, afterGeneration, opts) {
    const state = stateFor(identifier);
    const spawned = state.generation > afterGeneration;
    if (!spawned) {
        return { spawned: false, timedOut: false, cancelled: false, outcomes: [] };
    }
    const hasActive = () => [...state.active.values()].some((generation) => generation > afterGeneration);
    const outcomes = () => state.completed.filter((entry) => entry.generation > afterGeneration);
    if (!hasActive()) {
        return { spawned: true, timedOut: false, cancelled: false, outcomes: outcomes() };
    }
    const timeoutMs = opts?.timeoutMs ?? 2 * 60 * 60_000;
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let timer;
        const finish = (timedOut, cancelled) => {
            clearTimeout(timer);
            state.waiters.delete(check);
            resolve({ spawned: true, timedOut, cancelled, outcomes: outcomes() });
        };
        const check = () => {
            if (opts?.isCancelled?.())
                return finish(false, true);
            if (!hasActive())
                return finish(false, false);
            if (Date.now() - startedAt >= timeoutMs)
                return finish(true, false);
            timer = setTimeout(check, 250);
            timer.unref?.();
        };
        state.waiters.add(check);
        timer = setTimeout(check, 0);
    });
}
/** Reset process-local state for isolated tests. */
export function _resetNativeSubagentBatchesForTesting() {
    states.clear();
}
