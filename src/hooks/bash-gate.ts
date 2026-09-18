import { createHash } from "node:crypto";
import { BUDGETS, resolveApiKey } from "../shared/config.ts";
import { dependencyAdds, riskyReason, sameCommand } from "../shared/commands.ts";
import { bashFacts } from "./bash-facts.ts";
import { ask } from "../shared/jev-client.ts";
import { thisTurn, turnKey } from "../shared/ledger.ts";
import { evaluate } from "../shared/policy.ts";
import { bashAskAfterCheck, bashDeny, dependencyDeny } from "../shared/protocol.ts";
import { buildCheckRequest } from "../shared/questions.ts";
import type { GateEntry, HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * Two gates on Bash, both at standard enforcement and above.
 *
 * Destructive commands get the `risky_command` check the skill has always told Claude to
 * run, now run for it: the one decision the protocol says must never go on an assumed
 * proceed was the one nothing enforced. Dependency installs are library choices made with a
 * shell command, so no other gate ever saw them.
 *
 * Both are bounded like every gate here: the risky check refuses a given command once, the
 * dependency gate once per turn, and any failure to reach Jev lets the command through.
 * Neither returns "allow": the user's own permission rules still apply to whatever passes.
 */
export async function bashGate(ctx: HookCtx): Promise<HookOutput | undefined> {
  const { input, cfg, store } = ctx;
  if (cfg.enforcement === "off" || cfg.enforcement === "soft") return undefined;
  const command = typeof input.tool_input?.["command"] === "string" ? (input.tool_input["command"] as string) : "";
  if (!command.trim()) return undefined;

  // Follow-through on an earlier check. A trial session ran `check` on a cleanup command, got
  // escalate_to_user, and deleted the file anyway: the ACTION line binds only as far as
  // something enforces it. The person decides here, so this asks rather than refuses, and it
  // asks once per command. It does not depend on the pre-filter below: `rm -f` is not on it.
  store.ensureDirs();
  const unsettled = [...store.ledger()]
    .reverse()
    .find(
      (e) =>
        e.kind === "check" &&
        !e.error &&
        e.subject !== undefined &&
        (e.action === "escalate_to_user" || e.action === "confirm" || e.action === "revise") &&
        sameCommand(command, e.subject),
    );
  if (unsettled) {
    const hash = createHash("sha1").update(command.trim()).digest("hex").slice(0, 16);
    if (store.claim("bash-ask", hash)) {
      store.appendGate(entry(input, "bash", "denied", `asked the user: ${unsettled.label} was ${unsettled.action}`));
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: bashAskAfterCheck(command, unsettled.action, unsettled.why),
        },
      };
    }
  }

  if (cfg.dependencyGate) {
    const added = dependencyAdds(command);
    if (added.length > 0) {
      store.ensureDirs();
      const consulted = thisTurn(store.ledger(), input).some((e) => !e.error);
      if (!consulted && store.claim("dep", turnKey(input))) {
        store.appendGate(entry(input, "dependency", "denied", added.join(" ")));
        return deny(dependencyDeny(added), "Jev: asking Claude to decide the library before installing it.");
      }
    }
  }

  if (!cfg.bashGate) return undefined;
  const reason = riskyReason(command);
  if (!reason) return undefined;

  store.ensureDirs();
  const hash = createHash("sha1").update(command.trim()).digest("hex").slice(0, 16);
  // Once per command, per session: the retry after a refusal is Claude's (or the user's) call.
  if (!store.claim("bash", hash)) return undefined;

  const { key } = resolveApiKey(cfg, ctx.env);
  if (!key) return undefined;

  const prompts = store.prompts();
  const userRequest = prompts[prompts.length - 1]?.text;
  const built = buildCheckRequest(
    {
      label: "bash-gate",
      preset: "risky_command",
      stakes: "high",
      state: {
        command,
        context: [
          typeof input.tool_input?.["description"] === "string"
            ? `Claude's description of the command: ${input.tool_input["description"]}`
            : "Claude gave no description with the command.",
          ...bashFacts(command, input.cwd),
        ].join("\n"),
      },
    },
    { userRequest },
  );
  const result = await ask({
    questions: built.questions,
    state: built.state,
    budgetMs: BUDGETS.bashGate,
    cfg,
    env: ctx.env,
  });
  if (!result.ok) {
    store.appendGate(entry(input, "bash", "bypassed", `${reason}; ${result.code}`));
    return { systemMessage: `Jev Bash gate: could not check \`${clip(command)}\` (${result.code}); it was not verified.` };
  }

  const outcome = evaluate({
    result,
    declaredStakes: "high",
    checks: built.checks,
    scores: [],
    cfg,
  });
  const blocking = outcome.checks.filter((c) => c.blocking);
  if (outcome.action === "proceed" || outcome.action === "proceed_and_flag" || blocking.length === 0) {
    store.appendGate(entry(input, "bash", "passed", reason));
    return undefined;
  }

  const findings = blocking.map((c) => `${c.id} -> ${c.verdict} (${c.p.toFixed(2)})`);
  store.appendGate(entry(input, "bash", "denied", `${reason}: ${blocking.map((c) => c.id).join(", ")}`));
  return deny(bashDeny(reason, command, findings, outcome.action), `Jev: \`${clip(command)}\` needs another look before it runs.`);
}

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function deny(reason: string, systemMessage: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    systemMessage,
  };
}

function entry(input: HookCtx["input"], gate: "bash" | "dependency", outcome: GateEntry["outcome"], why: string): GateEntry {
  return {
    v: 1,
    ts: Date.now(),
    gate,
    outcome,
    session_id: input.session_id ?? "unknown",
    prompt_id: input.prompt_id,
    why: why.slice(0, 200),
  };
}
