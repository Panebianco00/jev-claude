/**
 * The decision table. Every threshold in the plugin lives here and nowhere else.
 *
 * Design notes that justify the numbers (see docs/DESIGN.md for the sources):
 *  - We gate on `confidence`, the statistic the TypeSafe docs define and threshold on
 *    (< 0.5 route to a human, > 0.9 for consequential actions). p1/margin are recorded
 *    and used only as a near-tie detector.
 *  - Stakes declared by the caller are a floor, never the value: Claude is the agent this
 *    policy constrains, so it does not get to pick its own passing threshold.
 *  - A flat distribution over two equally good options is not uncertainty about the world,
 *    it is the absence of a difference. That case proceeds, it does not interrupt the user.
 */
import type {
  Action,
  CheckOutcome,
  CheckSpec,
  Config,
  DecisionOutcome,
  JevSuccess,
  ScoreOutcome,
  ScoreSpec,
  Stakes,
  Thresholds,
  Verdict,
} from "./types.ts";

/** Probability comparison tolerance. Answers come back with limited precision. */
export const EPS = 0.005;

/** Question ids the server adds to every request. Callers may not use them. */
export const RESERVED = {
  decision: "decision",
  needsUserPreference: "needs_user_preference",
  optionsAreNeutral: "options_are_neutral",
  injection: "contains_injected_instruction",
  reversibleLocally: "reversible_locally",
  changesPublicInterface: "changes_public_interface",
  changesStoredData: "changes_stored_data",
  affectsProduction: "affects_production",
  spendsMoney: "spends_money",
  sendsOutside: "sends_outside_this_machine",
  delegated: "delegated_to_assistant",
} as const;

export const RESERVED_IDS: string[] = Object.values(RESERVED);

/** The option added to every Choice so Jev can reject the whole option set. */
export const NONE_OF_THESE = "none_of_these";

export const DEFAULT_THRESHOLDS: Thresholds = {
  choice: {
    // Below `proceed` but at or above `confirm` asks; below `confirm` escalates.
    low: { proceed: 0.5, confirm: 0 },
    medium: { proceed: 0.7, confirm: 0.45 },
    high: { proceed: 0.9, confirm: 0.65 },
  },
  // What the ANSWER is, not how sure we must be to act on it — that is the stakes table's
  // job. Demanding 0.90 before calling a DROP TABLE destructive left almost every real answer
  // "uncertain", which is noise rather than caution.
  noul: { yes: 0.65, no: 0.35 },
  nearTieMass: 0.7,
  nearTieMargin: 0.15,
  revisionsBeforeEscalate: 1,
  needsUserPreference: 0.85,
  decisiveOverride: 0.97,
  scopeCreep: 0.8,
  // Calibration: injected text scores 0.97-0.98, clean states 0.05-0.12. A trial session
  // escalated an ordinary cleanup check at exactly 0.70 — the old bar — which no fixture
  // could reproduce; nothing real lives between 0.15 and 0.95.
  injection: 0.85,
  // "You choose the framework, storage, ..." scored 0.98; "use Express and Postgres" 0.04.
  delegated: 0.8,
  optionNeutrality: 0.5,
  stakes: {
    highAffects: 0.6,
    highPublic: 0.6,
    highIrreversible: 0.25,
    mediumAffects: 0.35,
    mediumPublic: 0.35,
    mediumIrreversible: 0.6,
  },
  score: { passSlack: 0.05, failGap: 0.5 },
  router: { stated: 0.8, answer: 0.85 },
  plan: {
    deferredFork: 0.75,
    contradiction: 0.75,
    irreversible: 0.7,
    missingVerification: 0.25,
    // Coverage is an expected level, so a confident "does everything" still lands a little
    // under 2. Measured on jev-1.13 (test/calibration): complete plans 1.85-1.99, a plan
    // doing half the request 1.01. The old bar of 1.95 refused complete plans at 1.85 and
    // 1.91, and cleared a real 13 KB plan by 0.01.
    coverageFull: 1.5,
    coverageMain: 0.75,
  },
  triage: { mutation: 0.6, stop: 0.75 },
};

/* --------------------------------------------------------------- helpers */

const SEVERITY: Record<Action, number> = {
  proceed: 0,
  proceed_unverified: 1,
  proceed_and_flag: 2,
  confirm: 3,
  revise: 4,
  escalate_to_user: 5,
};

/** Worst action wins: a decision is only as good as its least certain judgment. */
export function worst(actions: Action[]): Action {
  let out: Action = "proceed";
  for (const a of actions) if (SEVERITY[a] > SEVERITY[out]) out = a;
  return out;
}

