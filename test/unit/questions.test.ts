import { describe, expect, it } from "vitest";
import {
  PLAN_IDS,
  PLAN_IRREVERSIBLE_IDS,
  PLAN_REVIEW_MAX_DECISIONS,
  PRESETS,
  ROUTER_CHOICE_ID,
  ROUTER_MAX_QUESTIONS,
  ROUTER_STATED_ID,
  TRIAGE_MUTATION_ID,
  TRIAGE_STOP_ID,
  ToolInputError,
  buildCheckRequest,
  buildDecideRequest,
  buildPlanReviewRequest,
  buildRouterRequest,
  buildTriageRequest,
  routerOptionKey,
  routerOptionKeys,
  validateCheckInput,
  validateDecideInput,
} from "../../src/shared/questions.ts";
import { NONE_OF_THESE, RESERVED } from "../../src/shared/policy.ts";
import { looksExternal } from "../../src/shared/redact.ts";
import type { BuiltRequest } from "../../src/shared/questions.ts";

/* ------------------------------------------------------------- fixtures */

const GOOD_DECIDE = {
  decision: "validation-library",
  question: "Which validation library should the new request parser use?",
  options: [
    { id: "zod", description: "Already a dependency of the CLI; schemas double as types." },
    { id: "valibot", description: "Smaller bundle, but a new dependency and a new API to learn." },
  ],
  state: { framework: "react", existing_deps: ["zod"] },
  stakes: "low",
};

/** No external-looking key and no long string, so `looksExternal` is false. */
const PLAIN_STATE = { framework: "react", existing_deps: ["zod"] };
/** An external-looking key, so `looksExternal` is true. */
const EXTERNAL_STATE = { framework: "react", readme_excerpt: "Run make install first." };

interface ChoiceShape {
  type: string;
  instructions: string;
  criteria: Record<string, unknown>;
}
interface NoulShape {
  type: string;
  instructions: string;
  criteria?: { true?: unknown; false?: unknown };
}
interface ScoreShape {
  type: string;
  instructions: string;
  criteria: unknown[];
}

function asChoice(q: unknown): ChoiceShape {
  return q as ChoiceShape;
}
function asNoul(q: unknown): NoulShape {
  return q as NoulShape;
}
function asScore(q: unknown): ScoreShape {
  return q as ScoreShape;
}
function ids(built: BuiltRequest): string[] {
  return Object.keys(built.questions);
}

/* ------------------------------------------------------------ validation */

