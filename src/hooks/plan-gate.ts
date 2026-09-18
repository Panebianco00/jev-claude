import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { BUDGETS, resolveApiKey } from "../shared/config.ts";
import { ask } from "../shared/jev-client.ts";
import { NONE_OF_THESE, judgePlanReview, planRisks } from "../shared/policy.ts";
import { PLAN_IDS, buildPlanReviewRequest } from "../shared/questions.ts";
import {
  REMINDER_PLAN,
  planDenyNoConsultation,
  planDenyReview,
  planReviewSummary,
} from "../shared/protocol.ts";
import type { GateEntry, HookOutput, LedgerEntry } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/** A plan is markdown someone wrote; anything larger is not one. */
const MAX_PLAN_FILE = 256 * 1024;

/**
 * Refuses to let a plan be presented for approval until Jev has been consulted about it.
 *
 * This is the hook that makes "including plan mode" real: plan mode blocks edits, not tool
 * calls, so the model can deliberate and commit to an approach entirely inside a plan without
 * a single observable decision. ExitPlanMode is the one moment where that plan becomes
 * visible and is still changeable.
 *
 * It never returns "allow": the user's own approval dialog must still appear.
 */
export async function planGate(ctx: HookCtx): Promise<HookOutput | undefined> {
  const { input, cfg, store } = ctx;
  if (cfg.enforcement === "off" || cfg.enforcement === "soft") return undefined;
  // A subagent cannot own the session's plan, and denying inside one only wastes its turn.
  if (input.agent_id) return undefined;

  store.ensureDirs();
  const gates = store.gates();
  const epochStart = planEpochStart(gates, store);
  const plan = readPlan(input.tool_input);
  const planHash = createHash("sha1").update(plan).digest("hex").slice(0, 16);

  // The refusal budget is keyed by the plan's content, not by the planning session: a plan
  // the user rejects never closes the epoch, so an epoch-keyed counter would stay exhausted
  // and silently disable the gate for the rest of the session. A revised plan is a new hash
  // and gets a fresh budget; resubmitting the identical text does not.
  const denies = gates.filter(
    (g) => g.gate === "plan" && g.outcome === "denied" && g.planHash === planHash,
  ).length;
  const budgetLeft = denies < cfg.planMaxDenies;

  const { freshAttempts, decisions, settled } = planConsultations(store.ledger(), epochStart, input);
  const { key } = resolveApiKey(cfg, ctx.env);

  // "Consulted" has to mean "Claude asked", not "Jev answered". Refusing because the API was
  // unreachable would demand something Claude cannot deliver: it would consult, get
  // proceed_unverified, be refused again, and burn the whole budget on every plan.
  if (decisions.length === 0 && (freshAttempts.length > 0 || !key)) {
    return {
      systemMessage: key
        ? `Jev: the plan was not verified (${freshAttempts.length} consultation(s) could not reach Jev).`
        : "Jev: no API key, so the plan was not verified.",
    };
  }

  if (decisions.length === 0) {
    if (!budgetLeft) {
      return {
        systemMessage: `Jev plan gate: bypassed after ${cfg.planMaxDenies} refusals; the plan was not consulted.`,
      };
    }
    store.appendGate(gate(input, "denied", planHash, { why: "no_consultation" }));
    return deny(planDenyNoConsultation(denies + 1, cfg.planMaxDenies));
  }

  if (!cfg.planReview || plan.length < 40) {
    return { systemMessage: `Jev: ${decisions.length} decision(s) recorded for this plan.` };
  }

  const built = buildPlanReviewRequest({
    userRequest: recentPrompts(store, epochStart),
    plan,
    decisions: settled,
  });
  // A cached review is only reusable for the same questions: reworded questions (a plugin
  // update) or a new decision to check the plan against both change what is being asked.
  const questionsHash = createHash("sha1").update(JSON.stringify(built.questions)).digest("hex").slice(0, 16);
  const cached = gates.find(
    (g) =>
      g.gate === "plan" &&
      g.outcome === "reviewed" &&
      g.planHash === planHash &&
      g.questionsHash === questionsHash &&
      g.review,
  );
  let review = cached?.review;
  let coverage = cached?.coverage;

  if (!review) {
    const result = await ask({
      questions: built.questions,
      state: built.state,
      budgetMs: BUDGETS.planGate,
      cfg,
      env: ctx.env,
    });
    // Fail open: a plan the user is waiting on must not be held hostage by an API outage.
    if (!result.ok) {
      return { systemMessage: `Jev plan review unavailable (${result.code}); the plan was not reviewed.` };
    }
    review = { ...result.nouls };
    coverage = result.scores[PLAN_IDS.coverage]?.score;
  }

  const { problems, blocking } = judgePlanReview(review, coverage, cfg.thresholds);
  if (!cached) {
    const extra: Partial<GateEntry> = { review, questionsHash, problems };
    if (coverage !== undefined) extra.coverage = coverage;
    store.appendGate(gate(input, "reviewed", planHash, extra));
  }

  if (blocking && budgetLeft) {
    store.appendGate(gate(input, "denied", planHash, { why: "review" }));
    return deny(planDenyReview(denies + 1, cfg.planMaxDenies, review, coverage, problems));
  }

  // Whatever the review found still reaches the user, including on the bypass path: a plan
  // that is about to be approved despite a finding is exactly when they need to hear it.
  const risks = planRisks(review, cfg.thresholds);
  const parts = [
    blocking
      ? `Jev plan gate: bypassed after ${cfg.planMaxDenies} refusals, and the review still finds problems.`
      : planReviewSummary(review, coverage, decisions.length),
  ];
  if (problems.length) parts.push(`Findings: ${problems.join("; ")}.`);
  if (risks.length) parts.push(`Irreversible: ${risks.join(", ")}.`);
  return { systemMessage: parts.join(" ") };
}

