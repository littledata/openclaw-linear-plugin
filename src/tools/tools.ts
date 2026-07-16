import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createCodeTools } from "./code-tool.js";
import { createLinearIssuesTool } from "./linear-issues-tool.js";
import { createSteeringTools } from "./steering-tools.js";
import { createContainerTools } from "./container-tools.js";

export function createLinearTools(api: OpenClawPluginApi, ctx: Record<string, unknown>): any[] {
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;

  // Per-backend coding CLI tools: cli_codex, cli_claude, cli_gemini
  const codeTools: AnyAgentTool[] = [];
  try {
    codeTools.push(...createCodeTools(api, ctx));
  } catch (err) {
    api.logger.warn(`CLI coding tools not available: ${err}`);
  }

  // Linear issue management — native GraphQL API tool
  const linearIssuesTools: AnyAgentTool[] = [];
  try {
    linearIssuesTools.push(createLinearIssuesTool(api));
  } catch (err) {
    api.logger.warn(`linear_issues tool not available: ${err}`);
  }

  // Per-ticket container sandbox tools (write-isolated code changes + running).
  const containerTools: AnyAgentTool[] = [];
  if (pluginConfig?.enableContainerTools !== false) {
    try {
      containerTools.push(...createContainerTools(api, ctx));
    } catch (err) {
      api.logger.warn(`Container tools not available: ${err}`);
    }
  }

  // Steering tools (steer/capture/abort active tmux agent sessions)
  const steeringTools: AnyAgentTool[] = [];
  const enableTmux = pluginConfig?.enableTmux !== false;
  if (enableTmux) {
    try {
      steeringTools.push(...createSteeringTools(api, ctx));
    } catch (err) {
      api.logger.warn(`Steering tools not available: ${err}`);
    }
  }

  return [
    ...codeTools,
    ...linearIssuesTools,
    ...containerTools,
    ...steeringTools,
  ];
}