describe("validateDecideInput", () => {
  it("accepts a well-formed input and returns it normalized", () => {
    const out = validateDecideInput(GOOD_DECIDE);
    expect(out.decision).toBe("validation-library");
    expect(out.options).toHaveLength(2);
    expect(out.stakes).toBe("low");
    expect(out.checks).toBeUndefined();
  });

  it("keeps optional checks and scores", () => {
    const out = validateDecideInput({
      ...GOOD_DECIDE,
      checks: [{ id: "adds_dep", question: "Does this add a runtime dependency?", blocking_answer: "none" }],
      scores: [
        {
          id: "risk",
          question: "How risky is this change?",
          levels: ["No risk at all.", "Some risk."],
          min_level: 1,
        },
      ],
    });
    expect(out.checks).toHaveLength(1);
    expect(out.scores?.[0]?.levels).toHaveLength(2);
  });

  const bad: [string, unknown, string][] = [
    ["decision missing", { ...GOOD_DECIDE, decision: undefined }, "decision"],
    ["decision has capitals", { ...GOOD_DECIDE, decision: "Validation-Library" }, "decision"],
    ["decision too short", { ...GOOD_DECIDE, decision: "x" }, "decision"],
    ["question too short", { ...GOOD_DECIDE, question: "which?" }, "question"],
    ["question too long", { ...GOOD_DECIDE, question: "a".repeat(601) }, "question"],
    ["options not an array", { ...GOOD_DECIDE, options: {} }, "options"],
    ["only one option", { ...GOOD_DECIDE, options: [GOOD_DECIDE.options[0]] }, "options"],
    [
      "too many options",
      {
        ...GOOD_DECIDE,
        options: Array.from({ length: 13 }, (_, i) => ({
          id: `opt${i}`,
          description: "A perfectly serviceable alternative.",
        })),
      },
      "options",
    ],
    [
      "duplicate option id",
      { ...GOOD_DECIDE, options: [GOOD_DECIDE.options[0], GOOD_DECIDE.options[0]] },
      "options[1].id",
    ],
    [
      "option id is none_of_these",
      {
        ...GOOD_DECIDE,
        options: [
          { id: NONE_OF_THESE, description: "Something else entirely, thanks." },
          GOOD_DECIDE.options[1],
        ],
      },
      NONE_OF_THESE,
    ],
    [
      "option id is reserved",
      {
        ...GOOD_DECIDE,
        options: [
          { id: RESERVED.needsUserPreference, description: "Something else entirely, thanks." },
          GOOD_DECIDE.options[1],
        ],
      },
      RESERVED.needsUserPreference,
    ],
    [
      "option id has bad characters",
      {
        ...GOOD_DECIDE,
        options: [{ id: "Zod!", description: "Already a dependency here." }, GOOD_DECIDE.options[1]],
      },
      "options[0].id",
    ],
    [
      "option description too short",
      {
        ...GOOD_DECIDE,
        options: [{ id: "zod", description: "short" }, GOOD_DECIDE.options[1]],
      },
      "options[0].description",
    ],
    ["state not an object", { ...GOOD_DECIDE, state: "react" }, "state"],
    ["state empty", { ...GOOD_DECIDE, state: {} }, "state"],
    ["stakes invalid", { ...GOOD_DECIDE, stakes: "urgent" }, "stakes"],
    [
      "too many checks",
      {
        ...GOOD_DECIDE,
        checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, question: "Is this a problem?" })),
      },
      "checks",
    ],
    [
      "duplicate check id",
      {
        ...GOOD_DECIDE,
        checks: [
          { id: "dup", question: "Is this a problem?" },
          { id: "dup", question: "Is this also a problem?" },
        ],
      },
      "checks[1].id",
    ],
    [
      "bad blocking_answer",
      { ...GOOD_DECIDE, checks: [{ id: "c", question: "Is this a problem?", blocking_answer: "maybe" }] },
      "checks[0].blocking_answer",
    ],
    [
      "too many scores",
      {
        ...GOOD_DECIDE,
        scores: Array.from({ length: 5 }, (_, i) => ({
          id: `s${i}`,
          question: "How good is this?",
          levels: ["Bad enough.", "Good enough."],
        })),
      },
      "scores",
    ],
    [
      "score with one level",
      { ...GOOD_DECIDE, scores: [{ id: "s", question: "How good is this?", levels: ["Only one."] }] },
      "scores[0].levels",
    ],
    [
      "score with eleven levels",
      {
        ...GOOD_DECIDE,
        scores: [
          {
            id: "s",
            question: "How good is this?",
            levels: Array.from({ length: 11 }, (_, i) => `Level ${i}.`),
          },
        ],
      },
      "scores[0].levels",
    ],
    [
      "min_level out of range",
      {
        ...GOOD_DECIDE,
        scores: [{ id: "s", question: "How good is this?", levels: ["Bad.", "Good."], min_level: 5 }],
      },
      "scores[0].min_level",
    ],
    ["input not an object", "decide", "decide"],
  ];

  for (const [name, input, field] of bad) {
    it(`rejects ${name} with a message naming the field`, () => {
      expect(() => validateDecideInput(input)).toThrow(ToolInputError);
      expect(() => validateDecideInput(input)).toThrow(new RegExp(escape(field)));
    });
  }
});