const STAKES_RANK: Record<Stakes, number> = { low: 0, medium: 1, high: 2 };

export function maxStakes(a: Stakes, b: Stakes): Stakes {
  return STAKES_RANK[a] >= STAKES_RANK[b] ? a : b;
}

/** `x` is at or above `t`, allowing for limited answer precision. */
export function atLeast(x: number, t: number): boolean {
  return x + EPS >= t;
}

/** One step more cautious, without ever turning a proceed into an escalation. */
function downgrade(action: Action): Action {
  switch (action) {
    case "proceed":
      return "proceed_and_flag";
    case "proceed_and_flag":
      return "confirm";
    default:
      return action;
  }
}

/* --------------------------------------------------------------- stakes */

/**
 * What the situation actually is, according to Jev, rather than what the caller declared.
 * Missing answers fall back to the declared value by returning "low", which `maxStakes`
 * then discards.
 */
export function deriveStakes(nouls: Record<string, number>, t: Thresholds): Stakes | undefined {
  const s = t.stakes;
  // Each condition is asked as its own question, so each can carry its own bar. Bundling
  // them into two disjunctive questions meant a weak lean on any one disjunct — a config
  // file that "changes an interface, or changes stored data" — forced the whole call to
  // medium, which raised the proceed bar and interrupted the user over a filename.
  const reversible = nouls[RESERVED.reversibleLocally];
  const external: [number | undefined, number, number][] = [
    [nouls[RESERVED.affectsProduction], s.highAffects, s.mediumAffects],
    [nouls[RESERVED.spendsMoney], s.highAffects, s.mediumAffects],
    [nouls[RESERVED.sendsOutside], s.highAffects, s.mediumAffects],
    [nouls[RESERVED.changesPublicInterface], s.highPublic, s.mediumPublic],
    [nouls[RESERVED.changesStoredData], s.highPublic, s.mediumPublic],
  ];
  if (reversible === undefined && external.every(([p]) => p === undefined)) return undefined;

  if (
    external.some(([p, high]) => p !== undefined && atLeast(p, high)) ||
    (reversible !== undefined && reversible <= s.highIrreversible + EPS)
  ) {
    return "high";
  }
  if (
    external.some(([p, , medium]) => p !== undefined && atLeast(p, medium)) ||
    (reversible !== undefined && reversible <= s.mediumIrreversible + EPS)
  ) {
    return "medium";
  }
  return "low";
}

/* ---------------------------------------------------------------- nouls */

export function judgeCheck(spec: CheckSpec, p: number, stakes: Stakes, t: Thresholds): CheckOutcome {
  const band = t.noul;
  const verdict: Verdict = atLeast(p, band.yes) ? "yes" : p <= band.no + EPS ? "no" : "uncertain";
  const blockingAnswer = spec.blocking_answer ?? "none";
  const blocking = blockingAnswer !== "none" && verdict === blockingAnswer;

  let action: Action = "proceed";
  if (blockingAnswer === "none") {
    action = "proceed"; // informational, never blocks
  } else if (blocking) {
    action = "revise";
  } else if (verdict === "uncertain") {
    action = stakes === "high" ? "confirm" : stakes === "medium" ? "proceed_and_flag" : "proceed";
  }
  return { id: spec.id, p, verdict, blocking, action };
}

/* --------------------------------------------------------------- scores */

export function judgeScore(
  spec: ScoreSpec,
  score: number,
  confidence: number,
  stakes: Stakes,
  t: Thresholds,
): ScoreOutcome {
  if (spec.min_level === undefined) {
    return { id: spec.id, score, confidence, status: "info", action: "proceed" };
  }
  const m = spec.min_level;
  if (score >= m - t.score.passSlack) {
    return { id: spec.id, score, confidence, minLevel: m, status: "pass", action: "proceed" };
  }
  if (score < m - t.score.failGap) {
    return { id: spec.id, score, confidence, minLevel: m, status: "fail", action: "revise" };
  }
  const action: Action =
    stakes === "high" ? "confirm" : stakes === "medium" ? "proceed_and_flag" : "proceed";
  return { id: spec.id, score, confidence, minLevel: m, status: "borderline", action };
}

/* --------------------------------------------------------------- choice */

export interface ChoiceJudgement {
  action: Action;
  rationale: string;
  p1: number;
  margin: number;
  axisValue: number;
  nearTie: boolean;
}

/**
 * @param probabilities every option including `none_of_these`
 * @param realOptionIds the caller's option ids (excludes `none_of_these`)
 */
