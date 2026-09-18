import { BUDGETS, resolveApiKey } from "../shared/config.ts";
import { ask } from "../shared/jev-client.ts";
import { atLeast } from "../shared/policy.ts";
import { TRIAGE_MUTATION_ID, buildTriageRequest } from "../shared/questions.ts";
import { mutationDeny } from "../shared/protocol.ts";
import { thisTurn, turnKey } from "../shared/ledger.ts";
import type { HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * Strict mode only. Stops once, before the turn's first edit, to ask Jev whether this task
 * actually involved a choice — a cheap triage that costs nothing on the many turns that have
 * exactly one reasonable implementation.
 *
 * It is one-shot by construction: the claim is taken on the first edit of the turn, so the
 * retry that follows the refusal always passes.
 */
export async function mutationGate(ctx: HookCtx): Promise<HookOutput | undefined> {
  const { input, cfg, store } = ctx;
  store.ensureDirs();

  // Checked before the claim: outside strict mode this hook fires on every edit and would
  // otherwise leave a claim file per turn for a gate that is off.
  if (cfg.enforcement !== "strict" || !cfg.mutationGate) return undefined;
  const firstEditOfTurn = store.claim("mut", turnKey(input));
  if (!firstEditOfTurn) return undefined;
  if (thisTurn(store.ledger(), input).length > 0) return undefined;

  // Implementing a plan the user already approved is not an unconsulted decision.
  const approved = store
    .gates()
    .some((g) => g.gate === "plan" && g.outcome === "exited" && g.prompt_id === input.prompt_id);
  if (approved) return undefined;

  const { key } = resolveApiKey(cfg, ctx.env);
  if (!key) return undefined;

  const prompts = store.prompts();
  const built = buildTriageRequest({
    kind: "mutation",
    userRequest: prompts[prompts.length - 1]?.text ?? "",
    evidence: {
      tool: input.tool_name ?? "",
      file_path: String(input.tool_input?.["file_path"] ?? ""),
      change_preview: String(
        input.tool_input?.["new_string"] ?? input.tool_input?.["content"] ?? "",
      ).slice(0, 1500),
    },
  });

  const result = await ask({
    questions: built.questions,
    state: built.state,
    budgetMs: BUDGETS.mutationGate,
    cfg,
    env: ctx.env,
  });
  if (!result.ok) return undefined;

  const p = result.nouls[TRIAGE_MUTATION_ID];
  if (p === undefined || !atLeast(p, cfg.thresholds.triage.mutation)) return undefined;

  store.appendGate({
    v: 1,
    ts: Date.now(),
    gate: "mutation",
    outcome: "denied",
    session_id: input.session_id ?? "unknown",
    prompt_id: input.prompt_id,
    p,
  });

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: mutationDeny(p),
    },
    systemMessage: "Jev: this task looks like it involves a choice; asking Claude to decide it first.",
  };
}
