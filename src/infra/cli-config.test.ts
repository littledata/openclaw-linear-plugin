import { describe, expect, it, vi } from "vitest";
import { saveLinearPluginConfig } from "./cli.js";

describe("saveLinearPluginConfig", () => {
  it("persists through the active-profile mutation API", async () => {
    const draft: Record<string, any> = {
      plugins: {
        entries: {
          "openclaw-linear": { enabled: true, config: { repositorySource: "local" } },
        },
      },
    };
    const mutateConfigFile = vi.fn(async (params: any) => {
      await params.mutate(draft);
      return { nextConfig: draft };
    });
    const api = {
      runtime: {
        config: { mutateConfigFile },
      },
    } as any;

    await saveLinearPluginConfig(api, {
      repositorySource: "github-app",
      githubOwner: "littledata",
    });

    expect(mutateConfigFile).toHaveBeenCalledWith(expect.objectContaining({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    }));
    expect(draft.plugins.entries["openclaw-linear"]).toEqual({
      enabled: true,
      config: {
        repositorySource: "github-app",
        githubOwner: "littledata",
      },
    });
  });
});
