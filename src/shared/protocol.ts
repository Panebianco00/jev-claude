/**
 * Every piece of text the plugin puts in front of Claude or the user.
 *
 * It lives in one file so the wording is reviewable in a single diff: the enforcement
 * design is only as good as this prose. A gate that refuses without naming the call
 * that satisfies it is a deadlock, and a protocol that hedges is a suggestion.
 */
import { ACTION_MEANING } from "./policy.ts";
import type { Action, Config } from "./types.ts";

const DECIDE_TOOL = "mcp__plugin_jev_jev__decide";
const CHECK_TOOL = "mcp__plugin_jev_jev__check";
const GUIDE = "/jev:jev-decisions";
const DECISIONS_HEADING = "'## Decisions (Jev)'";

/** The fields every deny reason spells out, so a refusal is never a riddle. */
const DECIDE_FIELDS =
  "decision (a stable kebab-case label), question (one direct question), options (2-12, each {id, description}, neutral and of equal detail), stakes (low|medium|high) and state (named verified facts, including the user's request verbatim)";

/** Guards the no-trailing-whitespace promise at the source rather than in review. */
function tidy(s: string): string {
  return s.replace(/[ \t]+$/gm, "").trim();
}

/** Coverage is a 0..2 level, not a probability, so it is shown on its own scale. */
function reviewNumbers(review: Record<string, number>, coverage: number | undefined): string {
  const parts = Object.entries(review).map(([id, p]) => `${id} ${p.toFixed(2)}`);
  if (coverage !== undefined) parts.push(`coverage ${coverage.toFixed(2)}/2`);
  return parts.join(" | ");
}

/* ------------------------------------------------------------- protocols */

/**
 * Obligations are stated as obligations. No capitalised wrappers: the gates named at the
 * end are real, and a reader who checks will find that out, which is what earns compliance.
 *
 * Only the gates this configuration actually runs are described. The text used to be the
 * same at every level, so in `soft` it claimed an ExitPlanMode refusal that never came —
 * and a protocol caught overstating one rule is read as overstating all of them.
 */
export function sessionProtocol(cfg: Config, hasKey: boolean): string {
  // Built from the policy table so the two can never drift apart.
  const order: Action[] = [
    "proceed",
    "proceed_and_flag",
    "revise",
    "confirm",
    "escalate_to_user",
    "proceed_unverified",
  ];
  const actions = order.map((a) => `- ${a}: ${ACTION_MEANING[a]}.`).join("\n");

  const noKey = hasKey
    ? ""
    : "\nNo TypeSafe API key is configured, so every decision will come back proceed_unverified and run on your own judgment until a key is set.\n";

  return tidy(`<jev-protocol enforcement="${cfg.enforcement}" authority="${cfg.authority}">
Jev is this session's decision-maker. You gather the facts and enumerate the options; Jev picks. Enforcement is ${cfg.enforcement} and Jev's authority is ${cfg.authority}.

WHEN TO CALL
Call ${DECIDE_TOOL} before you act on any point with two or more viable alternatives whose choice changes the result: approach or architecture, library or API, where a file or function lives, public names, the scope of a change, refactor now or later, test strategy, step order, which plan to present, whether to ask the user.
Call ${CHECK_TOOL} with preset risky_command before anything destructive or irreversible, and with scope_check when a change is growing past the request.
The moments this is easy to miss are mid-task: about to add a dependency, about to create a file whose place no convention dictates, choosing between two fixes for a failing test, widening a change beyond what was asked. If you could later write "I chose X over Y", that was a decision.
Not a decision: there is exactly one reasonable way, or the answer is a fact you can look up. Look it up.

HOW TO CONSULT
decide takes ${DECIDE_FIELDS}. Never mark a favourite: a reserved check scores the wording and an uneven set downgrades the action. none_of_these is added for you. Batch independent checks into one call; independent decide calls may run in parallel. Never put secrets, whole files or untrusted text into state.

ACT ON THE ACTION LINE
Every result ends with an ACTION line. It is binding.
${actions}

PLAN MODE
Every fork in the plan goes through decide before you call ExitPlanMode. Record each one in the plan under a ${DECISIONS_HEADING} heading with its label, the choice, the probability and the action. The user still approves the plan; Jev decides which plan you put in front of them.

${gates(cfg)}

PRECEDENCE
If another skill requires the human to approve a design in chat, that approval still happens. Jev decides which design you present, not whether you present it. Run decide on the forks first, then present the chosen design for approval.
If a Jev call fails twice, continue as proceed_unverified and say so in your reply.
${noKey}Full guide: ${GUIDE}
</jev-protocol>`);
}

