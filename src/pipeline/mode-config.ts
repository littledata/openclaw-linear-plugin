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

/** Coding pipeline settings (delegation/assignment → specialist agents). */
export interface CodingModeConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

/** Conversational settings (@mention → session reply). Extend over time. */
export interface ConversationalModeConfig {
  enabled?: boolean;
  /** Agent id that answers @mentions; falls back to the plugin default agent. */
  agentId?: string;
  /** Also post the final answer as an issue comment, not only a session response. */
  commentReply?: boolean;
  [key: string]: unknown;
}

/** Whether the coding pipeline is active on this profile. Default ON. */
export function codingEnabled(cfg?: Record<string, unknown>): boolean {
  return (cfg?.coding as CodingModeConfig | undefined)?.enabled !== false;
}

/** Whether conversational @mention replies are active on this profile. Default ON. */
export function conversationalEnabled(cfg?: Record<string, unknown>): boolean {
  return (cfg?.conversational as ConversationalModeConfig | undefined)?.enabled !== false;
}

/** The conversational settings block (never null). */
export function conversationalConfig(cfg?: Record<string, unknown>): ConversationalModeConfig {
  return (cfg?.conversational as ConversationalModeConfig | undefined) ?? {};
}

/**
 * Whether a conversational reply should also be posted as an issue comment in
 * addition to the AgentSession response. Default ON so the answer is visible
 * both in the session and inline on the issue.
 * @param cfg - plugin config
 * @returns true when the answer should be mirrored to a comment
 */
export function conversationalCommentReply(cfg?: Record<string, unknown>): boolean {
  return conversationalConfig(cfg).commentReply !== false;
}
