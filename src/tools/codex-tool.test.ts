import { describe, expect, it } from "vitest";
import { mapCodexEventToActivity } from "./codex-tool.js";

describe("Codex Linear activity projection", () => {
  it("uses Bash as the title and keeps arguments in the expandable parameter", () => {
    expect(mapCodexEventToActivity({
      type: "item.started",
      item: { type: "command_execution", command: "/bin/bash -lc \"git status\"" },
    })).toEqual([{
      type: "action",
      action: "Bash",
      parameter: "/bin/bash -lc \"git status\"",
    }]);
  });

  it("adds the command result to the completed Bash card", () => {
    expect(mapCodexEventToActivity({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "git status --short",
        exit_code: 0,
        aggregated_output: " M src/index.ts\n",
      },
    })).toEqual([{
      type: "action",
      action: "Bash",
      parameter: "git status --short",
      result: "exit 0\n\n M src/index.ts\n",
    }]);
  });
});
