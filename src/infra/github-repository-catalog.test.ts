import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tokenMock } = vi.hoisted(() => ({ tokenMock: vi.fn() }));

vi.mock("./github-app-auth.js", () => ({
  getGitHubAppTokenForRepositories: tokenMock,
  invalidateGitHubAppRoleTokens: vi.fn(),
}));

import {
  clearGitHubRepositoryCatalogCache,
  hydrateGitHubRepositoryCatalog,
  listGitHubInstallationRepositories,
} from "./github-repository-catalog.js";

describe("GitHub repository catalog", () => {
  beforeEach(() => {
    clearGitHubRepositoryCatalogCache();
    tokenMock.mockReset().mockResolvedValue("ghs_catalog");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists usable installation repositories and caches the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        repositories: [
          { name: "api", full_name: "littledata/api", default_branch: "main" },
          { name: "old", full_name: "littledata/old", default_branch: "master", archived: true },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = { githubApps: { coding: { appId: 1, installationId: 2 } } };

    await expect(listGitHubInstallationRepositories("coding", config)).resolves.toEqual([
      {
        name: "api",
        fullName: "littledata/api",
        defaultBranch: "main",
        archived: false,
        disabled: false,
      },
    ]);
    await listGitHubInstallationRepositories("coding", config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenMock).toHaveBeenCalledWith("coding", [], config);
  });

  it("hydrates the live catalog without requiring host paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        repositories: [
          { name: "tm2", full_name: "littledata/tm2", default_branch: "staging" },
        ],
      }),
    }));
    const hydrated = await hydrateGitHubRepositoryCatalog({
      repositorySource: "github-app",
      githubApps: { coding: { appId: 1, installationId: 2 } },
      repos: { tm2: { hostname: "github.com" } },
    });

    expect(hydrated).toMatchObject({
      githubOwner: "littledata",
      repos: {
        tm2: {
          hostname: "github.com",
          github: "littledata/tm2",
          defaultBranch: "staging",
        },
      },
    });
  });
});
