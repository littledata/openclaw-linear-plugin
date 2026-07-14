/**
 * Host-side GitHub App authentication for trusted repository operations.
 *
 * Private keys never enter worker containers. The gateway signs a short-lived
 * app JWT, exchanges it for an installation token restricted to one repository
 * and the role's minimum permissions, and injects that token only into the
 * trusted git/gh process that needs it.
 */
import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const tokenCache = new Map();
const pendingTokens = new Map();
const ROLE_PERMISSIONS = {
    coding: {
        actions: "read",
        checks: "read",
        contents: "write",
        pull_requests: "write",
        statuses: "read",
    },
    reviewer: {
        actions: "read",
        checks: "write",
        contents: "read",
        pull_requests: "write",
        statuses: "read",
    },
};
/** Environment consumed by both `gh` and git's ephemeral credential helper. */
export function githubAuthenticationEnvironment(token) {
    return {
        GH_TOKEN: token,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f',
    };
}
/** Minimum installation-token permissions for the requested automation role. */
export function githubAppPermissions(role) {
    return { ...ROLE_PERMISSIONS[role] };
}
/**
 * Read and validate one role's GitHub App configuration.
 * @param role - automation identity to resolve
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns normalized App and installation identifiers plus the PEM path
 */
export function resolveGitHubAppConfig(role, pluginConfig) {
    const githubApps = pluginConfig?.githubApps;
    const raw = githubApps?.[role];
    const appId = numericIdentifier(raw?.appId);
    const installationId = numericIdentifier(raw?.installationId);
    const privateKeyPath = typeof raw?.privateKeyPath === "string" ? expandHome(raw.privateKeyPath.trim()) : "";
    if (!appId || !installationId || !privateKeyPath) {
        throw new Error(`GitHub App role ${role} is not configured; expected githubApps.${role}.{appId, installationId, privateKeyPath}`);
    }
    return { appId, installationId, privateKeyPath };
}
/**
 * Mint or reuse a short-lived installation token scoped to exactly one repo.
 * @param role - coding or reviewer App identity
 * @param repository - canonical `owner/repo` GitHub repository name
 * @param pluginConfig - OpenClaw plugin configuration
 * @returns the opaque installation token
 */
export async function getGitHubAppToken(role, repository, pluginConfig) {
    const normalized = normalizeRepository(repository);
    const config = resolveGitHubAppConfig(role, pluginConfig);
    const cacheKey = `${role}:${config.appId}:${config.installationId}:${normalized.toLowerCase()}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > TOKEN_REFRESH_SKEW_MS)
        return cached.token;
    const pending = pendingTokens.get(cacheKey);
    if (pending)
        return (await pending).token;
    const request = createInstallationToken(role, normalized, config);
    pendingTokens.set(cacheKey, request);
    try {
        const created = await request;
        tokenCache.set(cacheKey, created);
        return created.token;
    }
    finally {
        pendingTokens.delete(cacheKey);
    }
}
/** Drop a cached role/repository token so the next call re-authenticates. */
export function invalidateGitHubAppToken(role, repository) {
    const suffix = `:${normalizeRepository(repository).toLowerCase()}`;
    for (const key of tokenCache.keys()) {
        if (key.startsWith(`${role}:`) && key.endsWith(suffix))
            tokenCache.delete(key);
    }
}
/** Clear all in-memory installation tokens (tests and controlled shutdown). */
export function clearGitHubAppTokenCache() {
    tokenCache.clear();
    pendingTokens.clear();
}
/**
 * Parse a GitHub HTTPS or SSH remote into its canonical `owner/repo` identity.
 * @param remote - git remote URL
 * @returns canonical repository identity
 */
export function parseGitHubRepositoryRemote(remote) {
    const trimmed = remote.trim();
    const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
    if (!match)
        throw new Error(`Unsupported GitHub remote: ${remote}`);
    return normalizeRepository(`${match[1]}/${match[2]}`);
}
async function createInstallationToken(role, repository, config) {
    const privateKey = readPrivateKey(config.privateKeyPath);
    const jwt = createAppJwt(config.appId, privateKey);
    const repositoryName = repository.split("/")[1];
    const response = await fetch(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
            repositories: [repositoryName],
            permissions: githubAppPermissions(role),
        }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.token || !payload.expires_at) {
        throw new Error(`GitHub App ${role} token request failed (${response.status}): ${payload.message ?? "invalid response"}`);
    }
    const expiresAtMs = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAtMs))
        throw new Error(`GitHub App ${role} token response had an invalid expiry`);
    return { token: payload.token, expiresAtMs };
}
function createAppJwt(appId, privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
        encodeJson({ alg: "RS256", typ: "JWT" }),
        encodeJson({ iat: now - 60, exp: now + 540, iss: appId }),
    ].join(".");
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}
function readPrivateKey(path) {
    const stat = statSync(path);
    if (!stat.isFile())
        throw new Error(`GitHub App private key is not a regular file at ${path}`);
    if ((stat.mode & 0o077) !== 0) {
        throw new Error(`GitHub App private key permissions are too broad at ${path}; require owner-only mode (0600 or stricter)`);
    }
    return readFileSync(path, "utf8");
}
function encodeJson(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function normalizeRepository(repository) {
    const normalized = repository.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
        throw new Error(`Invalid GitHub repository identity: ${repository}`);
    }
    return normalized;
}
function numericIdentifier(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function expandHome(path) {
    return path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}
