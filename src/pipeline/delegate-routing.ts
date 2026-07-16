/** State-driven transfer between configured Linear agent app users. */

export interface DelegateRoutingConfig {
  enabled?: boolean;
  /** Logical owner represented by this OpenClaw profile. */
  selfOwner?: string;
  /** Logical owner to Linear app-user id. */
  owners?: Record<string, string>;
  /** Linear workflow-state name to logical owner. Matching is case-insensitive. */
  stateOwners?: Record<string, string>;
}

export interface DelegateRoutingIssue {
  id: string;
  identifier?: string;
  delegateId?: string | null;
  delegate?: { id?: string | null } | null;
  state?: { name?: string | null } | null;
}

export interface DelegateRoutingApi {
  getIssueDetails: (issueId: string) => Promise<DelegateRoutingIssue>;
  updateIssue: (issueId: string, input: { delegateId: string }) => Promise<unknown>;
}

export type DelegateRoutingResult =
  | { action: "disabled" | "ignored" | "unchanged" }
  | { action: "transferred"; fromOwner: string; toOwner: string; delegateId: string; state: string };

/** Read the routing block from plugin configuration. */
export function delegateRoutingConfig(cfg?: Record<string, unknown>): DelegateRoutingConfig {
  return (cfg?.delegateRouting as DelegateRoutingConfig | undefined) ?? {};
}

function lookupOwner(stateOwners: Record<string, string>, state: string): string | undefined {
  const wanted = state.trim().toLocaleLowerCase();
  return Object.entries(stateOwners).find(([name]) => name.trim().toLocaleLowerCase() === wanted)?.[1];
}

/**
 * Transfer a ticket from this profile to the configured owner for its current
 * workflow state. Only a ticket currently delegated to this profile is
 * eligible; unassigned, human-owned, and peer-owned tickets are untouched.
 * @param config - routing configuration shared by the cooperating profiles
 * @param issue - issue fields present in the webhook
 * @param linearApi - minimal Linear API surface used for enrichment and transfer
 * @returns the routing action taken
 */
export async function routeDelegateForState(
  config: DelegateRoutingConfig,
  issue: DelegateRoutingIssue,
  linearApi: DelegateRoutingApi,
): Promise<DelegateRoutingResult> {
  if (!config.enabled) return { action: "disabled" };
  const selfOwner = config.selfOwner?.trim();
  const owners = config.owners ?? {};
  const stateOwners = config.stateOwners ?? {};
  const selfDelegateId = selfOwner ? owners[selfOwner] : undefined;
  if (!selfOwner || !selfDelegateId || Object.keys(stateOwners).length === 0) {
    return { action: "ignored" };
  }

  let current = issue;
  let currentDelegateId = issue.delegateId ?? issue.delegate?.id ?? undefined;
  let state = issue.state?.name ?? undefined;
  if (!currentDelegateId || !state) {
    current = await linearApi.getIssueDetails(issue.id);
    currentDelegateId = current.delegateId ?? current.delegate?.id ?? undefined;
    state = current.state?.name ?? undefined;
  }

  if (currentDelegateId !== selfDelegateId || !state) return { action: "ignored" };
  const toOwner = lookupOwner(stateOwners, state);
  const targetDelegateId = toOwner ? owners[toOwner] : undefined;
  if (!toOwner || !targetDelegateId || targetDelegateId === currentDelegateId) {
    return { action: "unchanged" };
  }

  await linearApi.updateIssue(issue.id, { delegateId: targetDelegateId });
  return {
    action: "transferred",
    fromOwner: selfOwner,
    toOwner,
    delegateId: targetDelegateId,
    state,
  };
}