describe("validateCheckInput", () => {
  it("accepts a preset-only input", () => {
    const out = validateCheckInput({
      label: "risky-rm",
      state: { command: "rm -rf build" },
      preset: "risky_command",
    });
    expect(out.preset).toBe("risky_command");
    expect(out.checks).toBeUndefined();
  });

  it("accepts checks without a preset", () => {
    const out = validateCheckInput({
      label: "scope",
      state: { work: "renaming the parser" },
      checks: [{ id: "in_scope", question: "Is this inside what was asked for?" }],
    });
    expect(out.checks).toHaveLength(1);
  });

  const bad: [string, unknown, string][] = [
    ["label missing", { state: { a: 1 }, preset: "scope_check" }, "label"],
    ["label malformed", { label: "Scope Check", state: { a: 1 }, preset: "scope_check" }, "label"],
    ["state empty", { label: "scope", state: {}, preset: "scope_check" }, "state"],
    ["state missing", { label: "scope", preset: "scope_check" }, "state"],
    ["nothing to judge", { label: "scope", state: { a: 1 } }, "preset"],
    ["empty arrays are nothing to judge", { label: "scope", state: { a: 1 }, checks: [], scores: [] }, "preset"],
    ["unknown preset", { label: "scope", state: { a: 1 }, preset: "vibes" }, "preset"],
  ];

  for (const [name, input, field] of bad) {
    it(`rejects ${name} with a message naming the field`, () => {
      expect(() => validateCheckInput(input)).toThrow(ToolInputError);
      expect(() => validateCheckInput(input)).toThrow(new RegExp(escape(field)));
    });
  }
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ----------------------------------------------------------- the choice */

describe("buildDecideRequest choice", () => {
  const input = validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE });

  it("holds exactly the caller's options plus none_of_these, and never an ask_user option", () => {
    const built = buildDecideRequest(input, {});
    const criteria = asChoice(built.questions[RESERVED.decision]).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["none_of_these", "valibot", "zod"]);
    expect(criteria).not.toHaveProperty("ask_user");
    expect(criteria.zod).toBe(GOOD_DECIDE.options[0]?.description);
    expect(String(criteria[NONE_OF_THESE])).toMatch(/a different option is needed/);
  });

  it("is the caller's question plus one scoping sentence naming the request field", () => {
    const built = buildDecideRequest(input, { userRequest: "Add request validation." });
    const instructions = asChoice(built.questions[RESERVED.decision]).instructions;
    expect(instructions.startsWith(GOOD_DECIDE.question)).toBe(true);
    const extra = instructions.slice(GOOD_DECIDE.question.length).trim();
    expect(extra).toBe(
      "Answer using only the facts in the state, where `user_request_verbatim` states what the user asked for.",
    );
  });

  it("asks whether the choice was delegated only when the user's words are present", () => {
    const withRequest = buildDecideRequest(input, { userRequest: "You choose the library." });
    expect(asNoul(withRequest.questions[RESERVED.delegated]).instructions).toContain("`user_request_verbatim`");
    expect(buildDecideRequest(input, {}).questions[RESERVED.delegated]).toBeUndefined();
  });

  it("does not name a request field when there is none", () => {
    const built = buildDecideRequest(input, {});
    const instructions = asChoice(built.questions[RESERVED.decision]).instructions;
    expect(instructions).toContain("Answer using only the facts in the state.");
    expect(instructions).not.toContain("`user_request");
  });

  it("reports the caller's option ids without none_of_these", () => {
    expect(buildDecideRequest(input, {}).realOptionIds).toEqual(["zod", "valibot"]);
  });
});

/* -------------------------------------------------- the reserved questions */

