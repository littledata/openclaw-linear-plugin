/**
 * roles.ts — the specialist-agent registry for the state-driven orchestrator.
 *
 * Each role binds an OpenClaw skill (deployed under the workspace skills root)
 * to an execution backend and a tool policy:
 *
 *  - IMPLEMENT roles (Spine/Prism/Flux/Forge) delegate to `codex exec`, which
 *    writes/edits/tests in its own --full-auto sandbox inside the worktree
 *    (past OpenClaw's default-deny exec gate). They never edit files directly.
 *  - REVIEW roles (Apex-review/Warden/Proof) run the embedded agent READ-ONLY
 *    (all write tools denied) and end with a single machine-parseable verdict
 *    line so the orchestrator can gate.
 *  - PLAN role (Apex) runs embedded read-only and emits a routing plan naming
 *    which implementers to invoke and what each should build.
 *  - PRODUCT roles (Helm/Lumen) run embedded read-only and emit a written
 *    brief / analysis — no code.
 *
 * The detailed behaviour of each role lives in its SKILL.md (deployed in Stage
 * 1). This module only wires WHO the agent is, WHICH skill to follow, HOW it
 * executes, and — for reviewers — the verdict tag to emit.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * The nine specialist roles. `id` doubles as the OpenClaw agent id — an entry
 * with the same id in `config.agents.list` supplies a per-role model override;
 * otherwise the run uses `agents.defaults.model`.
 */
export const ROLES = {
    apex: {
        id: "apex",
        label: "Apex",
        skill: "apex-lead",
        backend: "embedded",
        readOnly: true,
        kind: "plan",
        verdictTag: "REVIEW",
        summary: "the engineering lead — you scope the work, decide which implementers own which concerns, and review the result before it moves on.",
    },
    spine: {
        id: "spine",
        label: "Spine",
        skill: "spine-backend",
        backend: "codex",
        readOnly: false,
        kind: "implement",
        summary: "the backend specialist — APIs, services, business logic, data access.",
    },
    prism: {
        id: "prism",
        label: "Prism",
        skill: "prism-frontend",
        backend: "codex",
        readOnly: false,
        kind: "implement",
        summary: "the frontend specialist — UI components, client-side state, styling, DX.",
    },
    flux: {
        id: "flux",
        label: "Flux",
        skill: "flux-data",
        backend: "codex",
        readOnly: false,
        kind: "implement",
        summary: "the data-pipeline specialist — ETL/ELT, event/data schemas, migrations, warehousing.",
    },
    forge: {
        id: "forge",
        label: "Forge",
        skill: "forge-infra",
        backend: "codex",
        readOnly: false,
        kind: "implement",
        summary: "the infrastructure specialist — IaC, serverless/deploy config, networking, CI/CD.",
    },
    warden: {
        id: "warden",
        label: "Warden",
        skill: "warden-security",
        backend: "embedded",
        readOnly: true,
        kind: "review",
        verdictTag: "SECURITY",
        summary: "the security reviewer — you audit the change for authz, secrets, injection, and supply-chain risk.",
    },
    proof: {
        id: "proof",
        label: "Proof",
        skill: "proof-qa",
        backend: "embedded",
        readOnly: true,
        kind: "review",
        verdictTag: "QA",
        summary: "the QA specialist — you verify the change against its acceptance criteria and run the tests.",
    },
    helm: {
        id: "helm",
        label: "Helm",
        skill: "helm-product",
        backend: "embedded",
        readOnly: true,
        kind: "product",
        summary: "the product strategist — you turn a raw feature idea into a crisp product brief.",
    },
    lumen: {
        id: "lumen",
        label: "Lumen",
        skill: "lumen-analytics",
        backend: "embedded",
        readOnly: true,
        kind: "product",
        summary: "the product analyst — metrics, funnels, retention, and measurement plans.",
    },
};
/** All role ids, in a stable order. */
export const ROLE_IDS = Object.keys(ROLES);
/**
 * Resolve a role definition by id (case-insensitive).
 * @param id - the role id (e.g. "spine")
 * @returns the role definition, or undefined if unknown
 */
export function resolveRole(id) {
    return ROLES[id?.toLowerCase?.()];
}
/**
 * The implementer roles Apex may route work to.
 * @returns the implement-kind role definitions
 */
export function implementerRoles() {
    return ROLE_IDS.map((id) => ROLES[id]).filter((r) => r.kind === "implement");
}
/**
 * Per-role model override from plugin config (`roleModels[<id>]`), falling back
 * to undefined (which lets the runtime use `agents.defaults.model`).
 * @param role - the role definition
 * @param pluginConfig - the plugin config object
 * @returns a "provider/model" string, or undefined
 */
