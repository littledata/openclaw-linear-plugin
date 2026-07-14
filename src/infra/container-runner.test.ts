import { describe, it, expect } from "vitest";
import {
  containerNameForIssue,
  repoWorkdir,
  buildRunArgs,
  buildCodexInner,
  GIT_STATUS_SCRIPT,
  parseContainerGitStatus,
  PROVISION_SCRIPT,
  CHECKOUT_PR_SCRIPT,
  PUBLISH_PR_REVIEW_SCRIPT,
  PROVISION_GITHUB_REPO_SCRIPT,
  checkoutPullRequestInContainer,
  publishPullRequestReviewInContainer,
  parseContainerRows,
  selectExpired,
  ISSUE_LABEL,
  CREATED_LABEL,
  REPOS_RO_MOUNT,
  CLAW_MOUNT,
  type ContainerStartSpec,
} from "./container-runner.js";

describe("containerNameForIssue", () => {
  it("derives a docker-safe name from the identifier", () => {
    expect(containerNameForIssue("CORE-1740")).toBe("openclaw-linear-CORE-1740");
  });
  it("sanitizes unsafe characters", () => {
    expect(containerNameForIssue("team/weird id!")).toBe("openclaw-linear-team-weird-id-");
  });
});

describe("repoWorkdir", () => {
  it("maps a repo name to its in-container path", () => {
    expect(repoWorkdir("ld-shopify")).toBe("/work/ld-shopify");
  });
});