describe("reserved questions", () => {
  const decideInput = validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE });

  it("rides along with every decide request", () => {
    const built = buildDecideRequest(decideInput, { userRequest: "Add request validation." });
    expect(ids(built)).toEqual(
      expect.arrayContaining([
        RESERVED.decision,
        RESERVED.needsUserPreference,
        RESERVED.optionsAreNeutral,
        RESERVED.reversibleLocally,
        RESERVED.changesPublicInterface,
        RESERVED.affectsProduction,
      ]),
    );
  });

  it("adds options_as_written verbatim for the neutrality judgment", () => {
    const built = buildDecideRequest(decideInput, {});
    expect(built.state.options_as_written).toEqual([
      { id: "zod", description: GOOD_DECIDE.options[0]?.description },
      { id: "valibot", description: GOOD_DECIDE.options[1]?.description },
    ]);
    expect(asNoul(built.questions[RESERVED.optionsAreNeutral]).instructions).toContain(
      "`options_as_written`",
    );
  });

  it("gives a check request the stakes nouls but not the option judgments", () => {
    const built = buildCheckRequest(
      validateCheckInput({ label: "scope", state: PLAIN_STATE, preset: "scope_check" }),
      {},
    );
    expect(ids(built)).toEqual(
      expect.arrayContaining([
        RESERVED.reversibleLocally,
        RESERVED.changesPublicInterface,
        RESERVED.affectsProduction,
      ]),
    );
    expect(ids(built)).not.toContain(RESERVED.needsUserPreference);
    expect(ids(built)).not.toContain(RESERVED.optionsAreNeutral);
    expect(ids(built)).not.toContain(RESERVED.decision);
  });

  it("asks the stakes nouls about the options, not about the whole request", () => {
    // Pointing them at the request made a decision inherit the stakes of everything else
    // the user asked for in the same sentence.
    const built = buildDecideRequest(decideInput, {
      userRequest: "Deploy the pricing page to production, and rename the helper while you are there.",
    });
    for (const id of [
      RESERVED.reversibleLocally,
      RESERVED.changesPublicInterface,
      RESERVED.changesStoredData,
      RESERVED.affectsProduction,
      RESERVED.spendsMoney,
      RESERVED.sendsOutside,
    ]) {
      const text = String(asNoul(built.questions[id]).instructions);
      expect(text).toContain("`options_as_written`");
      expect(text).not.toContain("user_request");
    }
  });

  it("asks a risky_command check about the command itself", () => {
    const built = buildCheckRequest(
      validateCheckInput({
        label: "drop-table",
        preset: "risky_command",
        state: { user_request: "tidy up", command: "DROP TABLE users", context: "production" },
      }),
      {},
    );
    expect(String(asNoul(built.questions[RESERVED.affectsProduction]).instructions)).toContain(
      "`command`",
    );
  });

  it("asks one condition per stakes noul", () => {
    // A weak lean on any disjunct used to raise the whole call's stakes, so no stakes
    // question may join conditions in a list. ("other code or people" is one condition with
    // two kinds of dependent, which is why this looks for the list comma rather than "or".)
    const built = buildDecideRequest(decideInput, { userRequest: "x" });
    for (const id of [
      RESERVED.reversibleLocally,
      RESERVED.changesPublicInterface,
      RESERVED.changesStoredData,
      RESERVED.affectsProduction,
      RESERVED.spendsMoney,
      RESERVED.sendsOutside,
    ]) {
      expect(String(asNoul(built.questions[id]).instructions)).not.toMatch(/, or /);
    }
  });
});

describe("the injection noul", () => {
  it("is absent when the state does not look external", () => {
    expect(looksExternal(PLAIN_STATE)).toBe(false);
    const built = buildDecideRequest(
      validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE }),
      {},
    );
    expect(ids(built)).not.toContain(RESERVED.injection);
  });

  it("is present when the state does look external", () => {
    expect(looksExternal(EXTERNAL_STATE)).toBe(true);
    const built = buildDecideRequest(
      validateDecideInput({ ...GOOD_DECIDE, state: EXTERNAL_STATE }),
      {},
    );
    expect(ids(built)).toContain(RESERVED.injection);
    // It must ask about text aimed at THIS evaluation. "Text that instructs the reader"
    // describes every plan and command the plugin sends, and scored 0.88 on an honest plan.
    const text = String(asNoul(built.questions[RESERVED.injection]).instructions);
    expect(text).toMatch(/influence this evaluation/);
    expect(text).not.toMatch(/instruct or steer/);
  });

  it("follows the same rule for a check request", () => {
    const plain = buildCheckRequest(
      validateCheckInput({ label: "scope", state: PLAIN_STATE, preset: "scope_check" }),
      {},
    );
    const external = buildCheckRequest(
      validateCheckInput({ label: "scope", state: EXTERNAL_STATE, preset: "scope_check" }),
      {},
    );
    expect(ids(plain)).not.toContain(RESERVED.injection);
    expect(ids(external)).toContain(RESERVED.injection);
  });
});

/* ------------------------------------------------------- the caller batch */