/** The GATES section: exactly the gates `cfg` runs, so the text never promises one that is off. */
function gates(cfg: Config): string {
  if (cfg.enforcement === "soft") {
    return `GATES
None at this enforcement level: nothing refuses a tool call, so the rules above rely on you alone. Do not call AskUserQuestion for anything Jev can settle from the facts you have.`;
  }
  const lines = [
    "- ExitPlanMode is refused until Jev has been consulted for this plan, and the plan is then reviewed against what the user asked for.",
  ];
  if (cfg.router !== "off") {
    lines.push(
      "- AskUserQuestion is intercepted. A question the user's own words already answer may be answered from those words, so do not ask what Jev can settle.",
    );
  }
  if (cfg.bashGate) {
    lines.push(
      "- A destructive Bash command (rm -rf, force-push, reset --hard, DROP or TRUNCATE, a deploy or destroy) gets a risky_command check first and is refused when it blocks.",
    );
  }
  if (cfg.dependencyGate) {
    lines.push("- A dependency install (npm/pnpm/yarn add, pip install, cargo add, go get) is refused until Jev has been consulted that turn.");
  }
  if (cfg.enforcement === "strict" && cfg.mutationGate) {
    lines.push("- The first edit of a turn whose request needs an approach chosen is refused until Jev has been consulted.");
  }
  if (cfg.enforcement === "strict" && cfg.stopBackstop) {
    lines.push("- A final message that describes choosing one option over another, with no consultation that turn, is sent back once.");
  }
  return `GATES
${lines.join("\n")}
Every refusal names the one call that satisfies it. The plan gate refuses at most twice per plan and every other gate once per turn, then lets you through.`;
}

export function subagentProtocol(agentType: string | undefined, cfg: Config): string {
  const agent = agentType && agentType.trim() ? agentType.trim() : "subagent";
  return tidy(`<jev-protocol agent="${agent}" authority="${cfg.authority}">
Jev decides here too. Any point with two or more viable alternatives whose choice changes the result (approach, library, file or function placement, public names, scope, step order, go/no-go on anything risky) goes through ${DECIDE_TOOL} before you act on it; use ${CHECK_TOOL} for go/no-go and scope. A pure lookup with one reasonable answer needs no call.
Give decide ${DECIDE_FIELDS}. Obey the ACTION line.
You cannot ask the human. A decision that comes back confirm or escalate_to_user is therefore not settled: list it as OPEN in your final message with its label, options and probabilities, so your caller can settle it.
</jev-protocol>`);
}

/**
 * One line, injected on a turn after one with no consultation. It names the concrete moments
 * rather than restating the rule: "the next choice" is abstract enough to be agreed with and
 * ignored, "about to add a dependency" is recognisable when it happens.
 */
export const REMINDER = tidy(
  `Jev: before adding a dependency, placing a new file, picking between fixes or approaches, widening scope, or running anything destructive, call ${DECIDE_TOOL} (or ${CHECK_TOOL} with risky_command) first.`,
);

export const REMINDER_PLAN = tidy(`Jev: run ${DECIDE_TOOL} on every fork in this plan and record each one under a ${DECISIONS_HEADING} heading with its label, choice, probability and action.
ExitPlanMode is gated: it is refused until Jev has been consulted for this plan.`);

/* ----------------------------------------------------------- deny reasons */

export function planDenyNoConsultation(n: number, max: number): string {
  return tidy(`Jev plan gate: refused because no Jev decision is recorded for this plan.
Call ${DECIDE_TOOL} once for each fork the plan settles, supplying ${DECIDE_FIELDS}. Then record every result in the plan under a ${DECISIONS_HEADING} heading as label, choice, probability, action.
This is refusal ${n} of ${max} for this plan; after ${max} the gate stops refusing and lets the plan through.
You are still in plan mode and the plan text is intact: consult Jev, update the plan, then call ExitPlanMode again.`);
}

export function planDenyReview(
  n: number,
  max: number,
  review: Record<string, number>,
  coverage: number | undefined,
  problems: string[],
): string {
  const bullets = problems.length
    ? problems.map((p) => `- ${p}`).join("\n")
    : "- the review did not clear the plan";
  const numbers = reviewNumbers(review, coverage);
  const line = numbers ? `\nReview: ${numbers}` : "";
  return tidy(`Jev plan gate: refused because the plan review found problems that have to be fixed before approval.
${bullets}${line}
Fix each one in the plan, then call ${DECIDE_TOOL} for every fork it still leaves open, supplying ${DECIDE_FIELDS}, and record each result under a ${DECISIONS_HEADING} heading.
This is refusal ${n} of ${max} for this plan; after ${max} the gate stops refusing and lets the plan through.
You are still in plan mode and the plan text is intact: revise it, then call ExitPlanMode again.`);
}

