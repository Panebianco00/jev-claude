/**
 * The one text block Claude sees for a Jev call.
 *
 * Two constraints shape everything here. The block is the whole result, so anything
 * left out is not merely terse, it is invisible. And the last line is parsed: the
 * PostToolUse hook falls back to it when the server's record file is missing, so the
 * `jev-record: ` prefix and single-line JSON are a contract, not formatting.
 */
import { ACTION_MEANING } from "./policy.ts";
import type {
  Action,
  Authority,
  DecisionOutcome,
  FailMode,
  JevFailure,
} from "./types.ts";

export interface FormatCtx {
  plan: boolean;
  subagent: boolean;
  interactive: boolean;
  authority: Authority;
}

/** Roughly a screenful. Past this Claude starts skimming the block it must act on. */
const MAX_TEXT = 1200;
const MAX_WHY = 300;
const RECORD_PREFIX = "jev-record: ";

const KEY_URL = "https://console.typesafe.ai/keys";

function f2(n: number): string {
  return n.toFixed(2);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Who acts on a `confirm` or an `escalate_to_user` depends on where the run is, and
 * the surfaces are mutually exclusive in this order: a subagent has no user to ask,
 * a non-interactive run has no human at all, and plan mode has a plan to write into.
 */
export function actionSentence(action: Action, ctx: FormatCtx, kind?: "decide" | "check"): string {
  // A `check` has no option set, so the generic wording ("fix the option set and call again")
  // reads as "retry the check" when a blocking safety answer means the opposite: the
  // operation itself is what has to change.
  if (action === "revise" && kind === "check") {
    return "do not carry out the operation as written: a blocking check fired. Change the operation to clear it, or put the finding to the user; only call again once the operation or the state has actually changed";
  }
  if (action !== "confirm" && action !== "escalate_to_user") return ACTION_MEANING[action];

  if (ctx.subagent) {
    return action === "confirm"
      ? "report this in your final message to the parent agent as an OPEN decision, with Jev's pick and the probabilities; do not ask the user"
      : "report this in your final message to the parent agent as an OPEN decision, with the options and their probabilities; do not ask the user";
  }
  if (!ctx.interactive) {
    return action === "confirm"
      ? "there is no human in this run: state the open decision in your final answer and continue with the top option"
      : "there is no human in this run: state the open decision and the options in your final answer and continue with the top option";
  }
  if (ctx.plan) {
    return action === "confirm"
      ? "list this under a '## Decisions needing confirmation' heading in the plan, Jev's pick first, instead of calling AskUserQuestion"
      : "list this under a '## Decisions needing confirmation' heading in the plan, with the options and their probabilities, instead of calling AskUserQuestion";
  }
  return ACTION_MEANING[action];
}

/* ------------------------------------------------------------- assembly */

function clamp(line: string, max: number): string {
  if (line.length <= max) return line;
  if (max < 12) return "";
  return `${line.slice(0, max - 4)} ...`;
}

/** Drops whole entries rather than cutting one in half, so every entry shown is true. */
function listLine(prefix: string, items: string[], max: number): string {
  if (items.length === 0) return "";
  const full = prefix + items.join(" | ");
  if (full.length <= max) return full;
  for (let kept = items.length - 1; kept >= 1; kept--) {
    const line = `${prefix}${items.slice(0, kept).join(" | ")} | +${items.length - kept} more`;
    if (line.length <= max) return line;
  }
  return clamp(`${prefix}+${items.length} more`, max);
}

/**
 * @param head the header and the ACTION line, in that order. The ACTION line is the
 *   instruction, so it is never shortened; the header is metadata and is the first
 *   thing to give way when an unusually large record leaves no room.
 */
function assemble(
  head: [string, string],
  why: string,
  lists: { prefix: string; items: string[] }[],
  record: Record<string, unknown>,
): string {
  const recordLine = RECORD_PREFIX + JSON.stringify(record);
  const budget = MAX_TEXT - recordLine.length - 1;

  const [header, actionLine] = head;
  const headRoom = budget - actionLine.length - 2;
  const kept = header.length > headRoom ? clamp(header, headRoom) : header;
  const parts = kept ? [kept, actionLine] : [actionLine];
  let used = parts.reduce((n, l) => n + l.length + 1, 0);

  if (why) {
    const line = clamp(`why: ${why}`, Math.min(MAX_WHY, Math.max(0, budget - used)));
    if (line) {
      parts.push(line);
      used += line.length + 1;
    }
  }
  for (const list of lists) {
    const line = listLine(list.prefix, list.items, Math.max(0, budget - used));
    if (line) {
      parts.push(line);
      used += line.length + 1;
    }
  }
  parts.push(recordLine);
  return parts.join("\n");
}

/* --------------------------------------------------------------- outcome */

export function formatOutcome(args: {
  kind: "decide" | "check";
  label: string;
  outcome: DecisionOutcome;
  ctx: FormatCtx;
  ms: number;
  model: string;
}): { text: string; record: Record<string, unknown> } {
  const { kind, label, outcome, ctx, ms, model } = args;

  // Field names match LedgerEntry so the hook can turn this line straight into one.
  const record: Record<string, unknown> = {
    v: 1,
    kind,
    label,
    action: outcome.action,
    declared_stakes: outcome.declaredStakes,
    effective_stakes: outcome.effectiveStakes,
    ms,
    model,
  };
  if (outcome.choice !== undefined) record.choice = outcome.choice;
  if (outcome.p1 !== undefined) record.p1 = round4(outcome.p1);
  if (outcome.margin !== undefined) record.margin = round4(outcome.margin);
  if (outcome.confidence !== undefined) record.confidence = round4(outcome.confidence);
  if (outcome.checks.length) {
    record.checks = outcome.checks.map((c) => ({ id: c.id, p: round4(c.p), verdict: c.verdict }));
  }
  if (outcome.scores.length) {
    record.scores = outcome.scores.map((s) => ({
      id: s.id,
      score: round4(s.score),
      status: s.status,
    }));
  }

  const bits: string[] = [];
  if (outcome.confidence !== undefined) bits.push(`conf ${f2(outcome.confidence)}`);
  if (outcome.p1 !== undefined) bits.push(`p ${f2(outcome.p1)}`);
  if (outcome.margin !== undefined) bits.push(`margin ${f2(outcome.margin)}`);
  bits.push(
    outcome.effectiveStakes === outcome.declaredStakes
      ? `stakes ${outcome.effectiveStakes}`
      : `stakes ${outcome.effectiveStakes}(declared ${outcome.declaredStakes})`,
  );
  bits.push(ctx.authority);

  const subject = outcome.choice === undefined ? "" : ` -> ${outcome.choice}`;
  const header = `JEV ${kind}[${label}]${subject}   ${bits.join(" - ")}`;
  const actionLine = `ACTION ${outcome.action}: ${actionSentence(outcome.action, ctx, kind)}`;

  const probabilities = Object.entries(outcome.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, p]) => `${id} ${f2(p)}`);
  const checks = outcome.checks.map(
    (c) => `${c.id} -> ${c.verdict} (${f2(c.p)}) ${c.blocking ? "BLOCKING" : "ok"}`,
  );
  const scores = outcome.scores.map(
    (s) => `${s.id} ${f2(s.score)}${s.minLevel === undefined ? "" : `/${s.minLevel}`} ${s.status}`,
  );

  const text = assemble(
    [header, actionLine],
    outcome.rationale,
    [
      { prefix: "probabilities: ", items: probabilities },
      { prefix: "checks: ", items: checks },
      { prefix: "scores: ", items: scores },
    ],
    record,
  );
  return { text, record };
}

/* ----------------------------------------------------------- unavailable */

export function formatUnavailable(args: {
  kind: "decide" | "check";
  label: string;
  failure: JevFailure;
  ctx: FormatCtx;
  fail: FailMode;
}): { text: string; record: Record<string, unknown> } {
  const { kind, label, failure, ctx } = args;
  const action: Action = args.fail === "closed" ? "escalate_to_user" : "proceed_unverified";

  const record: Record<string, unknown> = {
    v: 1,
    kind,
    label,
    action,
    error: failure.code,
  };

  const header = `JEV ${kind}[${label}] -> unavailable   ${failure.code} - ${ctx.authority}`;
  const actionLine = `ACTION ${action}: ${actionSentence(action, ctx, kind)}`;

  const hint =
    failure.code === "no_api_key"
      ? ` Export TYPESAFE_API_KEY (get one from ${KEY_URL}) or run jev-doctor set-key, then call again.`
      : failure.userFixable
        ? " Fix it and call again; until then this decision is yours."
        : "";
  // The message is the variable part; clamping it keeps the fix visible.
  const why = `${clamp(failure.message, 160)}${hint}`;

  return { text: assemble([header, actionLine], why, [], record), record };
}