describe("buildRunArgs", () => {
  const base: ContainerStartSpec = {
    issueIdentifier: "CORE-1740",
    image: "openclaw-linear-worker:latest",
    targetRepos: ["ld-shopify"],
    branch: "CORE-1740/Fix",
    reposRoot: "/root/repos",
    clawHostDir: "/root/.claw/CORE-1740",
    createdAtMs: 1_000,
    repositorySource: "local",
  };

  it("runs detached with a deterministic name, labels, and the RO repos + claw mounts", () => {
    const args = buildRunArgs(base);
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(args).toContain("openclaw-linear-CORE-1740");
    expect(args).toContain(`${ISSUE_LABEL}=CORE-1740`);
    expect(args).toContain(`${CREATED_LABEL}=1000`);
    expect(args).toContain(`/root/repos:${REPOS_RO_MOUNT}:ro`);
    expect(args).toContain(`/root/.claw/CORE-1740:${CLAW_MOUNT}`);
    // keepalive entrypoint
    expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("mounts only Codex auth and never ambient GitHub credentials", () => {
    const args = buildRunArgs({
      ...base,
      codexAuthFile: "/root/.codex/auth.json",
      memory: "4g",
      cpus: "2",
    });
    expect(args).toContain("/root/.codex/auth.json:/root/.codex/auth.json:ro");
    expect(args.join(" ")).not.toContain(".git-credentials");
    expect(args.join(" ")).not.toContain("GH_TOKEN=");
    expect(args).toContain("--memory");
    expect(args).toContain("4g");
    expect(args).toContain("--cpus");
  });

  it("does not mount the host repository mirror in GitHub App mode", () => {
    const args = buildRunArgs({ ...base, repositorySource: "github-app" });
    expect(args.join(" ")).not.toContain(REPOS_RO_MOUNT);
    expect(args).toContain(`/root/.claw/CORE-1740:${CLAW_MOUNT}`);
  });
});

describe("PROVISION_SCRIPT", () => {
  it("uses --shared (cross-fs safe) and reads REPOS/BRANCH from env", () => {
    expect(PROVISION_SCRIPT).toContain('git clone --shared "/repos-ro/$r" "/work/$r"');
    expect(PROVISION_SCRIPT).toContain('checkout -B "$BRANCH"');
    expect(PROVISION_SCRIPT).toContain("update-ref refs/openclaw/base HEAD");
    expect(PROVISION_SCRIPT).toContain("for r in $REPOS");
  });
});

describe("PROVISION_GITHUB_REPO_SCRIPT", () => {
  it("continues a remote branch or creates it from the live default branch", () => {
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('ls-remote --exit-code --heads origin "$BRANCH"');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('pull --ff-only origin "$BRANCH"');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('symbolic-ref --short refs/remotes/origin/HEAD');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('checkout -B "$BRANCH" "$DEFAULT_REF"');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('merge-base HEAD "$DEFAULT_REF"');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain('status --porcelain');
    expect(PROVISION_GITHUB_REPO_SCRIPT).toContain("refs/openclaw/base");
  });
});

describe("parseContainerGitStatus", () => {
  it("treats an uncommitted file as implementation activity", () => {
    expect(parseContainerGitStatus(
      "PORCELAIN<<\n M src/a.ts\n>>\nLASTCOMMIT=abc existing\nCOMMITS_AHEAD=0\n",
    )).toEqual({ hasChanges: true, lastCommit: "abc existing", commitsAhead: 0 });
  });

  it("treats a clean committed branch as implementation activity", () => {
    expect(parseContainerGitStatus(
      "PORCELAIN<<\n>>\nLASTCOMMIT=def implementation\nCOMMITS_AHEAD=2\n",
    )).toEqual({ hasChanges: true, lastCommit: "def implementation", commitsAhead: 2 });
  });

  it("recognizes a completely untouched repo", () => {
    expect(parseContainerGitStatus(
      "PORCELAIN<<\n>>\nLASTCOMMIT=abc base\nCOMMITS_AHEAD=0\n",
    )).toEqual({ hasChanges: false, lastCommit: "abc base", commitsAhead: 0 });
  });

  it("compares against the provisioned base ref", () => {
    expect(GIT_STATUS_SCRIPT).toContain("refs/openclaw/base");
    expect(GIT_STATUS_SCRIPT).toContain("COMMITS_AHEAD");
  });
});

describe("CHECKOUT_PR_SCRIPT", () => {
  it("fetches the exact GitHub pull ref and checks out a dedicated review branch", () => {
    expect(CHECKOUT_PR_SCRIPT).toContain('fetch --force "$REMOTE_URL" "pull/$PR_NUMBER/head"');
    expect(CHECKOUT_PR_SCRIPT).toContain('checkout -B "review/pr-$PR_NUMBER" FETCH_HEAD');
    expect(CHECKOUT_PR_SCRIPT).toContain('reset --hard FETCH_HEAD');
  });

  it("rejects a PR URL from a repository other than the configured target", async () => {
    await expect(checkoutPullRequestInContainer(
      "openclaw-linear-CORE-1740",
      "ld-shopify",
      "https://github.com/attacker/ld-shopify/pull/10",
      10,
      { githubOwner: "littledata", repos: { "ld-shopify": "/repos/ld-shopify" } },
    )).resolves.toMatchObject({ status: 2, stderr: expect.stringContaining("does not match") });
  });
});

describe("PUBLISH_PR_REVIEW_SCRIPT", () => {
  it("publishes a formal GitHub review and stable check run", () => {
    expect(PUBLISH_PR_REVIEW_SCRIPT).toContain('gh pr review "$PR_URL" "$REVIEW_EVENT" --body "$REVIEW_BODY"');
    expect(PUBLISH_PR_REVIEW_SCRIPT).toContain('name="OpenClaw Review"');
    expect(PUBLISH_PR_REVIEW_SCRIPT).toContain('conclusion="$CHECK_CONCLUSION"');
  });

  it("rejects review publication outside the configured repository", async () => {
    await expect(publishPullRequestReviewInContainer(
      "openclaw-linear-CORE-1740",
      "ld-shopify",
      "https://github.com/attacker/ld-shopify/pull/10",
      "review",
      true,
      { githubOwner: "littledata", repos: { "ld-shopify": "/repos/ld-shopify" } },
    )).resolves.toMatchObject({ status: 2, stderr: expect.stringContaining("does not match") });
  });
});

describe("buildCodexInner", () => {
  it("uses the sandbox-bypass flag and the prompt env var", () => {
    const cmd = buildCodexInner("/work/ld-shopify", "gpt-5.6-sol", "high");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).toContain("-m gpt-5.6-sol");
    expect(cmd).toContain("-c model_reasoning_effort=high");
    expect(cmd).toContain("-C /work/ld-shopify");
    expect(cmd).toContain('"$PROMPT"');
  });
  it("omits model/effort flags when not given", () => {
    const cmd = buildCodexInner("/work/x");
    expect(cmd).not.toContain("-m ");
    expect(cmd).not.toContain("model_reasoning_effort");
  });
});

describe("parseContainerRows + selectExpired", () => {
  it("parses name|createdAt rows", () => {
    const rows = parseContainerRows("openclaw-linear-A|1000\nopenclaw-linear-B|5000\n");
    expect(rows).toEqual([
      { name: "openclaw-linear-A", createdAtMs: 1000 },
      { name: "openclaw-linear-B", createdAtMs: 5000 },
    ]);
  });
  it("selects only rows past the TTL", () => {
    const rows = parseContainerRows("A|0\nB|9000\n");
    // now=10000, ttl=5000 → A (age 10000) expired, B (age 1000) not
    expect(selectExpired(rows, 10_000, 5_000)).toEqual(["A"]);
  });
  it("treats an unparseable createdAt as expired (reap orphans)", () => {
    const rows = parseContainerRows("A|notanumber\n");
    expect(selectExpired(rows, 10_000, 5_000)).toEqual(["A"]);
  });
});
