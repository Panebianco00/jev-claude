import { describe, expect, it } from "vitest";
import { actionSentence, formatOutcome, formatUnavailable } from "../../src/shared/format.ts";
import type { FormatCtx } from "../../src/shared/format.ts";
import { ACTION_MEANING } from "../../src/shared/policy.ts";
import type { Action, DecisionOutcome, JevFailure } from "../../src/shared/types.ts";

const CTX: FormatCtx = { plan: false, subagent: false, interactive: true, authority: "autonomous" };

function outcome(over: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    action: "proceed",
    rationale: "confident pick",
    choice: "zod",
    p1: 0.81,
    margin: 0.66,
    confidence: 0.79,
    probabilities: { zod: 0.81, valibot: 0.15, none_of_these: 0.04 },
    declaredStakes: "low",
    effectiveStakes: "medium",
    checks: [],
    scores: [],
    ...over,
  };
}

function lines(text: string): string[] {
  return text.split("\n");
}

function parseRecord(text: string): unknown {
  const last = lines(text).at(-1) ?? "";
  expect(last.startsWith("jev-record: ")).toBe(true);
  return JSON.parse(last.slice("jev-record: ".length));
}

/* ------------------------------------------------------------- the block */

describe("formatOutcome", () => {
  it("writes the header, action, why, probabilities and record", () => {
    const { text } = formatOutcome({
      kind: "decide",
      label: "validation-library",
      outcome: outcome(),
      ctx: CTX,
      ms: 412,
      model: "jev-1",
    });
    const out = lines(text);
    expect(out[0]).toBe(
      "JEV decide[validation-library] -> zod   conf 0.79 - p 0.81 - margin 0.66 - stakes medium(declared low) - autonomous",
    );
    expect(out[1]).toBe(`ACTION proceed: ${ACTION_MEANING.proceed}`);
    expect(out[2]).toBe("why: confident pick");
    expect(out[3]).toBe("probabilities: zod 0.81 | valibot 0.15 | none_of_these 0.04");
    expect(out).toHaveLength(5);
  });

  it("round-trips the record through JSON.parse of the last line", () => {
    const { text, record } = formatOutcome({
      kind: "decide",
      label: "validation-library",
      outcome: outcome({
        checks: [{ id: "breaks_api", p: 0.04, verdict: "no", blocking: false, action: "proceed" }],
        scores: [
          { id: "risk", score: 1.5, confidence: 0.6, minLevel: 1, status: "pass", action: "proceed" },
        ],
      }),
      ctx: CTX,
      ms: 412,
      model: "jev-1",
    });
    expect(parseRecord(text)).toEqual(record);
    expect(record).toMatchObject({
      v: 1,
      kind: "decide",
      label: "validation-library",
      action: "proceed",
      choice: "zod",
      declared_stakes: "low",
      effective_stakes: "medium",
      ms: 412,
      model: "jev-1",
      checks: [{ id: "breaks_api", p: 0.04, verdict: "no" }],
      scores: [{ id: "risk", score: 1.5, status: "pass" }],
    });
  });

  it("shows the declared stakes only when they differ from the effective ones", () => {
    const same = formatOutcome({
      kind: "decide",
      label: "l",
      outcome: outcome({ declaredStakes: "medium", effectiveStakes: "medium" }),
      ctx: CTX,
      ms: 1,
      model: "m",
    });
    expect(lines(same.text)[0]).toContain("stakes medium -");
    expect(lines(same.text)[0]).not.toContain("declared");
  });

  it("omits the lines it has nothing for", () => {
    const { text } = formatOutcome({
      kind: "check",
      label: "risky-rm",
      outcome: {
        action: "revise",
        rationale: "",
        declaredStakes: "high",
        effectiveStakes: "high",
        checks: [],
        scores: [],
      },
      ctx: CTX,
      ms: 5,
      model: "jev-1",
    });
    const out = lines(text);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("JEV check[risky-rm]   stakes high - autonomous");
    expect(out[0]).not.toContain("->");
  });

  it("marks a blocking check and prints the score status", () => {
    const { text } = formatOutcome({
      kind: "check",
      label: "risky-rm",
      outcome: outcome({
        choice: undefined,
        p1: undefined,
        margin: undefined,
        confidence: undefined,
        probabilities: undefined,
        action: "revise",
        rationale: "blocking check: is_destructive",
        checks: [
          { id: "has_reversal_path", p: 0.04, verdict: "no", blocking: true, action: "revise" },
          { id: "matches_request", p: 0.92, verdict: "yes", blocking: false, action: "proceed" },
        ],
        scores: [
          {
            id: "coverage",
            score: 1.2,
            confidence: 0.7,
            minLevel: 2,
            status: "fail",
            action: "revise",
          },
        ],
      }),
      ctx: CTX,
      ms: 5,
      model: "jev-1",
    });
    expect(text).toContain(
      "checks: has_reversal_path -> no (0.04) BLOCKING | matches_request -> yes (0.92) ok",
    );
    expect(text).toContain("scores: coverage 1.20/2 fail");
  });
});