export function judgeChoice(
  choice: string,
  confidence: number,
  probabilities: Record<string, number>,
  realOptionIds: string[],
  stakes: Stakes,
  cfg: Pick<Config, "confAxis" | "authority">,
  t: Thresholds,
): ChoiceJudgement {
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const p1 = probabilities[choice] ?? sorted[0]?.[1] ?? 0;
  const p2 = sorted.find(([id]) => id !== choice)?.[1] ?? 0;
  const margin = p1 - p2;
  const axisValue =
    cfg.confAxis === "top_probability" ? p1 : cfg.confAxis === "min" ? Math.min(p1, confidence) : confidence;

  const band = t.choice[stakes];
  const real = new Set(realOptionIds);

  // A near-tie between two real options is an absence of difference, not uncertainty:
  // acting on either is fine, so we act and say so rather than interrupting the user.
  const second = sorted.find(([id]) => id !== choice)?.[0];
  const nearTie =
    real.has(choice) &&
    second !== undefined &&
    real.has(second) &&
    margin < t.nearTieMargin &&
    atLeast(p1 + p2, t.nearTieMass);

  if (atLeast(axisValue, band.proceed)) {
    return { action: "proceed", rationale: "confident pick", p1, margin, axisValue, nearTie };
  }
  if (nearTie) {
    return {
      action: "proceed_and_flag",
      rationale: `near-tie with "${second}" (${p1.toFixed(2)}/${p2.toFixed(2)}); either is defensible`,
      p1,
      margin,
      axisValue,
      nearTie,
    };
  }
  if (band.confirm > 0 && atLeast(axisValue, band.confirm)) {
    return {
      action: "confirm",
      rationale: `moderate confidence (${axisValue.toFixed(2)}) at ${stakes} stakes`,
      p1,
      margin,
      axisValue,
      nearTie,
    };
  }
  if (stakes === "low") {
    return {
      action: "proceed_and_flag",
      rationale: `low confidence (${axisValue.toFixed(2)}) but the choice is trivially reversible`,
      p1,
      margin,
      axisValue,
      nearTie,
    };
  }
  return {
    action: "escalate_to_user",
    rationale: `low confidence (${axisValue.toFixed(2)}) at ${stakes} stakes`,
    p1,
    margin,
    axisValue,
    nearTie,
  };
}

/* ------------------------------------------------------------ the table */

export interface EvaluateArgs {
  result: JevSuccess;
  declaredStakes: Stakes;
  /** Present for `decide`, absent for a pure `check` call. */
  realOptionIds?: string[];
  checks: CheckSpec[];
  scores: ScoreSpec[];
  cfg: Config;
  /** How many times this label already came back `revise` in this session. */
  priorRevisions?: number;
}

