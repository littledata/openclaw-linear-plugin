/**
 * workspace-prompt.ts — the shared environment briefing every provisioned agent
 * receives, on top of its own tonone skill/persona and the ticket task.
 *
 * The plugin owns the ENVIRONMENT contract (how the per-ticket container works,
 * how repos are selected/cloned, the container_* tool catalog, Linear etiquette)
 * so it stays identical across agents and is defined in one place. The agent's
 * behaviour comes from its skills; the ticket comes from the task; this is the
 * "where you are and how you operate" layer in between.
 *
 * It is KIND-AWARE:
 *  - plan-implement → how to edit/commit/verify in the container.
 *  - review / qa    → read-only, PLUS how to PUBLISH the review itself (like a
 *                     human) using the reviewer GitHub App token available in
 *                     the container — agent-driven, not orchestrator-extracted.
 */
/** The container_* tool catalog, shared by every agent. */
const CONTAINER_TOOLS = [
    "- container_exec — run any shell command (build, test, run the app, git, gh, install deps)",
    "- container_write_file / container_read_file — write/read a file",
    "- container_apply_patch — apply a unified diff in a repo",
    "- container_status — git status of the repos",
    "- container_clone_repo — clone another repo into the workspace for cross-repo work",
    '- container_search_code — AST semantic code search; locate code by concept ("where is X handled?") — better than grep for discovery',
];
/** Repo list block, or a single-line note when none are known yet. */
function reposBlock(repos) {
    if (!repos?.length)
        return "The ticket's repositories are cloned in your container workspace.";
    return ["These repositories are already cloned and WRITABLE in your container:", ...repos.map((r) => `- ${r.name}: ${r.workdir}`)].join("\n");
}
/** Publication instructions for a reviewer, by style. */
function reviewPublicationBlock(opts) {
    const prs = opts.pullRequests?.length
        ? opts.pullRequests.map((p) => `- ${p.repoName}: ${p.url}`).join("\n")
        : "the linked pull request";
    const lines = [
        "## Publishing your review",
        "You have the reviewer GitHub App token in this container (`gh` is authenticated). Publish your review",
        "yourself, like a human reviewer — do not just describe findings. Target the linked PR head that is",
        "already checked out here:",
        prs,
    ];
    if (opts.reviewStyle === "approve") {
        lines.push("Leave INLINE comments on the specific lines that matter, then submit an explicit verdict:", "1. Post line-level comments + the review in one call:", '   container_exec: gh api repos/<owner>/<repo>/pulls/<number>/reviews -f event=<APPROVE|REQUEST_CHANGES> \\', '     -f body="<summary>" -F "comments[][path]=<file>" -F "comments[][line]=<line>" -F "comments[][body]=<note>"', "   (repeat the comments[][...] triples per inline note; line = line number on the PR's new side).", "2. APPROVE when the change is correct and well-designed; REQUEST_CHANGES when it needs work.", "If inline line mapping fails, fall back to a review with just body + event.");
    }
    else {
        lines.push("Post your findings as a review COMMENT — do NOT approve:", '- Findings / non-blocking notes: container_exec: gh pr review <pr-url> --comment --body "<findings>"', '- A blocking problem: container_exec: gh pr review <pr-url> --request-changes --body "<why>"', "Never run `gh pr review --approve` — approval is not your call.");
    }
    lines.push("Do NOT edit, commit, or push code, and do NOT open/merge PRs — you are reviewing only.");
    return lines.join("\n");
}
/**
 * Build the shared workspace/environment system-prompt fragment for an agent.
 * @param opts - identifier, repos, kind, and reviewer publication style
 * @returns the environment briefing to prepend to the agent's system prompt
 */
export function buildWorkspacePrompt(opts) {
    const lines = [
        `## Your workspace (Linear ${opts.identifier})`,
        "You operate a DEDICATED per-ticket Docker container — your private, write-isolated sandbox.",
        "Your host filesystem is READ-ONLY: the ONLY way to read or change files, run commands, run the app,",
        "or run tests is through the container_* tools:",
        ...CONTAINER_TOOLS,
        "",
        reposBlock(opts.repos),
        "The ticket's repository(ies) were selected during dispatch; work within them and use container_clone_repo",
        "only when the task genuinely spans another repo.",
        "",
        "## Ticket & history",
        "You have Linear access: read the issue and its comments/activity for context and past decisions, and post a",
        "comment if useful. You must NEVER change the ticket's workflow state, status, or cycle — the pipeline owns",
        "all transitions. Start discovery with ONE bounded container_exec that batches git status/log, targeted rg,",
        "and small sed excerpts (keep output under ~20k chars); use container_search_code to orient when you don't",
        "know exact names. Do not fetch repository files through GitHub search/fetch tools — the container is authoritative.",
    ];
    if (opts.kind === "plan-implement") {
        lines.push("", "## Implementing", "Implement the change fully, then VERIFY by running the project's build/tests in the container. Commit in each", "changed repo with a structured message (summary + Changelog + Validation). Do NOT push, open a PR, or start", "another reviewer — the orchestrator owns push, PR creation, and review after you return control.");
    }
    else {
        // review / qa
        lines.push("", "## Reviewing", "You are REVIEWING — read and analyse only; change nothing in the code. The linked PR head is freshly checked", "out in your container. Prefer container_search_code to orient, then container_exec (git diff / rg / sed) to read", "the exact lines.", "", reviewPublicationBlock(opts));
        if (opts.verdictTag) {
            lines.push("", `End your response with EXACTLY one verdict line so the pipeline can gate:`, `\`${opts.verdictTag}: pass\`  or  \`${opts.verdictTag}: fail — <one-line reason>\``);
        }
    }
    return lines.join("\n");
}
