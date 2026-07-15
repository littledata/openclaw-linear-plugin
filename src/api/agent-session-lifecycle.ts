/**
 * Process-local Linear Agent Session lifecycle state.
 *
 * Linear derives a session's visible state from its latest activity. When a
 * user stops a run, any delayed tool/thought activity emitted after the final
 * response would make the session look active again. This registry serializes
 * activities per session and fences emissions from older lifecycle generations.
 */

interface SessionLifecycle {
  generation: number;
  complete: boolean;
}

const lifecycles = new Map<string, SessionLifecycle>();
const activityQueues = new Map<string, Promise<void>>();

function lifecycleFor(agentSessionId: string): SessionLifecycle {
  return lifecycles.get(agentSessionId) ?? { generation: 0, complete: false };
}

/**
 * Close an Agent Session activity stream before emitting its terminal response.
 * @param agentSessionId - Linear Agent Session id
 */
export function markAgentSessionComplete(agentSessionId: string): void {
  const current = lifecycleFor(agentSessionId);
  lifecycles.set(agentSessionId, {
    generation: current.generation + 1,
    complete: true,
  });
}

/**
 * Reopen a completed Agent Session when the user sends a continuation prompt.
 * @param agentSessionId - Linear Agent Session id
 */
export function resumeAgentSession(agentSessionId: string): void {
  const current = lifecycleFor(agentSessionId);
  lifecycles.set(agentSessionId, {
    generation: current.generation + 1,
    complete: false,
  });
}

/**
 * Serialize one Linear activity and discard it if its lifecycle generation is
 * no longer current. A terminal response may opt into the completed generation.
 * @param agentSessionId - Linear Agent Session id
 * @param allowWhenComplete - whether this is the terminal completion response
 * @param emit - API operation to execute when the activity remains current
 */
export function enqueueAgentSessionActivity(
  agentSessionId: string,
  allowWhenComplete: boolean,
  emit: () => Promise<void>,
): Promise<void> {
  const expectedGeneration = lifecycleFor(agentSessionId).generation;
  const previous = activityQueues.get(agentSessionId) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      const lifecycle = lifecycleFor(agentSessionId);
      if (lifecycle.generation !== expectedGeneration) return;
      if (lifecycle.complete && !allowWhenComplete) return;
      await emit();
    });

  activityQueues.set(agentSessionId, current);
  void current.finally(() => {
    if (activityQueues.get(agentSessionId) === current) {
      activityQueues.delete(agentSessionId);
    }
  }).catch(() => {});
  return current;
}

/** Reset process-local lifecycle state for isolated tests. */
export function _resetAgentSessionLifecycleForTesting(): void {
  lifecycles.clear();
  activityQueues.clear();
}
