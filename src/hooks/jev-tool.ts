import { isInteractive } from "../shared/config.ts";
import { buildLedgerEntry, extractResponseText } from "../shared/ledger.ts";
import type { CallContext, HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * Self-approval, and the only channel by which the server learns who it is answering.
 *
 * A plugin cannot ship permission rules, so without this every decision would raise a
 * permission prompt — including in plan mode, where the point is to be unobtrusive.
 * It must stay fast: it is on the critical path of every Jev call.
 */
export function preJevTool({ input, cfg, store, env }: HookCtx): HookOutput {
  const toolUseId = input.tool_use_id;
  if (toolUseId) {
    const ctx: CallContext = {
      session_id: input.session_id ?? "unknown",
      prompt_id: input.prompt_id,
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      permission_mode: input.permission_mode,
      cwd: input.cwd,
      ts: Date.now(),
      enforcement: cfg.enforcement,
      authority: cfg.authority,
      fail: cfg.fail,
      interactive: isInteractive(env),
    };
    store.ensureDirs();
    store.writeCtx(toolUseId, ctx);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Jev decision tool, self-approved by the jev plugin",
    },
  };
}

/**
 * The single writer of the ledger. The server cannot do this itself: it never learns the
 * session or turn ids except through the context file, and a record written from two places
 * would race.
 */
export function postJevTool({ input, store }: HookCtx): HookOutput | undefined {
  const toolUseId = input.tool_use_id;
  const record = toolUseId ? store.readCall(toolUseId) : undefined;

  const entry = buildLedgerEntry({
    input,
    ctx: toolUseId ? store.readCtx(toolUseId) : undefined,
    record,
    toolInput: input.tool_input,
    toolResponseText: extractResponseText(input.tool_response),
  });

  store.ensureDirs();
  store.appendLedger(entry);
  if (toolUseId) store.dropCall(toolUseId);
  return undefined;
}
