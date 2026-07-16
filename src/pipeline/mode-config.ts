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
 * capability out. (Sub-settings choose their own defaults — e.g. conversational
 * `commentReply` defaults OFF, since the session response already posts a comment.)
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
  /**
   * Opt back into DUAL output — post the final answer as a separate issue
   * comment in addition to the session `response` activity. Default OFF: a
   * `response` activity already auto-creates the threaded comment (per Linear's
   * agent best practices), so mirroring it manually duplicates the message.
   */
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
 * Whether to DUAL-post a conversational reply as a separate issue comment on top
 * of the AgentSession `response` activity. Default OFF: the response activity
 * already auto-creates the threaded comment, so a manual mirror duplicates it.
 * Opt in only when a profile genuinely needs a second copy.
 * @param cfg - plugin config
 * @returns true when the answer should also be mirrored to a manual comment
 */
export function conversationalCommentReply(cfg?: Record<string, unknown>): boolean {
  return conversationalConfig(cfg).commentReply === true;
}