export function resolveRoleModel(role, pluginConfig) {
    const map = pluginConfig?.roleModels;
    const v = map?.[role.id];
    return typeof v === "string" && v ? v : undefined;
}
/**
 * Per-role backend override from plugin config (`roleBackends[<id>]`), falling
 * back to the role's declared default backend.
 * @param role - the role definition
 * @param pluginConfig - the plugin config object
 * @returns the effective backend for this role
 */
export function resolveRoleBackend(role, pluginConfig) {
    const map = pluginConfig?.roleBackends;
    const v = map?.[role.id];
    return v === "codex" || v === "embedded" ? v : role.backend;
}
// ---------------------------------------------------------------------------
// Skill-body loader (for codex-backed roles, which have no native skill system)
// ---------------------------------------------------------------------------
/**
 * Default directory holding the deployed role SKILL.md files, one subdir per
 * role id (matches Stage-1 deploy: `<workspace>/skills/littledata/<role>/`).
 */
function defaultSkillsDir() {
    return join(homedir(), ".openclaw", "workspace-coding", "skills", "littledata");
}
/**
 * Load a role's SKILL.md body (frontmatter stripped) so it can be inlined into
 * a codex prompt — codex has no OpenClaw skill system, so the embedded runner's
 * native skill injection doesn't reach it. Returns null when the file is
 * missing (caller falls back to the one-line role summary).
 * @param role - the role definition
 * @param pluginConfig - the plugin config (reads optional `skillsDir` override)
 * @returns the skill body text, or null if unavailable
 */
export function loadSkillGuidance(role, pluginConfig) {
    const dir = pluginConfig?.skillsDir || defaultSkillsDir();
    try {
        const raw = readFileSync(join(dir, role.id, "SKILL.md"), "utf8");
        // Strip a leading YAML frontmatter block (--- ... ---).
        const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
        return body || null;
    }
    catch {
        return null;
    }
}
/**
 * Build the extra system prompt that binds a role + its skill to a run. Kept
 * lean — the behavioural detail lives in the role's SKILL.md, which OpenClaw
 * injects when the agent uses the skill.
 * @param role - the role definition
 * @param opts - invocation context (identifier, phase, extra instructions)
 * @returns the system-prompt fragment to pass as `extraSystemPrompt`
 */
export function buildRolePrompt(role, opts) {
    const lines = [
        `You are ${role.label}, ${role.summary}`,
        `Use the \`${role.skill}\` skill and follow it strictly.`,
        `You are working on Linear issue ${opts.identifier}.`,
    ];
    if (opts.phase === "implement") {
        lines.push("Implement ONLY the work assigned to you below, in the worktree provided.", "Read CLAUDE.md / AGENTS.md first, follow project conventions, run the tests,", "and commit your work with a clear message. Return a concise summary of what", "you changed and the test results. Do NOT touch the Linear issue.");
    }
    else if (opts.phase === "review") {
        lines.push("You are REVIEWING, not implementing — read and analyse only, change nothing.", role.verdictTag
            ? `End your response with EXACTLY one verdict line:\n\`${role.verdictTag}: pass\`  or  \`${role.verdictTag}: fail — <one-line reason>\``
            : "");
    }
    else if (opts.phase === "plan") {
        lines.push("Produce an implementation plan. Read the issue and the codebase, then decide", "which implementer specialists own which concerns and what each must build.");
    }
    else if (opts.phase === "product") {
        lines.push("Produce your written deliverable only — do not write code.");
    }
    if (opts.extra)
        lines.push("", opts.extra);
    return lines.filter(Boolean).join("\n");
}
/**
 * Parse a reviewer's `TAG: pass|fail — reason` verdict line from its output.
 * Scans from the end so the final verdict wins. Defaults to FAIL when no line
 * is found — a review that produced no verdict must not silently pass a gate.
 * @param output - the reviewer's raw output
 * @param tag - the verdict tag to look for (e.g. "SECURITY")
 * @returns the parsed verdict (pass=false when absent/unparseable)
 */
export function parseReviewVerdict(output, tag) {
    const re = new RegExp(`${tag}\\s*:\\s*(pass|fail)\\b[^\\n]*`, "gi");
    const matches = output.match(re);
    if (!matches?.length) {
        return { pass: false, reason: `no ${tag} verdict line found in review output` };
    }
    const last = matches[matches.length - 1];
    const pass = /:\s*pass\b/i.test(last);
    // Reason = text after an em-dash / hyphen separator, if present.
    const reasonMatch = last.match(/(?:—|-{1,2})\s*(.+)$/);
    const reason = reasonMatch ? reasonMatch[1].trim() : (pass ? "passed" : "failed");
    return { pass, reason };
}
