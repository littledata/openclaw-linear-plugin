import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubAppTokenCache,
  getGitHubAppToken,
  githubAppPermissions,
  githubAuthenticationEnvironment,
  parseGitHubRepositoryRemote,
  resolveGitHubAppConfig,
} from "./github-app-auth.js";

const tempDirs: string[] = [];

function privateKeyFile(mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-github-app-"));
  tempDirs.push(dir);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(path, mode);
  return path;
}

function config(privateKeyPath: string): Record<string, unknown> {
  return {
    githubApps: {
      coding: { appId: 101, installationId: 201, privateKeyPath },
      reviewer: { appId: "102", installationId: "202", privateKeyPath },
    },
  };
}

describe("GitHub App authentication", () => {
  beforeEach(() => {
    clearGitHubAppTokenCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves numeric and string identifiers from role config", () => {
    const keyPath = privateKeyFile();
    expect(resolveGitHubAppConfig("coding", config(keyPath))).toEqual({
      appId: 101,
      installationId: 201,
      privateKeyPath: keyPath,
    });
    expect(resolveGitHubAppConfig("reviewer", config(keyPath))).toEqual({
      appId: 102,
      installationId: 202,
      privateKeyPath: keyPath,
    });
  });

  it("uses separate least-privilege permission profiles", () => {
    expect(githubAppPermissions("coding")).toEqual({
      actions: "read",
      checks: "read",
      contents: "write",
      pull_requests: "write",
      statuses: "read",
    });
    expect(githubAppPermissions("reviewer")).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      pull_requests: "write",
      statuses: "read",
    });
  });

  it("creates a repository-scoped token and caches it before expiry", async () => {
    const keyPath = privateKeyFile();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_short_lived", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGitHubAppToken("coding", "littledata/transaction-monitor-2", config(keyPath)))
      .resolves.toBe("ghs_short_lived");
    await expect(getGitHubAppToken("coding", "littledata/transaction-monitor-2", config(keyPath)))
      .resolves.toBe("ghs_short_lived");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe("https://api.github.com/app/installations/201/access_tokens");
    expect(JSON.parse(request[1].body)).toEqual({
      repositories: ["transaction-monitor-2"],
      permissions: githubAppPermissions("coding"),
    });
    expect(request[1].headers.Authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
  });

  it("refuses private keys readable by group or other users", async () => {
    const keyPath = privateKeyFile(0o644);
    vi.stubGlobal("fetch", vi.fn());
    await expect(getGitHubAppToken("coding", "littledata/repo", config(keyPath)))
      .rejects.toThrow("permissions are too broad");
  });

  it("builds process-scoped gh and git credential environment", () => {
    const env = githubAuthenticationEnvironment("ghs_secret");
    expect(env.GH_TOKEN).toBe("ghs_secret");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$GH_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghs_secret");
  });

  it.each([
    ["https://github.com/littledata/transaction-monitor-2.git", "littledata/transaction-monitor-2"],
    ["git@github.com:littledata/openclaw-linear-plugin.git", "littledata/openclaw-linear-plugin"],
    ["ssh://git@github.com/littledata/ld-shopify", "littledata/ld-shopify"],
  ])("parses GitHub remote %s", (remote, expected) => {
    expect(parseGitHubRepositoryRemote(remote)).toBe(expected);
  });
});
