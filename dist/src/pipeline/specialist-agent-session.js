const byLinearSession = new Map();
const byRuntimeIdentity = new Map();
const pendingByIssue = new Map();
const creationChains = new Map();
function childPlan(record, state) {
    const terminal = state !== "running";
    const terminalStatus = state === "complete" ? "completed" : "canceled";
    const work = record.steps.length ? record.steps : [record.task];
    return [
        { content: "Understand the delegated assignment", status: "completed" },
        ...work.map((content, index) => ({
            content,
            status: terminal ? terminalStatus : index === 0 ? "inProgress" : "pending",
        })),
        {
            content: "Validate the result and report back to Apex",
            status: terminal ? terminalStatus : "pending",
        },
    ];
}
/**
 * Create a Linear AgentSession for a spawned specialist and seed its own plan.
 * The pending marker is installed before the mutation so the resulting
 * `created` webhook cannot accidentally start another Apex pipeline.
 * @param api - authenticated Linear API
 * @param input - parent issue/session and specialist assignment metadata
 * @returns the child session record, or null when Linear rejected creation
 */
export async function createSpecialistAgentSession(api, input) {
    const previous = creationChains.get(input.issueId) ?? Promise.resolve();
    let release;
    const ownTurn = new Promise((resolve) => { release = resolve; });
    const chain = previous.catch(() => { }).then(() => ownTurn);
    creationChains.set(input.issueId, chain);
    await previous.catch(() => { });
    try {
        const pending = {
            ...input,
            nonce: `${Date.now()}-${Math.random()}`,
        };
        pendingByIssue.set(input.issueId, [
            ...(pendingByIssue.get(input.issueId) ?? []),
            pending,
        ]);
        const created = await api.createSessionOnIssue(input.issueId);
        if (!created.sessionId) {
            removePending(pending);
            return null;
        }
        const existing = byLinearSession.get(created.sessionId);
        const record = existing ?? {
            ...input,
            agentSessionId: created.sessionId,
            agentSessionUrl: created.url,
            active: true,
        };
        if (created.url)
            record.agentSessionUrl = created.url;
        byLinearSession.set(record.agentSessionId, record);
        byRuntimeIdentity.set(input.childSessionKey, record);
        removePending(pending);
        await api.emitActivity(record.agentSessionId, {
            type: "thought",
            body: `${record.agentLabel} started this delegated task from Apex:\n\n${record.task}`,
        }).catch(() => { });
        await api.updateSession(record.agentSessionId, {
            plan: childPlan(record, "running"),
        }).catch(() => { });
        return record;
    }
    finally {
        release();
        if (creationChains.get(input.issueId) === chain)
            creationChains.delete(input.issueId);
    }
}
/**
 * Claim a proactively-created specialist session webhook. Returns null for a
 * normal user-created/delegated Apex session.
 * @param issueId - Linear issue id
 * @param agentSessionId - newly-created Linear AgentSession id
 * @returns the specialist record when this creation belongs to a child
 */
export function claimSpecialistAgentSession(issueId, agentSessionId) {
    const known = byLinearSession.get(agentSessionId);
    if (known)
        return known;
    const pending = pendingByIssue.get(issueId)?.[0];
    if (!pending)
        return null;
    const { nonce: _nonce, ...input } = pending;
    const record = {
        ...input,
        agentSessionId,
        active: true,
    };
    byLinearSession.set(agentSessionId, record);
    byRuntimeIdentity.set(record.childSessionKey, record);
    removePending(pending);
    return record;
}
/** Bind another OpenClaw identity (such as run id) to a child session. */
export function bindSpecialistRuntimeIdentity(identity, record) {
    if (identity)
        byRuntimeIdentity.set(identity, record);
}
/** Look up a specialist session from its Linear session id. */
export function getSpecialistByLinearSession(agentSessionId) {
    return byLinearSession.get(agentSessionId) ?? null;
}
/** Look up a specialist session from an OpenClaw child session/run identity. */
export function getSpecialistByRuntimeIdentity(identity) {
    return identity ? byRuntimeIdentity.get(identity) ?? null : null;
}
/**
 * Complete the specialist's own plan/session and keep the record for history
 * and late prompted-webhook classification.
 * @param api - authenticated Linear API
 * @param record - child session record
 * @param success - whether the specialist completed normally
 */
export async function completeSpecialistAgentSession(api, record, success) {
    record.active = false;
    await api.updateSession(record.agentSessionId, {
        plan: childPlan(record, success ? "complete" : "canceled"),
    }).catch(() => { });
    await api.completeSession(record.agentSessionId, success
        ? `Finished the delegated ${record.agentLabel} task and returned the result to Apex.`
        : `${record.agentLabel} stopped before completing the delegated task.`).catch(() => { });
}
function removePending(target) {
    const pending = (pendingByIssue.get(target.issueId) ?? []).filter((candidate) => candidate.nonce !== target.nonce);
    if (pending.length)
        pendingByIssue.set(target.issueId, pending);
    else
        pendingByIssue.delete(target.issueId);
}
