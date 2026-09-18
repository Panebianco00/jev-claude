import { redactText } from "../shared/redact.ts";
import { REMINDER, REMINDER_PLAN } from "../shared/protocol.ts";
import type { HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/**
 * How many consecutive decision-free turns pass before the reminder comes back. One: the
 * reminder is a single line now, so the accumulation cost is small, while three quiet turns
 * was most of an ordinary task going by without a nudge.
 */
const QUIET_TURNS = 1;

/**
 * Records what the user actually asked, which every later Jev request carries verbatim so a
 * summarised state cannot quietly reframe the question.
 *
 * The reminder is deliberately not emitted every turn: each copy is wrapped as a system
 * reminder and stays in the conversation, so an unconditional one would accumulate dozens of
 * near-identical paragraphs and lose its force exactly as it gained bulk.
 */
export function userPromptSubmit({ input, cfg, store }: HookCtx): HookOutput | undefined {
  const text = typeof input.prompt === "string" ? input.prompt : "";
  store.ensureDirs();
  if (!isUserRequest(text)) return undefined;
  store.appendPrompt({
    v: 1,
    ts: Date.now(),
    prompt_id: input.prompt_id,
    agent_id: input.agent_id,
    permission_mode: input.permission_mode,
    text: redactText(text).slice(0, 4000),
  });

  if (cfg.enforcement === "off") return undefined;
  if (text.startsWith("/")) return undefined; // a command with arguments: recorded, not nagged

  const isPlan = input.permission_mode === "plan";
  if (!isPlan && !quiet(store)) return undefined;

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: isPlan ? REMINDER_PLAN : REMINDER,
    },
  };
}

/** Wrappers Claude Code delivers through UserPromptSubmit that the user did not type. */
const HARNESS_ENVELOPE =
  /^\s*<(task-notification|system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|bash-input|bash-stdout|bash-stderr)\b/;

/**
 * Whether this prompt is something the user asked for, and so belongs in the record every
 * later Jev request quotes as "what the user asked".
 *
 * Recorded unfiltered, a background agent's completion notice became the user's request: a
 * 2000-character block of tool output, long enough to trip the injection screen, which then
 * escalated an ordinary decision. A bare `/jev:log` became the request the next plan was
 * reviewed against. A command with arguments is kept: `/review the auth change` is a request.
 */
export function isUserRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (HARNESS_ENVELOPE.test(t)) return false;
  if (/^\/[\w:.-]+$/.test(t)) return false;
  return true;
}

/** True when the last few turns produced no Jev consultation at all. */
function quiet(store: HookCtx["store"]): boolean {
  const prompts = store.prompts();
  if (prompts.length <= 1) return true; // first turn of the session
  const recent = prompts.slice(-(QUIET_TURNS + 1), -1);
  if (recent.length < QUIET_TURNS) return false; // too early to call the session quiet
  const since = recent[0]?.ts ?? 0;
  return !store.ledger().some((e) => e.ts >= since);
}