/**
 * Plan mode entered mid-turn. The prompt hook only knows the mode the turn started in, so a
 * turn that switches into planning got no plan-mode instructions until the gate refused.
 */
export function planEntered({ input, cfg }: HookCtx): HookOutput | undefined {
  if (cfg.enforcement === "off" || input.agent_id) return undefined;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: REMINDER_PLAN } };
}

/** Closes the plan epoch. PostToolUse only fires once the user has approved the plan. */
export function planExited({ input, store }: HookCtx): HookOutput | undefined {
  store.ensureDirs();
  store.appendGate({
    v: 1,
    ts: Date.now(),
    gate: "plan",
    outcome: "exited",
    session_id: input.session_id ?? "unknown",
    prompt_id: input.prompt_id,
  });
  return undefined;
}

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    // The denial renders as a red tool error, so tell the user what is actually happening.
    systemMessage: "Jev plan gate: asking Claude to consult Jev about this plan first.",
  };
}

function gate(
  input: HookCtx["input"],
  outcome: GateEntry["outcome"],
  planHash: string,
  extra: Partial<GateEntry>,
): GateEntry {
  return {
    v: 1,
    ts: Date.now(),
    gate: "plan",
    outcome,
    session_id: input.session_id ?? "unknown",
    prompt_id: input.prompt_id,
    planHash,
    ...extra,
  };
}

/**
 * When the planning that produced this plan began: the later of the last approved plan and
 * the start of the current unbroken run of plan-mode prompts.
 *
 * Without the second half, a session that has never approved a plan would count every
 * decision it ever made — including ones from ordinary turns before planning started — as
 * consultation for this plan.
 */
function planEpochStart(gates: GateEntry[], store: HookCtx["store"]): number {
  let exited = 0;
  for (const g of gates) if (g.gate === "plan" && g.outcome === "exited" && g.ts > exited) exited = g.ts;

  const prompts = store.prompts();
  let runStart = 0;
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i];
    if (!p) break;
    if (p.permission_mode !== "plan") break;
    runStart = p.ts;
  }
  // Plan mode is often entered mid-turn, so the current prompt may not be marked as one.
  // Falling back to the whole session would make the absent signal maximally permissive —
  // a stale decision from an unrelated earlier turn would pass as consultation — so the
  // narrower fallback is the current turn.
  if (runStart === 0) runStart = prompts[prompts.length - 1]?.ts ?? 0;
  return Math.max(exited, runStart === 0 ? 0 : runStart - 1);
}

/**
 * Splits what happened since the epoch into consultations Claude made and verdicts Jev
 * actually gave. An entry carrying an error code is the former but not the latter.
 */
function planConsultations(
  ledger: LedgerEntry[],
  epochStart: number,
  input: HookCtx["input"],
): {
  freshAttempts: LedgerEntry[];
  decisions: LedgerEntry[];
  settled: { label: string; choice?: string; choiceText?: string; action: string }[];
} {
  const attempts = ledger.filter(
    (e) =>
      e.ts > epochStart &&
      !e.agent_id &&
      (e.permission_mode === "plan" || (input.prompt_id !== undefined && e.prompt_id === input.prompt_id)),
  );
  // An outage excuses the plan in front of us, not every plan for the rest of the session,
  // so only a failure from this turn waives the gate.
  const freshAttempts = attempts.filter(
    (e) => input.prompt_id !== undefined && e.prompt_id === input.prompt_id,
  );
  const decisions = attempts.filter((e) => !e.error && e.action !== "proceed_unverified");

  // Only a decision Jev actually settled may be asserted back to it as "already taken".
  // A confirm or an escalation means the plan is supposed to leave the question open — the
  // protocol says so explicitly — and asking whether the plan acts on it would refuse the
  // plan for doing as it was told.
  const settled = decisions
    .filter(
      (e) =>
        (e.action === "proceed" || e.action === "proceed_and_flag") &&
        e.choice !== undefined &&
        e.choice !== NONE_OF_THESE,
    )
    .map((e) => ({ label: e.label, choice: e.choice, choiceText: e.choice_text, action: e.action }));

  return { freshAttempts, decisions, settled };
}

function recentPrompts(store: HookCtx["store"], since: number): string {
  return store
    .prompts(since)
    .slice(-3)
    .map((p) => p.text)
    .join("\n\n")
    .slice(0, 6000);
}

/**
 * The plan file first, the injected `plan` field only as a fallback.
 *
 * Claude Code injects the plan into tool_input too, but that copy was observed one edit
 * behind the file: a plan revised after a refusal was reviewed as the previous version, and
 * resubmitting it unchanged produced a new hash and a fresh refusal budget each time.
 */
function readPlan(toolInput: Record<string, unknown> | undefined): string {
  const path = toolInput?.["planFilePath"];
  if (typeof path === "string") {
    try {
      // Without the stat, a path that is a FIFO or a character device would be read until
      // EOF — gigabytes of allocation inside a hook that is holding up plan approval.
      const stat = statSync(path);
      if (stat.isFile() && stat.size <= MAX_PLAN_FILE) {
        const text = readFileSync(path, "utf8");
        if (text.trim()) return text.slice(0, 24000);
      }
    } catch {
      // fall through to the injected copy
    }
  }
  const plan = toolInput?.["plan"];
  if (typeof plan === "string" && plan.trim()) return plan.slice(0, 24000);
  return "";
}