/* -------------------------------------------------------------- the axes */

describe("actionSentence", () => {
  const axes: [string, FormatCtx][] = [
    ["plan", { ...CTX, plan: true }],
    ["non-interactive", { ...CTX, interactive: false }],
    ["subagent", { ...CTX, subagent: true }],
  ];

  it("leaves actions other than confirm and escalate_to_user alone", () => {
    const every: Action[] = ["proceed", "proceed_and_flag", "revise", "proceed_unverified"];
    for (const action of every) {
      for (const [, ctx] of axes) {
        expect(actionSentence(action, ctx)).toBe(ACTION_MEANING[action]);
      }
    }
  });

  it("uses the normal wording when no axis applies", () => {
    expect(actionSentence("confirm", CTX)).toBe(ACTION_MEANING.confirm);
    expect(actionSentence("escalate_to_user", CTX)).toBe(ACTION_MEANING.escalate_to_user);
  });

  it("writes a plan-mode decision into the plan instead of asking", () => {
    const ctx = { ...CTX, plan: true };
    expect(actionSentence("confirm", ctx)).toContain("## Decisions needing confirmation");
    expect(actionSentence("escalate_to_user", ctx)).toContain("## Decisions needing confirmation");
    expect(actionSentence("confirm", ctx)).toContain("instead of calling AskUserQuestion");
  });

  it("reports an open decision to the parent from a subagent", () => {
    const ctx = { ...CTX, subagent: true };
    expect(actionSentence("confirm", ctx)).toContain("parent agent");
    expect(actionSentence("confirm", ctx)).toContain("OPEN");
    expect(actionSentence("escalate_to_user", ctx)).toContain("probabilities");
  });

  it("continues with the top option when there is no human", () => {
    const ctx = { ...CTX, interactive: false };
    expect(actionSentence("confirm", ctx)).toContain("no human in this run");
    expect(actionSentence("confirm", ctx)).toContain("continue with the top option");
  });

  it("puts subagent ahead of non-interactive ahead of plan", () => {
    const all: FormatCtx = { plan: true, subagent: true, interactive: false, authority: "autonomous" };
    expect(actionSentence("confirm", all)).toContain("parent agent");

    const noSubagent: FormatCtx = { ...all, subagent: false };
    expect(actionSentence("confirm", noSubagent)).toContain("no human in this run");

    const planOnly: FormatCtx = { ...all, subagent: false, interactive: true };
    expect(actionSentence("confirm", planOnly)).toContain("## Decisions needing confirmation");
  });

  it("reaches the block through formatOutcome", () => {
    const { text } = formatOutcome({
      kind: "decide",
      label: "l",
      outcome: outcome({ action: "confirm", rationale: "moderate confidence" }),
      ctx: { ...CTX, plan: true },
      ms: 1,
      model: "m",
    });
    expect(lines(text)[1]).toContain("ACTION confirm: list this under a '## Decisions");
  });
});

/* ------------------------------------------------------------ unavailable */