describe("the caller's checks and scores", () => {
  it("are prefixed and their wording is passed through", () => {
    const built = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: PLAIN_STATE,
        checks: [
          {
            id: "breaks_public_api",
            question: "Does this change a signature other packages import?",
            yes_means: "A signature other packages import changes.",
            no_means: "No imported signature changes.",
            blocking_answer: "yes",
          },
        ],
        scores: [
          {
            id: "risk",
            question: "How much of the parser does this touch?",
            levels: ["One function.", "One module.", "Several modules."],
            min_level: 1,
          },
        ],
      }),
      {},
    );

    const check = asNoul(built.questions["check_breaks_public_api"]);
    expect(check.instructions).toBe("Does this change a signature other packages import?");
    expect(check.criteria?.true).toBe("A signature other packages import changes.");
    expect(check.criteria?.false).toBe("No imported signature changes.");

    const scoreQ = asScore(built.questions["score_risk"]);
    expect(scoreQ.instructions).toBe("How much of the parser does this touch?");
    expect(scoreQ.criteria).toHaveLength(3);

    expect(built.checks.map((c) => c.id)).toEqual(["breaks_public_api"]);
    expect(built.scores.map((s) => s.id)).toEqual(["risk"]);
  });

  it("carry no criteria at all when the caller did not describe the boundary", () => {
    // A generic restatement is not neutral padding: measured against jev-1.13 it pulled an
    // ambiguous question down by 0.08 and added nothing to a clear one.
    const built = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: PLAIN_STATE,
        checks: [{ id: "adds_dep", question: "Does this add a runtime dependency?" }],
      }),
      {},
    );
    expect(asNoul(built.questions["check_adds_dep"]).criteria).toBeUndefined();
  });

  it("keep the caller's own boundary wording when they supply it", () => {
    const built = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: PLAIN_STATE,
        checks: [
          {
            id: "adds_dep",
            question: "Does this add a runtime dependency?",
            yes_means: "It adds a package that ships to production.",
            no_means: "It adds nothing, or only a development dependency.",
          },
        ],
      }),
      {},
    );
    const criteria = asNoul(built.questions["check_adds_dep"]).criteria;
    expect(String(criteria?.true)).toContain("ships to production");
    expect(String(criteria?.false)).toContain("development dependency");
  });

  it("are renamed when they collide with a preset question", () => {
    const built = buildCheckRequest(
      validateCheckInput({
        label: "risky-rm",
        state: { command: "rm -rf build" },
        preset: "risky_command",
        checks: [{ id: "is_destructive", question: "Does it wipe the cache directory?" }],
      }),
      {},
    );
    expect(ids(built)).toContain("check_is_destructive");
    expect(ids(built)).toContain("check_is_destructive_2");
    expect(asNoul(built.questions["check_is_destructive_2"]).instructions).toBe(
      "Does it wipe the cache directory?",
    );

    const effective = built.checks.map((c) => c.id);
    expect(effective).toEqual([...PRESETS.risky_command.checks.map((c) => c.id), "is_destructive_2"]);
    // The rename must reach the spec, because policy looks answers up by `check_<id>`.
    expect(effective.filter((id) => id === "is_destructive")).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- state */

describe("the state that is sent", () => {
  it("adds user_request_verbatim only when the caller supplied no user_request", () => {
    const withAnchor = buildDecideRequest(
      validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE }),
      { userRequest: "Add request validation." },
    );
    expect(withAnchor.state.user_request_verbatim).toBe("Add request validation.");

    const callerOwn = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: { ...PLAIN_STATE, user_request: "Add request validation." },
      }),
      { userRequest: "something else the hook recorded" },
    );
    expect(callerOwn.state).not.toHaveProperty("user_request_verbatim");
    expect(callerOwn.state.user_request).toBe("Add request validation.");

    const neither = buildDecideRequest(
      validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE }),
      {},
    );
    expect(neither.state).not.toHaveProperty("user_request_verbatim");
  });

  it("redacts the caller's state", () => {
    const built = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: { framework: "react", config: "api_key: abcd1234efgh5678" },
      }),
      {},
    );
    expect(String(built.state.config)).toContain("[REDACTED:secret]");
  });

  it("reports truncated fields", () => {
    const built = buildDecideRequest(
      validateDecideInput({
        ...GOOD_DECIDE,
        state: { framework: "react", notes: "n".repeat(6000) },
      }),
      {},
    );
    expect(built.truncated).toContain("notes");
  });

  it("never carries a decision_history field", () => {
    const builts = [
      buildDecideRequest(validateDecideInput({ ...GOOD_DECIDE, state: PLAIN_STATE }), {
        userRequest: "Add request validation.",
      }),
      buildCheckRequest(
        validateCheckInput({ label: "scope", state: PLAIN_STATE, preset: "scope_check" }),
        { userRequest: "Add request validation." },
      ),
      buildPlanReviewRequest({ userRequest: "Add validation.", plan: "Step 1.", decisions: [] }),
      buildRouterRequest({
        userRequest: "Add validation.",
        questions: [{ question: "Which library?", options: [{ label: "zod" }, { label: "valibot" }] }],
        decisions: [{ label: "validation-library", choice: "zod" }],
      }),
      buildTriageRequest({ kind: "mutation", userRequest: "Add validation.", evidence: { file: "a.ts" } }),
    ];
    for (const built of builts) expect(built.state).not.toHaveProperty("decision_history");
  });
});

