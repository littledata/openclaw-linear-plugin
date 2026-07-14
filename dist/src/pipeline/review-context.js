/**
 * Resolve the GitHub pull requests that a review-only Linear state should inspect.
 * PRs may be linked directly to the issue as attachments or associated with a
 * previous agent session. Repository selection is derived from the PR URL, so a
 * review never asks the user to pick from unrelated configured repositories.
 */
import { getRepoEntries } from "../infra/multi-repo.js";
/** Parse a canonical GitHub pull-request URL. */
export function parseGitHubPullRequestUrl(url) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
    if (!match)
        return null;
    return {
        url: url.trim(),
        repository: `${match[1]}/${match[2].replace(/\.git$/i, "")}`,
        number: Number(match[3]),
    };
}
/**
 * Collect distinct GitHub PRs from issue attachments, prior agent sessions, and
 * recent comment bodies. Comments are a fallback for manually pasted PR links.
 */
export function collectReviewPullRequests(attachments = [], sessions = [], comments = []) {
    const candidates = [
        ...attachments,
        ...sessions.flatMap((session) => session.pullRequests ?? []),
    ];
    for (const comment of comments) {
        const urls = String(comment.body ?? "").match(/https:\/\/github\.com\/[^\s)\]>]+\/pull\/\d+(?:[^\s)\]>]*)?/gi) ?? [];
        candidates.push(...urls.map((url) => ({ url })));
    }
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
        if (!candidate.url)
            continue;
        const parsed = parseGitHubPullRequestUrl(candidate.url);
        const key = parsed ? `${parsed.repository.toLowerCase()}#${parsed.number}` : "";
        if (!parsed || seen.has(key))
            continue;
        seen.add(key);
        result.push({ ...parsed, title: candidate.title ?? null });
    }
    return result;
}
/**
 * Match each PR's `owner/repo` identity to the configured repository map.
 * Falls back to an exact configured key matching the GitHub repository basename
 * for backwards-compatible configs that do not yet specify `github`.
 */
export function resolveReviewTargets(pullRequests, pluginConfig) {
    const entries = getRepoEntries(pluginConfig);
    const byGithub = new Map();
    for (const [name, entry] of Object.entries(entries)) {
        if (entry.github)
            byGithub.set(normalizeRepository(entry.github), name);
    }
    const targets = [];
    const unmatched = [];
    for (const pullRequest of pullRequests) {
        const basename = pullRequest.repository.split("/").at(-1) ?? "";
        const repoName = byGithub.get(normalizeRepository(pullRequest.repository)) ??
            Object.keys(entries).find((name) => name.toLowerCase() === basename.toLowerCase());
        if (repoName)
            targets.push({ ...pullRequest, repoName });
        else
            unmatched.push(pullRequest);
    }
    return { targets, unmatched };
}
function normalizeRepository(value) {
    return value
        .trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
}