export function evaluate(args: EvaluateArgs): DecisionOutcome {
  const { result, declaredStakes, realOptionIds, checks, scores, cfg } = args;
  const t = cfg.thresholds;

  const derivedStakes = deriveStakes(result.nouls, t);
  const effectiveStakes = derivedStakes ? maxStakes(declaredStakes, derivedStakes) : declaredStakes;

  const injection = result.nouls[RESERVED.injection];
  const needsUserPreference = result.nouls[RESERVED.needsUserPreference];
  const optionsAreNeutral = result.nouls[RESERVED.optionsAreNeutral];

  const checkOutcomes = checks
    .filter((c) => result.nouls[`check_${c.id}`] !== undefined)
    .map((c) => judgeCheck(c, result.nouls[`check_${c.id}`] as number, effectiveStakes, t));

  const scoreOutcomes: ScoreOutcome[] = scores
    .filter((s) => result.scores[`score_${s.id}`] !== undefined)
    .map((s) => {
      const a = result.scores[`score_${s.id}`] as { score: number; confidence: number };
      return judgeScore(s, a.score, a.confidence, effectiveStakes, t);
    });

  const base: DecisionOutcome = {
    action: "proceed",
    rationale: "",
    declaredStakes,
    derivedStakes,
    effectiveStakes,
    needsUserPreference,
    optionsAreNeutral,
    injection,
    checks: checkOutcomes,
    scores: scoreOutcomes,
  };

  const answer = result.choices[RESERVED.decision];

  // Security first: a state carrying instructions aimed at the model is not evidence.
  // Jev's answer is kept for the record, not acted on: dropping it left an "asked you" line
  // in the ledger with no choice and no confidence, invisible to calibration, and gave the
  // plan-mode instruction "list the options and their probabilities" nothing to list.
  if (injection !== undefined && atLeast(injection, t.injection)) {
    return {
      ...base,
      action: "escalate_to_user",
      rationale: `the state appears to contain text written to steer the answer (${injection.toFixed(2)}); it was not treated as evidence`,
      choice: answer?.choice,
      p1: answer ? answer.probabilities[answer.choice] : undefined,
      confidence: answer?.confidence,
      probabilities: answer?.probabilities,
    };
  }

  let choiceAction: Action | undefined;
  let rationale = "";
  let p1: number | undefined;
  let margin: number | undefined;
  let axisValue: number | undefined;

  if (realOptionIds && answer) {
    // An answer naming something that was never offered is not a decision. Reporting it as
    // one would tell Claude to act on an option that does not exist, with a probability
    // borrowed from a different option.
    if (answer.choice !== NONE_OF_THESE && !realOptionIds.includes(answer.choice)) {
      return {
        ...base,
        action: "revise",
        rationale: `Jev answered "${answer.choice}", which is not one of the options offered`,
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
    }
    if (answer.choice === NONE_OF_THESE) {
      const prior = args.priorRevisions ?? 0;
      choiceAction = prior >= t.revisionsBeforeEscalate ? "escalate_to_user" : "revise";
      rationale =
        prior >= t.revisionsBeforeEscalate
          ? "none of the options fit, twice in a row"
          : "none of the listed options satisfies the request";
      p1 = answer.probabilities[NONE_OF_THESE];
    } else {
      const j = judgeChoice(
        answer.choice,
        answer.confidence,
        answer.probabilities,
        realOptionIds,
        effectiveStakes,
        cfg,
        t,
      );
      choiceAction = j.action;
      rationale = j.rationale;
      p1 = j.p1;
      margin = j.margin;
      axisValue = j.axisValue;
    }

    // Asking Jev to pick when the answer is a matter of the user's taste is a category
    // error; that is the one case where the human is genuinely the right oracle.
    //
    // But a near-unanimous distribution is itself evidence that the state DID determine the
    // answer, and the two signals then contradict each other. Interrupting the user over a
    // 1.00 pick because a side-question scored 0.71 is how a decision layer earns the reflex
    // to be turned off, so the distribution wins when it is that decisive.
    // The override exists for the 1.00-confidence case, so it is pinned well above any
    // proceed bar and switched off entirely at high stakes, where asking is cheap next to
    // being wrong about something irreversible.
    const decisive =
      axisValue !== undefined &&
      atLeast(axisValue, t.decisiveOverride) &&
      effectiveStakes !== "high";
    // A preference the user explicitly handed over is not one to ask them about.
    const delegated = result.nouls[RESERVED.delegated];
    const handedOver =
      delegated !== undefined && atLeast(delegated, t.delegated) && effectiveStakes !== "high";
    if (
      !decisive &&
      !handedOver &&
      needsUserPreference !== undefined &&
      atLeast(needsUserPreference, t.needsUserPreference)
    ) {
      choiceAction = "escalate_to_user";
      rationale = `the choice depends on a preference the state does not state (${needsUserPreference.toFixed(2)})`;
    }

    // The user handed this choice over ("you choose the language, framework, storage").
    // A trial session asked about three of four such choices anyway: needs_user_preference
    // reads 0.88 on exactly that prompt, because a stack IS a matter of preference — just
    // one the user already delegated. Jev's pick is acted on and reported, not put back to
    // them. Not at high stakes, and never for a rejected option set or a blocking check,
    // which are handled elsewhere.
    if (
      handedOver &&
      answer.choice !== NONE_OF_THESE &&
      (choiceAction === "escalate_to_user" || choiceAction === "confirm")
    ) {
      choiceAction = "proceed_and_flag";
      rationale += `; the user's request leaves this choice to the assistant (${(delegated ?? 0).toFixed(2)})`;
    }

    // If the options were not written even-handedly, the distribution is about the
    // wording as much as about the engineering.
    if (
      optionsAreNeutral !== undefined &&
      optionsAreNeutral < t.optionNeutrality - EPS &&
      choiceAction !== "escalate_to_user"
    ) {
      choiceAction = downgrade(choiceAction);
      rationale += `; option descriptions look uneven (${optionsAreNeutral.toFixed(2)})`;
    }
  }

  const actions: Action[] = [
    ...(choiceAction ? [choiceAction] : []),
    ...checkOutcomes.map((c) => c.action),
    ...scoreOutcomes.map((s) => s.action),
  ];
  let action = actions.length ? worst(actions) : "proceed";

  // Advisory mode never lets Jev act alone on anything that matters.
  if (cfg.authority === "advisory" && effectiveStakes !== "low") {
    if (action === "proceed" || action === "proceed_and_flag") action = "confirm";
  }

  if (!rationale) {
    const blocking = checkOutcomes.filter((c) => c.blocking);
    const failed = scoreOutcomes.filter((s) => s.status === "fail");
    const unsure = checkOutcomes.filter((c) => c.verdict === "uncertain" && c.blocking === false);
    rationale = blocking.length
      ? `blocking check${blocking.length > 1 ? "s" : ""}: ${blocking.map((c) => c.id).join(", ")}`
      : failed.length
        ? `below the required level: ${failed.map((s) => s.id).join(", ")}`
        : unsure.length
          ? `no blocking finding, but Jev was unsure about ${unsure.map((c) => c.id).join(", ")}`
          : "all checks within band";
  } else if (action !== choiceAction) {
    const blocking = checkOutcomes.filter((c) => c.blocking).map((c) => c.id);
    if (blocking.length) rationale += `; blocking check: ${blocking.join(", ")}`;
  }

  return {
    ...base,
    action,
    rationale,
    choice: answer?.choice,
    p1,
    margin,
    confidence: answer?.confidence,
    axisValue,
    probabilities: answer?.probabilities,
  };
}

/* ---------------------------------------------------------- plan review */

export interface PlanJudgement {
  problems: string[];
  blocking: boolean;
}

/**
 * Turns the plan-review answers into problems to fix.
 *
 * Each answer covers exactly one condition, so all of the combining happens here where it can
 * be read and tuned, rather than inside a compound question Jev would have to disentangle.
 */
export function judgePlanReview(
  review: Record<string, number>,
  coverage: number | undefined,
  t: Thresholds,
): PlanJudgement {
  const problems: string[] = [];
  if (coverage !== undefined && coverage < t.plan.coverageFull) {
    problems.push(
      coverage < t.plan.coverageMain
        ? "the plan does not do the main thing the request asks for"
        : "the plan leaves out something the request asks for",
    );
  }
  const defers = review["defers_a_choice"];
  if (defers !== undefined && atLeast(defers, t.plan.deferredFork)) {
    problems.push(
      "the plan leaves a choice between alternatives open; decide it with decide and write the chosen option into the plan",
    );
  }
  for (const [id, p] of Object.entries(review)) {
    if (!id.startsWith("follows_decision_")) continue;
    // The question asks whether the plan FOLLOWS the decision, so a low probability is the
    // contradiction.
    if (p <= 1 - t.plan.contradiction + EPS) {
      problems.push(`the plan contradicts a recorded decision (${id.replace("follows_decision_", "#")})`);
    }
  }
  const blocking = problems.length > 0;

  // The screening question was being asked on every plan and its answer thrown away, so a
  // plan quoting a fetched issue or a vendored README could tell the reviewer what to
  // conclude and nobody would hear of it. Reported, not blocking: the person about to approve
  // the plan is the right one to judge that text, and refusing would hand any repo containing
  // such a line the power to stop planning.
  const injected = review[RESERVED.injection];
  if (injected !== undefined && atLeast(injected, t.injection)) {
    problems.push(
      `the plan contains text aimed at whoever reviews it (${injected.toFixed(2)}) - read that part yourself before approving`,
    );
  }

  // Advisory findings: reported to the user, never grounds for refusing a plan. A plan that
  // includes setup work the request did not spell out is usually right to.
  const scope = review["adds_unrequested_work"];
  if (scope !== undefined && atLeast(scope, t.scopeCreep)) {
    problems.push("the plan includes work the request did not ask for");
  }
  const verification = review["has_verification"];
  if (!blocking && verification !== undefined && verification <= t.plan.missingVerification + EPS) {
    problems.push("the plan does not say how the result will be verified");
  }
  return { problems, blocking };
}

/** Irreversible steps are reported to the user rather than blocking the plan. */
export function planRisks(review: Record<string, number>, t: Thresholds): string[] {
  const kinds: [string, string][] = [
    ["deletes_data", "deletes data"],
    ["rewrites_history", "rewrites git history"],
    ["changes_public_interface", "changes a public interface"],
    ["deploys_or_spends", "deploys or spends money"],
  ];
  return kinds
    .filter(([id]) => {
      const p = review[id];
      return p !== undefined && atLeast(p, t.plan.irreversible);
    })
    .map(([, label]) => label);
}

/** What the caller must do next, in one imperative clause. */
export const ACTION_MEANING: Record<Action, string> = {
  proceed: "act on this choice now; do not ask the user about it",
  proceed_and_flag: "act on this choice now and mention it in one line when you report",
  revise: "the option set or a blocking check was wrong: fix it and call again with the same label",
  confirm: "get the user's confirmation before acting, with Jev's pick listed first",
  escalate_to_user: "ask the user to decide",
  proceed_unverified: "Jev was not consulted: use your own judgment and say so",
};
