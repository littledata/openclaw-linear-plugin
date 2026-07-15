/**
 * mode-config.ts — per-profile capability gating.
 *
 * A single OpenClaw profile runs the Linear plugin for one Linear app. Two
 * capabilities are gated independently so the same plugin can serve either role:
 *
 *   - coding        : delegation/assignment → the specialist pipeline.
 *   - conversational: @mention → an agent session that replies (Slack-style).
 *
 * Typical split:
 *   - coding gateway (Vasile app)   → { coding.enabled: true,  conversational.enabled: false }
 *   - main gateway (LilAgent app)   → { coding.enabled: false, conversational.enabled: true  }
 *
 * Each block carries `enabled` plus room to grow its own settings. Both default
 * ON so existing single-app installs keep working until an operator opts a
 * capability out.
 */
/** Whether the coding pipeline is active on this profile. Default ON. */
export function codingEnabled(cfg) {
    return cfg?.coding?.enabled !== false;
}
/** Whether conversational @mention replies are active on this profile. Default ON. */
export function conversationalEnabled(cfg) {
    return cfg?.conversational?.enabled !== false;
}
/** The conversational settings block (never null). */
export function conversationalConfig(cfg) {
    return cfg?.conversational ?? {};
}
/**
 * Whether a conversational reply should also be posted as an issue comment in
 * addition to the AgentSession response. Default ON so the answer is visible
 * both in the session and inline on the issue.
 * @param cfg - plugin config
 * @returns true when the answer should be mirrored to a comment
 */
export function conversationalCommentReply(cfg) {
    return conversationalConfig(cfg).commentReply !== false;
}
