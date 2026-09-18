import { BUDGETS, resolveApiKey } from "../shared/config.ts";
import { ask } from "../shared/jev-client.ts";
import { atLeast } from "../shared/policy.ts";
import { TRIAGE_STOP_ID, buildTriageRequest } from "../shared/questions.ts";
import { stopBlock } from "../shared/protocol.ts";
import { thisTurn, turnKey } from "../shared/ledger.ts";
import type { HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * Strict mode only. The last observable moment of a turn.
 *
 * It deliberately does NOT require that files were edited: the decisions that escape every
 * other gate are exactly the ones made in prose — a turn that writes via Bash, or that picks
 * an approach and asks the user about it without ever calling a gated tool.
 */
export async function stopBackstop(ctx: HookCtx): Promise<HookOutput | undefined> {
  const { input, cfg, store } = ctx;
  if (cfg.enforcement !== "strict" || !cfg.stopBackstop) return undefined;
  if (input.stop_hook_active) return undefined; // already continuing because of a Stop hook
  if (thisTurn(store.ledger(), input).length > 0) return undefined;

  const message = input.last_assistant_message ?? "";
  if (message.length < 80) return undefined;

  store.ensureDirs();
  if (!store.claim("stopblock", turnKey(input))) return undefined; // at most one block per turn

  const { key } = resolveApiKey(cfg, ctx.env);
  if (!key) return undefined;

  const prompts = store.prompts();
  const built = buildTriageRequest({
    kind: "stop",
    userRequest: prompts[prompts.length - 1]?.text ?? "",
    evidence: { assistant_message: message.slice(0, 6000) },
  });

  const result = await ask({
    questions: built.questions,
    state: built.state,
    budgetMs: BUDGETS.stopBackstop,
    cfg,
    env: ctx.env,
  });
  if (!result.ok) return undefined;

  const p = result.nouls[TRIAGE_STOP_ID];
  if (p === undefined || !atLeast(p, cfg.thresholds.triage.stop)) return undefined;

  store.appendGate({
    v: 1,
    ts: Date.now(),
    gate: "stop",
    outcome: "denied",
    session_id: input.session_id ?? "unknown",
    prompt_id: input.prompt_id,
    p,
  });

  return { decision: "block", reason: stopBlock(p) };
}
