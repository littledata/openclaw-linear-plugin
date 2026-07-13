import { describe, it, expect } from "vitest";
import {
  containerNameForIssue,
  repoWorkdir,
  buildRunArgs,
  buildCodexInner,
  PROVISION_SCRIPT,
  CHECKOUT_PR_SCRIPT,
  PUBLISH_PR_REVIEW_SCRIPT,
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

  it("adds auth mounts, gh token, and resource caps when provided", () => {
    const args = buildRunArgs({
      ...base,
      codexAuthFile: "/root/.codex/auth.json",
      gitCredentialsFile: "/root/.git-credentials",
      ghToken: "ght_abc",
      memory: "4g",
      cpus: "2",
    });
    expect(args).toContain("/root/.codex/auth.json:/root/.codex/auth.json:ro");
    expect(args).toContain("/root/.git-credentials:/root/.git-credentials:ro");
    expect(args).toContain("GH_TOKEN=ght_abc");
    expect(args).toContain("--memory");
    expect(args).toContain("4g");
    expect(args).toContain("--cpus");
  });
});

describe("PROVISION_SCRIPT", () => {
  it("uses --shared (cross-fs safe) and reads REPOS/BRANCH from env", () => {
    expect(PROVISION_SCRIPT).toContain('git clone --shared "/repos-ro/$r" "/work/$r"');
    expect(PROVISION_SCRIPT).toContain('checkout -B "$BRANCH"');
    expect(PROVISION_SCRIPT).toContain("for r in $REPOS");
  });
});

describe("CHECKOUT_PR_SCRIPT", () => {
  it("fetches the exact GitHub pull ref and checks out a dedicated review branch", () => {
    expect(CHECKOUT_PR_SCRIPT).toContain('fetch --force "$REMOTE_URL" "pull/$PR_NUMBER/head"');
    expect(CHECKOUT_PR_SCRIPT).toContain('checkout -B "review/pr-$PR_NUMBER" FETCH_HEAD');
    expect(CHECKOUT_PR_SCRIPT).toContain('reset --hard FETCH_HEAD');
  });
});

describe("PUBLISH_PR_REVIEW_SCRIPT", () => {
  it("publishes a GitHub review comment using env-provided content", () => {
    expect(PUBLISH_PR_REVIEW_SCRIPT).toContain('gh pr review "$PR_URL" --comment --body "$REVIEW_BODY"');
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