describe("formatUnavailable", () => {
  const failure: JevFailure = {
    ok: false,
    code: "no_api_key",
    message: "No TypeSafe API key was found.",
    userFixable: true,
  };

  it("proceeds unverified when the plugin fails open", () => {
    const { text, record } = formatUnavailable({
      kind: "decide",
      label: "validation-library",
      failure,
      ctx: CTX,
      fail: "open",
    });
    const out = lines(text);
    expect(out[0]).toBe("JEV decide[validation-library] -> unavailable   no_api_key - autonomous");
    expect(out[1]).toBe(`ACTION proceed_unverified: ${ACTION_MEANING.proceed_unverified}`);
    expect(record).toMatchObject({ v: 1, kind: "decide", action: "proceed_unverified", error: "no_api_key" });
    expect(parseRecord(text)).toEqual(record);
  });

  it("escalates to the user when the plugin fails closed", () => {
    const { text, record } = formatUnavailable({
      kind: "decide",
      label: "validation-library",
      failure,
      ctx: CTX,
      fail: "closed",
    });
    expect(lines(text)[1]).toBe(`ACTION escalate_to_user: ${ACTION_MEANING.escalate_to_user}`);
    expect(record).toMatchObject({ action: "escalate_to_user", error: "no_api_key" });
  });

  it("names the error code and, for a missing key, how to supply one", () => {
    const { text } = formatUnavailable({
      kind: "check",
      label: "risky-rm",
      failure,
      ctx: CTX,
      fail: "open",
    });
    expect(text).toContain("no_api_key");
    expect(text).toContain("TYPESAFE_API_KEY");
    expect(text).toContain("https://console.typesafe.ai/keys");
    expect(text).toContain("jev-doctor set-key");
  });

  it("does not offer the key hint for other codes", () => {
    const { text } = formatUnavailable({
      kind: "decide",
      label: "l",
      failure: { ok: false, code: "timeout", message: "The request timed out after 4000 ms.", userFixable: false },
      ctx: CTX,
      fail: "open",
    });
    expect(text).toContain("timeout");
    expect(text).not.toContain("TYPESAFE_API_KEY");
    expect(text).toContain("why: The request timed out after 4000 ms.");
  });

  it("degrades the escalation when there is no human", () => {
    const { text } = formatUnavailable({
      kind: "decide",
      label: "l",
      failure,
      ctx: { ...CTX, interactive: false },
      fail: "closed",
    });
    expect(text).toContain("no human in this run");
  });
});

/* ------------------------------------------------------------- the cap */

describe("the size cap", () => {
  it("keeps a long outcome inside the block budget with the record intact", () => {
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < 12; i++) probabilities[`option_number_${i}`] = 0.08;
    probabilities["none_of_these"] = 0.04;

    const { text, record } = formatOutcome({
      kind: "decide",
      label: "a-very-long-but-legal-decision-label-for-the-parser-rewrite",
      outcome: outcome({
        choice: "option_number_11",
        rationale: "low confidence at high stakes. ".repeat(20),
        probabilities,
        declaredStakes: "low",
        effectiveStakes: "high",
        action: "escalate_to_user",
        checks: Array.from({ length: 8 }, (_, i) => ({
          id: `check_number_${i}`,
          p: 0.4211,
          verdict: "uncertain" as const,
          blocking: false,
          action: "proceed" as const,
        })),
        scores: Array.from({ length: 4 }, (_, i) => ({
          id: `score_number_${i}`,
          score: 1.5,
          confidence: 0.6,
          minLevel: 2,
          status: "borderline" as const,
          action: "proceed" as const,
        })),
      }),
      ctx: CTX,
      ms: 987,
      model: "jev-latest",
    });

    expect(text.length).toBeLessThanOrEqual(1200);
    expect(parseRecord(text)).toEqual(record);
    // The two lines that carry the instruction are never sacrificed.
    expect(lines(text)[0]).toContain("JEV decide[");
    expect(lines(text)[1]).toContain("ACTION escalate_to_user:");
  });

  it("drops whole entries rather than half of one", () => {
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < 40; i++) probabilities[`a_rather_long_option_id_${i}`] = 0.02;

    const { text } = formatOutcome({
      kind: "decide",
      label: "l",
      outcome: outcome({ choice: "a_rather_long_option_id_0", probabilities, rationale: "x" }),
      ctx: CTX,
      ms: 1,
      model: "m",
    });
    expect(text.length).toBeLessThanOrEqual(1200);
    const probLine = lines(text).find((l) => l.startsWith("probabilities: ")) ?? "";
    expect(probLine).toMatch(/\| \+\d+ more$/);
    for (const entry of probLine.slice("probabilities: ".length).split(" | ")) {
      expect(entry).toMatch(/^(a_rather_long_option_id_\d+ \d\.\d\d|\+\d+ more)$/);
    }
  });
});
