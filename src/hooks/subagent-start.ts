import { subagentProtocol } from "../shared/protocol.ts";
import type { HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * Subagents inherit the MCP tools but not the parent's conversation, so without this they
 * would make decisions with no idea that Jev exists.
 */
export function subagentStart({ input, cfg }: HookCtx): HookOutput | undefined {
  if (cfg.enforcement === "off") return undefined;
  const type = input.agent_type ?? "";
  if (cfg.subagentSkip.includes(type)) return undefined;

  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: subagentProtocol(input.agent_type, cfg),
    },
  };
}