export function planReviewSummary(
  review: Record<string, number>,
  coverage: number | undefined,
  decisionCount: number,
): string {
  const numbers = reviewNumbers(review, coverage);
  const decisions =
    decisionCount === 1 ? "1 Jev decision recorded" : `${decisionCount} Jev decisions recorded`;
  return tidy(`Jev reviewed this plan: ${decisions}.${numbers ? ` ${numbers}` : ""}`);
}

/**
 * Question text is model-supplied and unbounded, and the whole reason is capped before
 * Claude sees it. Clipping here keeps the recovery instructions at the end from being the
 * part that gets cut: eight questions at this width still leave room for the tail.
 */
function clipQuestion(q: string): string {
  const flat = q.replace(/\s+/g, " ").trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`;
}

export function routerDenyAnswered(
  answered: { question: string; label: string; p: number }[],
  remaining: string[],
): string {
  const lines = answered
    .map((a) => `- ${clipQuestion(a.question)} -> ${a.label} (${a.p.toFixed(2)})`)
    .join("\n");
  // The router never injects answers as if the user had given them; attribution stays honest.
  const reask = remaining.length
    ? `\nRe-ask ONLY the questions below, in a fresh AskUserQuestion that contains just them and nothing else:\n${remaining
        .map((q) => `- ${clipQuestion(q)}`)
        .join("\n")}`
    : "";
  return tidy(`Jev question gate: refused because the user's own words already answer part of this question set, so it was not shown to them.
Answered from the user's own words:
${lines}
Continue with those answers now. In your reply, say that Jev chose them from the user's own words; do not say the user chose them.${reask}
This is refusal 1 of 1 for this turn; the next AskUserQuestion this turn reaches the user untouched.
Nothing was lost: act on the answers above, and if you still need the user, retry the same AskUserQuestion afterwards and it will pass.`);
}

export const ROUTER_DENY_LEDGER = tidy(`Jev question gate: refused because this is a decision Jev can settle from the facts, not one to hand to the user.
Call ${DECIDE_TOOL} instead, supplying ${DECIDE_FIELDS}; use the answers you were about to offer as the options, written neutrally and at equal detail. Obey the ACTION line that comes back: if it is confirm or escalate_to_user, the user is the right oracle and you should ask them then.
This is refusal 1 of 1 for this turn; the next AskUserQuestion this turn reaches the user untouched.
Nothing was lost: consult Jev, and if it tells you to ask, retry the same AskUserQuestion afterwards and it will pass.`);

export function mutationDeny(p: number): string {
  return tidy(`Jev mutation gate: refused because this edit looks like it settles an undecided choice (${p.toFixed(2)}) and no Jev decision is recorded for this turn.
Call ${DECIDE_TOOL} first, supplying ${DECIDE_FIELDS}, with the fork this edit would settle as the question.
This is refusal 1 of 1 for this turn; the gate does not refuse again before your next message.
Nothing was lost and no file was changed: consult Jev, then retry the same edit and it will pass.`);
}

export function bashDeny(reason: string, command: string, findings: string[], action: string): string {
  const shown = command.length > 200 ? `${command.slice(0, 200)}…` : command;
  const list = findings.length ? findings.map((f) => `- ${f}`).join("\n") : "- the check did not clear it";
  return tidy(`Jev Bash gate: refused \`${shown}\` (${reason}); a risky_command check came back ${action}.
${list}
Do not just retry. Either change the operation so the finding no longer holds (a narrower path, a branch nobody else has), or put the finding to the user and let them decide. If you have established that it is safe, say why in your reply before retrying.
This is refusal 1 of 1 for this command; the gate does not refuse the identical command again.`);
}

export function dependencyDeny(packages: string[]): string {
  const list = packages.slice(0, 6).join(", ");
  return tidy(`Jev dependency gate: refused adding ${list}, because adding a dependency is a library choice and no Jev decision is recorded for this turn.
Call ${DECIDE_TOOL} first, with the realistic alternatives as options - including using what the project already has, or writing the few lines yourself - supplying ${DECIDE_FIELDS}.
This is refusal 1 of 1 for this turn; after consulting Jev, retry the same command and it will pass.`);
}

