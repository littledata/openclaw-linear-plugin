/** Terminal state reported by OpenClaw for one native specialist subagent. */
export interface NativeSubagentOutcome {
  key: string;
  generation: number;
  outcome: string;
  detail?: string;
}

/** Result of waiting for every specialist spawned after a captured generation. */
export interface NativeSubagentBatchResult {
  spawned: boolean;
  timedOut: boolean;
  cancelled: boolean;
  outcomes: NativeSubagentOutcome[];
}

interface IssueSubagentState {
  generation: number;
  active: Map<string, number>;
  completed: NativeSubagentOutcome[];
  waiters: Set<() => void>;
}

const states = new Map<string, IssueSubagentState>();

function stateFor(identifier: string): IssueSubagentState {
  let state = states.get(identifier);
  if (!state) {
    state = { generation: 0, active: new Map(), completed: [], waiters: new Set() };
    states.set(identifier, state);
  }
  return state;
}

/** Capture the current spawn generation before starting a coding-lead turn. */
export function captureNativeSubagentGeneration(identifier: string): number {
  return stateFor(identifier).generation;
}

/** Register a specialist spawned for an issue. */
export function registerNativeSubagent(identifier: string, key: string): void {
  const state = stateFor(identifier);
  state.generation += 1;
  state.active.set(key, state.generation);
}

/** Record a specialist terminal event and wake any batch waiters. */
export function completeNativeSubagent(
  identifier: string,
  key: string,
  outcome: string,
  detail?: string,
): void {
  const state = stateFor(identifier);
  const generation = state.active.get(key);
  if (generation === undefined) return;
  state.active.delete(key);
  state.completed.push({ key, generation, outcome, ...(detail ? { detail } : {}) });
  if (state.completed.length > 100) state.completed.splice(0, state.completed.length - 100);
  for (const wake of state.waiters) wake();
}

/**
 * Wait until every specialist spawned after `afterGeneration` reaches a
 * terminal state. Returns immediately when the lead spawned no specialists.
 * @param identifier - Linear issue identifier.
 * @param afterGeneration - Snapshot captured before the lead turn.
 * @param opts - Timeout and cancellation hooks.
 * @returns The completed specialist batch.
 */
export async function waitForNativeSubagentBatch(
  identifier: string,
  afterGeneration: number,
  opts?: { timeoutMs?: number; isCancelled?: () => boolean },
): Promise<NativeSubagentBatchResult> {
  const state = stateFor(identifier);
  const spawned = state.generation > afterGeneration;
  if (!spawned) {
    return { spawned: false, timedOut: false, cancelled: false, outcomes: [] };
  }

  const hasActive = (): boolean =>
    [...state.active.values()].some((generation) => generation > afterGeneration);
  const outcomes = (): NativeSubagentOutcome[] =>
    state.completed.filter((entry) => entry.generation > afterGeneration);
  if (!hasActive()) {
    return { spawned: true, timedOut: false, cancelled: false, outcomes: outcomes() };
  }

  const timeoutMs = opts?.timeoutMs ?? 2 * 60 * 60_000;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (timedOut: boolean, cancelled: boolean) => {
      clearTimeout(timer);
      state.waiters.delete(check);
      resolve({ spawned: true, timedOut, cancelled, outcomes: outcomes() });
    };
    const check = () => {
      if (opts?.isCancelled?.()) return finish(false, true);
      if (!hasActive()) return finish(false, false);
      if (Date.now() - startedAt >= timeoutMs) return finish(true, false);
      timer = setTimeout(check, 250);
      timer.unref?.();
    };
    state.waiters.add(check);
    timer = setTimeout(check, 0);
  });
}

/** Reset process-local state for isolated tests. */
export function _resetNativeSubagentBatchesForTesting(): void {
  states.clear();
}
