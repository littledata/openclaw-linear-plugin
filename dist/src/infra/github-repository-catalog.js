import { getGitHubAppTokenForRepositories, invalidateGitHubAppRoleTokens, } from "./github-app-auth.js";
const catalogs = new Map();
const DEFAULT_CACHE_MS = 5 * 60_000;
/** Clear cached installation repository lists (tests and explicit refreshes). */
export function clearGitHubRepositoryCatalogCache() {
    catalogs.clear();
}
/**
 * List repositories installed for one GitHub App role, following pagination.
 * @param role - coding or reviewer App identity
 * @param pluginConfig - OpenClaw plugin configuration
 * @param forceRefresh - bypass the short-lived catalog cache
 * @returns enabled repositories, sorted by name
 */
export async function listGitHubInstallationRepositories(role, pluginConfig, forceRefresh = false) {
    const apps = pluginConfig?.githubApps;
    const app = apps?.[role];
    const key = `${role}:${String(app?.appId ?? "")}:${String(app?.installationId ?? "")}`;
    const cached = catalogs.get(key);
    if (!forceRefresh && cached && cached.expiresAtMs > Date.now())
        return cached.repositories;
    const token = await getGitHubAppTokenForRepositories(role, [], pluginConfig);
    const repositories = [];
    for (let page = 1;; page += 1) {
        const response = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.repositories)) {
            if (response.status === 401)
                invalidateGitHubAppRoleTokens(role);
            throw new Error(`GitHub App ${role} repository catalog failed (${response.status}): ${payload.message ?? "invalid response"}`);
        }
        for (const repository of payload.repositories) {
            repositories.push({
                name: repository.name,
                fullName: repository.full_name,
                defaultBranch: repository.default_branch || "main",
                archived: Boolean(repository.archived),
                disabled: Boolean(repository.disabled),
            });
        }
        if (payload.repositories.length < 100)
            break;
    }
    const usable = repositories
        .filter((repository) => !repository.archived && !repository.disabled)
        .sort((a, b) => a.name.localeCompare(b.name));
    const cacheMs = Number(pluginConfig?.repositoryCatalogCacheSec ?? 300) * 1_000;
    catalogs.set(key, {
        expiresAtMs: Date.now() + (Number.isFinite(cacheMs) && cacheMs > 0 ? cacheMs : DEFAULT_CACHE_MS),
        repositories: usable,
    });
    return usable;
}
/**
 * Overlay the live coding-App repository catalog onto plugin configuration.
 * Existing per-repo metadata is retained, but no host checkout is required.
 * Falls back to the existing config when GitHub is temporarily unavailable.
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns config carrying the current installation repository map
 */
export async function hydrateGitHubRepositoryCatalog(pluginConfig) {
    if (pluginConfig?.repositorySource !== "github-app")
        return pluginConfig;
    try {
        const repositories = await listGitHubInstallationRepositories("coding", pluginConfig);
        const existing = (pluginConfig.repos ?? {});
        const repos = {};
        for (const repository of repositories) {
            const current = existing[repository.name];
            const currentObject = current && typeof current === "object" ? current : {};
            repos[repository.name] = {
                ...currentObject,
                github: repository.fullName,
                defaultBranch: repository.defaultBranch,
            };
        }
        const owners = [...new Set(repositories.map((repository) => repository.fullName.split("/")[0]))];
        return {
            ...pluginConfig,
            ...(owners.length === 1 ? { githubOwner: owners[0] } : {}),
            repos,
        };
    }
    catch {
        return pluginConfig;
    }
}
