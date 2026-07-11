import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import path from "node:path";
import { resolveRepos, isMultiRepo, validateRepoPath, getRepoEntries, buildCandidateRepositories, detectMentionedRepos, type RepoResolution } from "./multi-repo.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { existsSync, statSync } from "node:fs";
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;

describe("resolveRepos", () => {
  it("parses <!-- repos: api, frontend --> from description", () => {
    const result = resolveRepos(
      "Fix the bug\n<!-- repos: api, frontend -->",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("parses [repos: web, worker] from description", () => {
    const result = resolveRepos(
      "Some issue\n[repos: web, worker]",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("web");
    expect(result.repos[1].name).toBe("worker");
  });

  it("extracts from repo:api and repo:frontend labels", () => {
    const result = resolveRepos("No markers here", ["repo:api", "repo:frontend"]);
    expect(result.source).toBe("labels");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("falls back to config repos when no markers/labels", () => {
    const config = { codexBaseRepo: "/tmp/test/myproject" };
    const result = resolveRepos("Plain description", [], config);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
    expect(result.repos[0].path).toBe("/tmp/test/myproject");
  });

  it("body markers take priority over labels", () => {
    const result = resolveRepos(
      "<!-- repos: api -->",
      ["repo:frontend"],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("api");
  });

  it("returns single repo from codexBaseRepo when no repos config", () => {
    const result = resolveRepos("Nothing special", []);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
    expect(result.repos[0].path).toBe(path.join(homedir(), "ai-workspace"));
  });

  it("handles empty description + no labels (single repo fallback)", () => {
    const result = resolveRepos("", []);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
  });

  it("trims whitespace in repo names from markers", () => {
    const result = resolveRepos(
      "<!-- repos:  api ,  frontend  -->",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("handles null/undefined description", () => {
    const resultNull = resolveRepos(null, []);
    expect(resultNull.source).toBe("config_default");
    expect(resultNull.repos).toHaveLength(1);

    const resultUndefined = resolveRepos(undefined, []);
    expect(resultUndefined.source).toBe("config_default");
    expect(resultUndefined.repos).toHaveLength(1);
  });
});

describe("isMultiRepo", () => {
  it("returns true for 2+ repos", () => {
    const resolution: RepoResolution = {
      repos: [
        { name: "api", path: "/tmp/test/api" },
        { name: "frontend", path: "/tmp/test/frontend" },
      ],
      source: "issue_body",
    };
    expect(isMultiRepo(resolution)).toBe(true);
  });

  it("returns false for 1 repo", () => {
    const resolution: RepoResolution = {
      repos: [{ name: "default", path: "/tmp/test/ai-workspace" }],
      source: "config_default",
    };
    expect(isMultiRepo(resolution)).toBe(false);
  });

  it("returns false for empty result", () => {
    const resolution: RepoResolution = {
      repos: [],
      source: "config_default",
    };
    expect(isMultiRepo(resolution)).toBe(false);
  });
});

describe("getRepoEntries", () => {
  it("normalizes string values to RepoEntry objects", () => {
    const config = { repos: { api: "/tmp/api", frontend: "/tmp/frontend" } };
    const entries = getRepoEntries(config);
    expect(entries.api).toEqual({ path: "/tmp/api" });
    expect(entries.frontend).toEqual({ path: "/tmp/frontend" });
  });

  it("passes through object values with github and hostname", () => {
    const config = {
      repos: {
        api: { path: "/tmp/api", github: "org/api", hostname: "github.example.com" },
        frontend: { path: "/tmp/frontend", github: "org/frontend" },
      },
    };
    const entries = getRepoEntries(config);
    expect(entries.api).toEqual({ path: "/tmp/api", github: "org/api", hostname: "github.example.com" });
    expect(entries.frontend).toEqual({ path: "/tmp/frontend", github: "org/frontend", hostname: undefined });
  });

  it("handles mixed string and object repos", () => {
    const config = {
      repos: {
        api: { path: "/tmp/api", github: "org/api" },
        legacy: "/tmp/legacy",
      },
    };
    const entries = getRepoEntries(config);
    expect(entries.api.github).toBe("org/api");
    expect(entries.legacy).toEqual({ path: "/tmp/legacy" });
  });

  it("returns empty object when no repos config", () => {
    expect(getRepoEntries({})).toEqual({});
    expect(getRepoEntries(undefined)).toEqual({});
  });
});

describe("buildCandidateRepositories", () => {
  it("builds candidates from repos with github field", () => {
    const config = {
      repos: {
        api: { path: "/tmp/api", github: "calltelemetry/cisco-cdr" },
        frontend: { path: "/tmp/frontend", github: "calltelemetry/ct-quasar" },
        legacy: "/tmp/legacy",
      },
    };
    const candidates = buildCandidateRepositories(config);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({ hostname: "github.com", repositoryFullName: "calltelemetry/cisco-cdr" });
    expect(candidates[1]).toEqual({ hostname: "github.com", repositoryFullName: "calltelemetry/ct-quasar" });
  });

  it("uses custom hostname when provided", () => {
    const config = {
      repos: {
        api: { path: "/tmp/api", github: "org/api", hostname: "git.corp.com" },
      },
    };
    const candidates = buildCandidateRepositories(config);
    expect(candidates[0].hostname).toBe("git.corp.com");
  });

  it("returns empty array when no repos have github", () => {
    const config = { repos: { api: "/tmp/api" } };
    expect(buildCandidateRepositories(config)).toEqual([]);
  });
});

describe("resolveRepos with team mapping", () => {
  const config = {
    repos: {
      api: { path: "/tmp/api", github: "org/api" },
      frontend: { path: "/tmp/frontend", github: "org/frontend" },
    },
    teamMappings: {
      API: { repos: ["api"], defaultAgent: "kaylee" },
      UAT: { repos: ["api", "frontend"] },
      MED: { context: "Media team" },
    },
  };

  it("uses team mapping when no body markers or labels", () => {
    const result = resolveRepos("Plain description", [], config, "API");
    expect(result.source).toBe("team_mapping");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[0].path).toBe("/tmp/api");
  });

  it("team mapping resolves multi-repo teams", () => {
    const result = resolveRepos("Plain description", [], config, "UAT");
    expect(result.source).toBe("team_mapping");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("body markers take priority over team mapping", () => {
    const result = resolveRepos("<!-- repos: frontend -->", [], config, "API");
    expect(result.source).toBe("issue_body");
    expect(result.repos[0].name).toBe("frontend");
  });

  it("labels take priority over team mapping", () => {
    const result = resolveRepos("No markers", ["repo:frontend"], config, "API");
    expect(result.source).toBe("labels");
    expect(result.repos[0].name).toBe("frontend");
  });

  it("falls back to config_default when team has no repos", () => {
    const result = resolveRepos("Plain description", [], config, "MED");
    expect(result.source).toBe("config_default");
  });

  it("falls back to config_default when teamKey is unknown", () => {
    const result = resolveRepos("Plain description", [], config, "UNKNOWN");
    expect(result.source).toBe("config_default");
  });

  it("falls back to config_default when no teamKey provided", () => {
    const result = resolveRepos("Plain description", [], config);
    expect(result.source).toBe("config_default");
  });
});

describe("detectMentionedRepos", () => {
  const repos = ["ld-shopify", "ld-shopify-admin", "transaction-monitor-2", "shopify-tracker"];

  it("finds a repo named in a comment", () => {
    expect(detectMentionedRepos("the bug is in ld-shopify, per George", repos)).toEqual(["ld-shopify"]);
  });

  it("does NOT match a shorter name inside a longer repo name", () => {
    // "ld-shopify-admin" must not also register "ld-shopify"
    expect(detectMentionedRepos("fix the ld-shopify-admin settings page", repos)).toEqual(["ld-shopify-admin"]);
  });

  it("ignores near-mentions that are not the exact repo name (e.g. TMv2)", () => {
    expect(detectMentionedRepos("honored server-side in TMv2 but not the browser", repos)).toEqual([]);
  });

  it("is case-insensitive and de-duplicates", () => {
    expect(detectMentionedRepos("LD-Shopify here, and ld-shopify again", repos)).toEqual(["ld-shopify"]);
  });

  it("returns multiple when several distinct repos are named", () => {
    expect(detectMentionedRepos("touches ld-shopify and shopify-tracker", repos).sort()).toEqual(
      ["ld-shopify", "shopify-tracker"],
    );
  });

  it("returns [] for empty text or no match", () => {
    expect(detectMentionedRepos("", repos)).toEqual([]);
    expect(detectMentionedRepos("nothing relevant here", repos)).toEqual([]);
  });
});

describe("validateRepoPath", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exists:false for missing path", () => {
    mockExistsSync.mockReturnValue(false);
    const result = validateRepoPath("/no/such/path");
    expect(result).toEqual({ exists: false, isGitRepo: false, isSubmodule: false });
  });

  it("returns isGitRepo:true, isSubmodule:false for normal repo (.git is directory)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => false, isDirectory: () => true });
    const result = validateRepoPath("/tmp/test/repos/api");
    expect(result).toEqual({ exists: true, isGitRepo: true, isSubmodule: false });
  });

  it("returns isGitRepo:true, isSubmodule:true for submodule (.git is file)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });
    const result = validateRepoPath("/tmp/test/workspace/submod");
    expect(result).toEqual({ exists: true, isGitRepo: true, isSubmodule: true });
  });

  it("returns isGitRepo:false for directory without .git", () => {
    // First call: path exists. Second call: .git does not exist
    mockExistsSync.mockImplementation((p: string) => !String(p).endsWith(".git"));
    const result = validateRepoPath("/tmp/test/not-a-repo");
    expect(result).toEqual({ exists: true, isGitRepo: false, isSubmodule: false });
  });
});
