import { describe, it, expect } from "vitest";
import { buildDockerRunArgs, WORKER_SCRIPT } from "./container-runner.js";

describe("WORKER_SCRIPT", () => {
  it("clones, checks out the branch, and runs codex exec", () => {
    expect(WORKER_SCRIPT).toContain('git clone --depth 50 "$REMOTE_URL"');
    expect(WORKER_SCRIPT).toContain('git checkout -B "$BRANCH"');
    expect(WORKER_SCRIPT).toContain("codex exec --full-auto --json --ephemeral");
    // Dynamic values referenced as env vars, never interpolated literals.
    expect(WORKER_SCRIPT).toContain('"$PROMPT"');
  });
});

describe("buildDockerRunArgs", () => {
  const base = {
    image: "openclaw-linear-worker:latest",
    remoteUrl: "https://github.com/littledata/foo.git",
    branch: "CORE-1/Fix-Bar",
    prompt: "implement the thing",
  };

  it("builds a --rm run with the image and the worker script", () => {
    const args = buildDockerRunArgs(base);
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("openclaw-linear-worker:latest");
    expect(args[args.length - 3]).toBe("bash");
    expect(args[args.length - 2]).toBe("-c");
  });

  it("passes dynamic values as env vars (injection-safe)", () => {
    const args = buildDockerRunArgs(base);
    expect(args).toContain("REMOTE_URL=https://github.com/littledata/foo.git");
    expect(args).toContain("BRANCH=CORE-1/Fix-Bar");
    expect(args).toContain("PROMPT=implement the thing");
  });

  it("omits model/effort env when not provided; includes them when set", () => {
    expect(buildDockerRunArgs(base).some(a => a.startsWith("MODEL="))).toBe(false);
    const withModel = buildDockerRunArgs({ ...base, model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(withModel).toContain("MODEL=gpt-5.6-sol");
    expect(withModel).toContain("EFFORT=high");
  });

  it("adds read-only auth mounts when paths are given", () => {
    const args = buildDockerRunArgs({ ...base, codexAuthDir: "/root/.codex", gitCredentialsFile: "/root/.git-credentials" });
    expect(args).toContain("/root/.codex:/root/.codex:ro");
    expect(args).toContain("/root/.git-credentials:/root/.git-credentials:ro");
  });
});