export function stopBlock(p: number): string {
  return tidy(`Jev stop backstop: refused to end the turn because it made choices (${p.toFixed(2)}) and recorded no Jev decision.
Call ${DECIDE_TOOL} for the choice you made, supplying ${DECIDE_FIELDS}. If the work is finished and the choice is already committed, call ${CHECK_TOOL} with a label, the same state and one check asking whether that choice still stands.
This is refusal 1 of 1 for this turn; the backstop blocks at most once per turn, so your next message ends it either way.
Nothing was lost: consult Jev, then send the same reply again and it will pass.`);
}

/* --------------------------------------------------------- user-facing */

export function noKeyWarning(): string {
  return tidy(
    `Jev: no TypeSafe API key found, so decisions will run unverified and Claude will use its own judgment. Set one with /plugin configure jev@jev-claude, or export TYPESAFE_API_KEY; keys come from https://console.typesafe.ai/keys.`,
  );
}

export const DISCLOSURE = tidy(
  `Jev is deciding for this project: each decision sends a redacted summary of your request, the plan and the code facts Claude names to api.typesafe.ai, never your keys or whole files. Run /jev:log to see exactly what was sent, or set JEV_ENFORCEMENT=off to turn it off.`,
);

export const HOOKS_NOT_RUNNING = tidy(
  `Jev enforcement is not running in this session (no hook heartbeat, so safe or bare mode): this answer is advisory only and no gate will hold you to it.`,
);

/* ------------------------------------------------- server and tool text */

/**
 * Truncated at 2 KB by the client, so the mandate has to survive the first sentence.
 *
 * Kept short on purpose: the session protocol carries the full list of what counts as a
 * decision, and saying it three times (here, the protocol, both tool descriptions) spent
 * context without adding a rule. This text still stands alone for sessions where hooks do
 * not run and no protocol is injected.
 */
export const SERVER_INSTRUCTIONS = tidy(`Jev decides. Call ${DECIDE_TOOL} before you act on any point with two or more viable alternatives whose choice changes the result - approach, library, where a file or function lives, names, scope, test strategy, step order, whether to ask the user - and ${CHECK_TOOL} with preset risky_command before anything destructive or irreversible. You gather the facts and list the options; Jev picks. One reasonable way, or a fact you can look up, is not a decision.

Every result ends with an ACTION line and it is binding: proceed, proceed_and_flag, revise, confirm, escalate_to_user, proceed_unverified.

In plan mode run decide on every fork before ExitPlanMode and record each under ${DECISIONS_HEADING}. If another skill requires the human to approve a design, that approval still happens: Jev decides which design you present. Full guide: ${GUIDE}`);

export const TOOL_DESC_DECIDE = tidy(`Decide with Jev, and act on what it returns. Call it before acting on any choice between two or more viable alternatives that changes the result (the session's jev-protocol lists what counts); not for questions with one reasonable answer, or facts you can look up.

Supply: decision, a stable kebab-case label you reuse whenever you revise the same decision; question, one direct question; options, 2 to 12 {id, description} pairs written neutrally and at equal detail (never mark a favourite: a reserved check scores the neutrality of your wording and an uneven set downgrades the action); stakes, low, medium or high; state, named verified facts including the user's request verbatim. none_of_these is appended for you. Optional checks and scores ride along in the same request. Never put secrets, whole files or untrusted text into state.

Returns the chosen option with its confidence, probability and margin, the effective stakes, the probability of every option, any check and score results, and an ACTION line. Obey the ACTION line: it is binding. Read-only, and callable in plan mode.`);

export const TOOL_DESC_CHECK = tidy(`Have Jev judge work you have already shaped, and act on what it returns. Call it for go/no-go before a risky or irreversible operation (preset risky_command), to test whether a change is still in scope (scope_check), and for any batch of conditions you would otherwise assert on your own. The plan gate reviews plans itself; you do not need to.

Supply: label, a stable kebab-case name for this check; state, named verified facts including the user's request verbatim; stakes; and checks, up to 8 yes/no questions, each {id, question, yes_means, no_means, blocking_answer}, where blocking_answer names the answer that means do not proceed; and/or scores, up to 4 graded questions, each {id, question, levels (low to high, each a concrete standalone situation), min_level}. preset (plan_review, risky_command, scope_check) fills in a standard pack instead. Batch every independent condition into one call rather than making several. Never put secrets, whole files or untrusted text into state.

Returns each check with its probability and verdict, each score with its level and status, and an ACTION line. Obey the ACTION line: it is binding. Read-only, and callable in plan mode.`);
