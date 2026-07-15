/**
 * agent-roster.ts — the out-of-the-box tonone agent stack the plugin provisions.
 *
 * The plugin ships the tonone agents (github.com/tonone-ai/tonone) as its base
 * but is CONFIGURABLE: the operator picks which agents to create via
 * `provisionAgents` (the full 23-agent stack is a lot). Each roster entry binds
 * a plugin agent id to a tonone source agent, the subset of that agent's skills
 * to install, the pipeline `kind` it plays, and — for the coding lead — the
 * subagent ids it may delegate to in-session (`sessions_spawn`).
 *
 * This module is PURE (no I/O): the source fetch (tonone-source.ts), skill
 * install (install-skills.ts), and config registration (register-agents.ts)
 * consume the resolved roster.
 */

/** The pipeline role a provisioned agent plays (drives GitHub key + tool policy). */
export type ProvisionKind = "plan-implement" | "review" | "qa";

/** How a reviewer publishes its verdict on the PR. */
export type ReviewStyle = "comment" | "approve";

export interface RosterAgent {
  /** Plugin/OpenClaw agent id (also the Linear session-key prefix). */
  id: string;
  /** Display name for `agents.list[].name` + Linear activity. */
  label: string;
  /** Source agent directory in the tonone repo (`team/<tononeAgent>/`). */
  tononeAgent: string;
  /** tonone skill names to install + bind (subset of the agent's skills). */
  skills: string[];
  /** Pipeline kind. */
  kind: ProvisionKind;
  /**
   * Agent ids this agent may spawn as in-session subagents. Only meaningful for
   * the coding lead (Apex) and the reviewer lead (Apex Reviewer).
   */
  subagents?: string[];
  /** Reviewer publication style (review/qa kinds only). */
  reviewStyle?: ReviewStyle;
  /** Reviewer leaves inline line-level comments (Apex Reviewer). */
  inlineComments?: boolean;
  /** One-line persona summary (fallback when the tonone persona is unavailable). */
  summary: string;
}

/** The implementer subagent ids Apex delegates to. */
const IMPLEMENTERS = ["spine", "relay", "flux", "prism", "forge"];

/** The review subagent ids Apex Reviewer delegates review facets to. */
const REVIEWERS = ["spine", "warden", "proof", "forge", "prism"];

/**
 * The default provisioned roster. `provisionAgents` selects a subset by id;
 * when unset, the full default roster is provisioned.
 */
export const DEFAULT_ROSTER: RosterAgent[] = [
  {
    id: "apex",
    label: "Apex",
    tononeAgent: "apex",
    skills: ["apex-plan", "apex-review", "apex-recon"],
    kind: "plan-implement",
    subagents: IMPLEMENTERS,
    summary: "the engineering lead — scopes the work, delegates to specialist subagents, and reviews the result.",
  },
  {
    id: "apex-reviewer",
    label: "Apex Reviewer",
    tononeAgent: "apex",
    skills: ["apex-review", "apex-recon"],
    kind: "review",
    subagents: REVIEWERS,
    reviewStyle: "approve",
    inlineComments: true,
    summary: "the lead code reviewer — reviews correctness, design, and conventions, delegating facets to specialist reviewers.",
  },
  {
    id: "spine",
    label: "Spine",
    tononeAgent: "spine",
    skills: ["spine-api", "spine-service", "spine-design", "spine-perf", "spine-review"],
    kind: "plan-implement",
    summary: "the backend specialist — APIs, services, system design, performance.",
  },
  {
    id: "relay",
    label: "Relay",
    tononeAgent: "relay",
    skills: ["relay-pipeline", "relay-docker", "relay-deploy", "relay-ship"],
    kind: "plan-implement",
    summary: "the CI/CD & deployment specialist — pipelines, containers, release strategy.",
  },
  {
    id: "flux",
    label: "Flux",
    tononeAgent: "flux",
    skills: ["flux-schema", "flux-migrate", "flux-pipeline", "flux-query"],
    kind: "plan-implement",
    summary: "the data specialist — schemas, migrations, pipelines, query optimization.",
  },
  {
    id: "prism",
    label: "Prism",
    tononeAgent: "prism",
    skills: ["prism-ui", "prism-component", "prism-dashboard", "prism-stack"],
    kind: "plan-implement",
    summary: "the frontend specialist — UI, components, dashboards, client state.",
  },
  {
    id: "forge",
    label: "Forge",
    tononeAgent: "forge",
    skills: ["forge-infra", "forge-network", "forge-audit", "forge-diagnose"],
    kind: "plan-implement",
    summary: "the infrastructure specialist — IaC, networking, cloud, cost.",
  },
  {
    id: "warden",
    label: "Warden",
    tononeAgent: "warden",
    skills: ["warden-audit", "warden-scan", "warden-threat", "warden-harden"],
    kind: "review",
    reviewStyle: "comment",
    summary: "the security reviewer — authz/authn, secrets, injection, supply-chain risk.",
  },
  {
    id: "proof",
    label: "Proof",
    tononeAgent: "proof",
    skills: ["proof-strategy", "proof-e2e", "proof-api", "proof-audit"],
    kind: "qa",
    reviewStyle: "comment",
    summary: "the QA specialist — test strategy, E2E/API tests, coverage and flake audits.",
  },
];

/** Default provisioned ids (all of DEFAULT_ROSTER). */
export const DEFAULT_PROVISION_IDS = DEFAULT_ROSTER.map((a) => a.id);

/**
 * Resolve the roster to provision from plugin config.
 *
 * `provisionAgents` (string[]) selects which default-roster ids to create; when
 * absent, the whole default roster is used. `agentOverrides[<id>]` may patch a
 * roster entry's `skills`, `subagents`, `label`, or `summary` (shallow merge).
 * Unknown ids in `provisionAgents` are ignored (logged by the caller).
 * @param pluginConfig - the plugin config object
 * @returns the resolved roster entries to provision, in default order
 */
export function resolveRoster(pluginConfig?: Record<string, unknown>): RosterAgent[] {
  const selected = pluginConfig?.provisionAgents;
  const ids =
    Array.isArray(selected) && selected.length
      ? selected.filter((x): x is string => typeof x === "string")
      : DEFAULT_PROVISION_IDS;
  const idSet = new Set(ids.map((s) => s.toLowerCase()));
  const overrides = (pluginConfig?.agentOverrides as Record<string, Partial<RosterAgent>>) ?? {};

  return DEFAULT_ROSTER.filter((a) => idSet.has(a.id.toLowerCase())).map((a) => {
    const o = overrides[a.id];
    if (!o) return a;
    return {
      ...a,
      ...(typeof o.label === "string" ? { label: o.label } : {}),
      ...(typeof o.summary === "string" ? { summary: o.summary } : {}),
      ...(Array.isArray(o.skills) ? { skills: o.skills } : {}),
      ...(Array.isArray(o.subagents) ? { subagents: o.subagents } : {}),
    };
  });
}

/**
 * Ids of the unique tonone source agents needed for a roster (for fetch/install
 * — several roster entries may share one tonone agent, e.g. apex + apex-reviewer).
 * @param roster - the resolved roster
 * @returns unique tonone agent directory names
 */
export function tononeAgentsForRoster(roster: RosterAgent[]): string[] {
  return [...new Set(roster.map((a) => a.tononeAgent))];
}