/* ---------------------------------------------------------- plan review */

describe("buildPlanReviewRequest", () => {
  const built = buildPlanReviewRequest({
    userRequest: "Add request validation to the parser.",
    plan: "1. Add zod schemas. 2. Wire them into the parser. 3. Run the tests.",
    decisions: [{ label: "validation-library", choice: "zod", action: "proceed" }],
  });

  it("asks coverage as a three-level score with min_level 2", () => {
    const coverage = asScore(built.questions[PLAN_IDS.coverage]);
    expect(coverage.type).toBe("score");
    expect(coverage.criteria).toEqual([
      "The plan does not do the main thing the user asked for.",
      "The plan does the main thing but leaves out something else the user asked for.",
      "The plan does everything the user asked for.",
    ]);
    expect(built.scores.find((s) => s.id === PLAN_IDS.coverage)?.min_level).toBe(2);
  });

  it("asks one noul per irreversible kind rather than one bundled question", () => {
    for (const id of PLAN_IRREVERSIBLE_IDS) {
      expect(asNoul(built.questions[id]).type).toBe("noul");
    }
    expect(PLAN_IRREVERSIBLE_IDS).toHaveLength(4);
  });

  it("reads the confirmation section as not deferring a choice", () => {
    expect(asNoul(built.questions[PLAN_IDS.defersAChoice]).instructions).toContain(
      "puts to the user for confirmation before starting does not count",
    );
  });

  it("asks the standalone plan nouls", () => {
    expect(ids(built)).not.toContain(PLAN_IDS.namesOneApproach); // asked, never read
    expect(ids(built)).toEqual(
      expect.arrayContaining([
        PLAN_IDS.defersAChoice,
        PLAN_IDS.hasVerification,
        PLAN_IDS.addsUnrequestedWork,
      ]),
    );
    expect(asNoul(built.questions[PLAN_IDS.defersAChoice]).instructions).toMatch(
      /leaves a choice between alternatives to be made later/,
    );
  });

  it("writes each recorded decision into its own question, capped at six", () => {
    expect(ids(built)).toContain(PLAN_IDS.followsDecision(0));
    expect(asNoul(built.questions[PLAN_IDS.followsDecision(0)]).instructions).toContain(
      '"validation-library"',
    );

    const many = buildPlanReviewRequest({
      userRequest: "Do the thing.",
      plan: "A plan.",
      decisions: Array.from({ length: 9 }, (_, i) => ({
        label: `d${i}`,
        choice: "a",
        action: "proceed",
      })),
    });
    const followed = ids(many).filter((id) => id.startsWith("follows_decision_"));
    expect(followed).toHaveLength(PLAN_REVIEW_MAX_DECISIONS);
    expect(followed).not.toContain(PLAN_IDS.followsDecision(6));
  });

  it("uses unprefixed ids, because policy reads the answers raw", () => {
    expect(ids(built)).not.toContain("check_defers_a_choice");
    expect(ids(built)).not.toContain("score_coverage");
  });
});

/* --------------------------------------------------------------- router */

describe("buildRouterRequest", () => {
  const question = {
    question: "Which validation library should we use?",
    header: "Library",
    options: [{ label: "Zod", description: "Already a dependency." }, { label: "Valibot" }],
  };

  it("builds one choice and one stated noul per question", () => {
    const built = buildRouterRequest({
      userRequest: "Add validation, and use whatever we already depend on.",
      questions: [question, { question: "Where should it live?", options: [{ label: "src" }, { label: "lib" }] }],
      decisions: [{ label: "validation-library", choice: "zod" }],
    });
    expect(ids(built).sort()).toEqual(
      [ROUTER_CHOICE_ID(0), ROUTER_CHOICE_ID(1), ROUTER_STATED_ID(0), ROUTER_STATED_ID(1)].sort(),
    );
    expect(asChoice(built.questions[ROUTER_CHOICE_ID(0)]).type).toBe("choice");
    expect(asNoul(built.questions[ROUTER_STATED_ID(0)]).type).toBe("noul");
  });

  it("caps at four questions", () => {
    const built = buildRouterRequest({
      userRequest: "Do six things.",
      questions: Array.from({ length: 6 }, (_, i) => ({
        question: `Question ${i}?`,
        options: [{ label: "A" }, { label: "B" }],
      })),
      decisions: [],
    });
    expect(ids(built)).toHaveLength(ROUTER_MAX_QUESTIONS * 2);
    expect(ids(built)).not.toContain(ROUTER_CHOICE_ID(4));
  });

  it("keys the criteria by a label key the hook can recompute", () => {
    const built = buildRouterRequest({ userRequest: "Add validation.", questions: [question], decisions: [] });
    const criteria = asChoice(built.questions[ROUTER_CHOICE_ID(0)]).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["none_of_these", "valibot", "zod"]);
    expect(criteria[routerOptionKey("Zod")]).toBe("Already a dependency.");
    expect(criteria[routerOptionKey("Valibot")]).toBe("Valibot");
  });

  it("asks for the user's own words, not the popular answer", () => {
    const built = buildRouterRequest({ userRequest: "Add validation.", questions: [question], decisions: [] });
    const instructions = asChoice(built.questions[ROUTER_CHOICE_ID(0)]).instructions;
    expect(instructions.startsWith(question.question)).toBe(true);
    expect(instructions).toContain("`user_request`");
    expect(instructions).toMatch(/not with whichever answer is most common or most popular/);
    expect(asNoul(built.questions[ROUTER_STATED_ID(0)]).instructions).toContain(question.question);
  });
});

describe("routerOptionKeys", () => {
  it("sanitizes labels and suffixes a collision", () => {
    expect(routerOptionKeys(["Yes, do it", "No thanks"])).toEqual(["yes_do_it", "no_thanks"]);
    expect(routerOptionKeys(["Yes!", "Yes?"])).toEqual(["yes", "yes_2"]);
    expect(routerOptionKeys(["***"])).toEqual(["option"]);
    expect(routerOptionKey("none of these")).toBe("none_of_these");
    expect(routerOptionKeys(["none of these"])).toEqual(["none_of_these_2"]);
  });
});

/* --------------------------------------------------------------- triage */

describe("buildTriageRequest", () => {
  it("asks one noul for a mutation", () => {
    const built = buildTriageRequest({
      kind: "mutation",
      userRequest: "Add request validation.",
      evidence: { tool: "Write", path: "src/parse.ts" },
    });
    expect(ids(built)).toEqual([TRIAGE_MUTATION_ID]);
    expect(asNoul(built.questions[TRIAGE_MUTATION_ID]).instructions).toMatch(
      /two or more materially different approaches, designs, libraries or scopes/,
    );
    expect(asNoul(built.questions[TRIAGE_MUTATION_ID]).instructions).toContain("`user_request`");
  });

  it("asks one noul about the assistant message for a stop", () => {
    const built = buildTriageRequest({
      kind: "stop",
      userRequest: "Add request validation.",
      evidence: { assistant_message: "I went with zod rather than valibot." },
    });
    expect(ids(built)).toEqual([TRIAGE_STOP_ID]);
    const instructions = asNoul(built.questions[TRIAGE_STOP_ID]).instructions;
    expect(instructions).toContain("`assistant_message`");
    expect(instructions).toMatch(/at least one other viable alternative/);
  });
});
