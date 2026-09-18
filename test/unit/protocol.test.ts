import { describe, expect, it } from "vitest";
import * as protocol from "../../src/shared/protocol.ts";
import { DEFAULT_THRESHOLDS } from "../../src/shared/policy.ts";
import type { Config } from "../../src/shared/types.ts";

function config(over: Partial<Config> = {}): Config {
  return {
    enforcement: "standard",
    authority: "autonomous",
    fail: "open",
    confAxis: "confidence",
    model: undefined,
    baseUrl: undefined,
    stateDir: undefined,
    retainDays: 30,
    debug: false,
    timeoutMs: 8000,
    planReview: true,
    planMaxDenies: 2,
    router: "stated",
    routerMaxPerTurn: 1,
    mutationGate: false,
    stopBackstop: false,
    bashGate: true,
    dependencyGate: true,
    subagentSkip: [],
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  };
}

const DECIDE = "mcp__plugin_jev_jev__decide";
const CHECK = "mcp__plugin_jev_jev__check";

/** Every exported string, plus every exported function invoked with representative args. */
const ALL_TEXT: { name: string; text: string }[] = [
  { name: "sessionProtocol", text: protocol.sessionProtocol(config(), true) },
  { name: "sessionProtocol/noKey", text: protocol.sessionProtocol(config(), false) },
  { name: "subagentProtocol", text: protocol.subagentProtocol("explore", config()) },
  { name: "subagentProtocol/undef", text: protocol.subagentProtocol(undefined, config()) },
  { name: "REMINDER", text: protocol.REMINDER },
  { name: "REMINDER_PLAN", text: protocol.REMINDER_PLAN },
  { name: "planDenyNoConsultation", text: protocol.planDenyNoConsultation(1, 2) },
  {
    name: "planDenyReview",
    text: protocol.planDenyReview(2, 2, { defers_a_choice: 0.81 }, 1, [
      "step 3 leaves the storage backend open",
    ]),
  },
  { name: "planDenyReview/empty", text: protocol.planDenyReview(1, 2, {}, undefined, []) },
  { name: "planReviewSummary", text: protocol.planReviewSummary({}, 2, 3) },
  { name: "planReviewSummary/one", text: protocol.planReviewSummary({}, undefined, 1) },
  {
    name: "routerDenyAnswered",
    text: protocol.routerDenyAnswered(
      [{ question: "Which validation library?", label: "zod", p: 0.91 }],
      ["Which database?"],
    ),
  },
  {
    name: "routerDenyAnswered/none",
    text: protocol.routerDenyAnswered(
      [{ question: "Which validation library?", label: "zod", p: 0.91 }],
      [],
    ),
  },
  { name: "ROUTER_DENY_LEDGER", text: protocol.ROUTER_DENY_LEDGER },
  { name: "mutationDeny", text: protocol.mutationDeny(0.78) },
  { name: "stopBlock", text: protocol.stopBlock(0.82) },
  {
    name: "bashDeny",
    text: protocol.bashDeny("force push", "git push --force origin main", ["rewrites_history -> yes (0.97)"], "revise"),
  },
  { name: "dependencyDeny", text: protocol.dependencyDeny(["left-pad"]) },
  { name: "noKeyWarning", text: protocol.noKeyWarning() },
  { name: "DISCLOSURE", text: protocol.DISCLOSURE },
  { name: "HOOKS_NOT_RUNNING", text: protocol.HOOKS_NOT_RUNNING },
  { name: "SERVER_INSTRUCTIONS", text: protocol.SERVER_INSTRUCTIONS },
  { name: "TOOL_DESC_DECIDE", text: protocol.TOOL_DESC_DECIDE },
  { name: "TOOL_DESC_CHECK", text: protocol.TOOL_DESC_CHECK },
];

describe("size caps", () => {
  it.each([
    ["SERVER_INSTRUCTIONS", protocol.SERVER_INSTRUCTIONS],
    ["TOOL_DESC_DECIDE", protocol.TOOL_DESC_DECIDE],
    ["TOOL_DESC_CHECK", protocol.TOOL_DESC_CHECK],
  ])("%s fits in the 2 KB truncation budget", (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(1900);
  });

  it("puts the mandate in the first sentence of SERVER_INSTRUCTIONS", () => {
    const first = protocol.SERVER_INSTRUCTIONS.split(". ")[0] ?? "";
    expect(first).toContain("Jev decides");
  });

  it("keeps sessionProtocol within 2500-6000 characters", () => {
    for (const hasKey of [true, false]) {
      const n = protocol.sessionProtocol(config(), hasKey).length;
      expect(n).toBeGreaterThanOrEqual(2500);
      expect(n).toBeLessThanOrEqual(6000);
    }
  });

  it("keeps subagentProtocol short", () => {
    const words = protocol.subagentProtocol("explore", config()).split(/\s+/).length;
    expect(words).toBeGreaterThan(80);
    expect(words).toBeLessThan(200);
  });
});

describe("sessionProtocol", () => {
  it("substitutes enforcement and authority", () => {
    const text = protocol.sessionProtocol(config({ enforcement: "strict", authority: "advisory" }), true);
    expect(text).toContain('enforcement="strict"');
    expect(text).toContain('authority="advisory"');
    expect(text).toContain("Enforcement is strict and Jev's authority is advisory.");
    expect(text).not.toContain("standard");
    expect(text).not.toContain("autonomous");
  });

  it("names both tools", () => {
    const text = protocol.sessionProtocol(config(), true);
    expect(text).toContain(DECIDE);
    expect(text).toContain(CHECK);
  });

  it("states the plan-mode rule and the gate", () => {
    const text = protocol.sessionProtocol(config(), true);
    expect(text).toContain("PLAN MODE");
    expect(text).toContain("## Decisions (Jev)");
    expect(text).toContain("ExitPlanMode is refused until Jev has been consulted");
    expect(text).toContain("The user still approves the plan");
  });

  it("carries the precedence paragraph that resolves the design-approval conflict", () => {
    const text = protocol.sessionProtocol(config(), true);
    expect(text).toContain("PRECEDENCE");
    expect(text).toContain("that approval still happens");
    expect(text).toContain("Jev decides which design you present, not whether you present it");
  });

  it("lists all six actions", () => {
    const text = protocol.sessionProtocol(config(), true);
    for (const a of [
      "proceed",
      "proceed_and_flag",
      "revise",
      "confirm",
      "escalate_to_user",
      "proceed_unverified",
    ]) {
      expect(text).toContain(`- ${a}:`);
    }
  });

  it("points at the full guide and the escape hatches", () => {
    const text = protocol.sessionProtocol(config(), true);
    expect(text).toContain("/jev:jev-decisions");
    expect(text).toContain("at most twice per plan");
  });

  it("describes no gate in soft mode, where none runs", () => {
    // Regression: the text was identical at every level and promised an ExitPlanMode
    // refusal that soft mode never makes.
    const text = protocol.sessionProtocol(config({ enforcement: "soft" }), true);
    expect(text).not.toContain("ExitPlanMode is refused");
    expect(text).not.toContain("AskUserQuestion is intercepted");
    expect(text).toContain("None at this enforcement level");
    expect(text).toContain("PLAN MODE");
  });

  it("describes exactly the gates the configuration runs", () => {
    const standard = protocol.sessionProtocol(config(), true);
    expect(standard).toContain("destructive Bash command");
    expect(standard).toContain("dependency install");
    expect(standard).not.toContain("first edit of a turn");

    const trimmed = protocol.sessionProtocol(config({ bashGate: false, dependencyGate: false, router: "off" }), true);
    expect(trimmed).not.toContain("destructive Bash command");
    expect(trimmed).not.toContain("dependency install");
    expect(trimmed).not.toContain("AskUserQuestion is intercepted");

    const strict = protocol.sessionProtocol(config({ enforcement: "strict", mutationGate: true, stopBackstop: true }), true);
    expect(strict).toContain("first edit of a turn");
    expect(strict).toContain("sent back once");
  });

  it("names the easy-to-miss mid-task moments", () => {
    const text = protocol.sessionProtocol(config(), true);
    expect(text).toContain("about to add a dependency");
    expect(text).toContain("I chose X over Y");
  });

  it("adds the unverified line only when there is no key", () => {
    expect(protocol.sessionProtocol(config(), false)).toContain("No TypeSafe API key is configured");
    expect(protocol.sessionProtocol(config(), true)).not.toContain("No TypeSafe API key is configured");
  });
});

describe("subagentProtocol", () => {
  it("carries the agent type, or a fallback", () => {
    expect(protocol.subagentProtocol("explore", config())).toContain('agent="explore"');
    expect(protocol.subagentProtocol(undefined, config())).toContain('agent="subagent"');
    expect(protocol.subagentProtocol("  ", config())).toContain('agent="subagent"');
  });

  it("requires open decisions to be reported upwards", () => {
    const text = protocol.subagentProtocol("explore", config());
    expect(text).toContain("cannot ask the human");
    expect(text).toContain("confirm or escalate_to_user");
    expect(text).toContain("OPEN");
    expect(text).toContain("probabilities");
    expect(text).toMatch(/pure lookup/);
  });
});

describe("reminders", () => {
  it("REMINDER is one line naming the decide tool", () => {
    expect(protocol.REMINDER.split("\n")).toHaveLength(1);
    expect(protocol.REMINDER).toContain(DECIDE);
  });

  it("REMINDER_PLAN is two lines covering the workflow and the gate", () => {
    const lines = protocol.REMINDER_PLAN.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("## Decisions (Jev)");
    expect(lines[1]).toContain("ExitPlanMode is gated");
  });
});

describe("deny reasons", () => {
  const denies: { name: string; text: string; tool: string; recovery: RegExp }[] = [
    {
      name: "planDenyNoConsultation",
      text: protocol.planDenyNoConsultation(1, 2),
      tool: DECIDE,
      recovery: /You are still in plan mode/,
    },
    {
      name: "planDenyReview",
      text: protocol.planDenyReview(2, 2, {}, 1, ["step 3 leaves the backend open"]),
      tool: DECIDE,
      recovery: /You are still in plan mode/,
    },
    {
      name: "routerDenyAnswered",
      text: protocol.routerDenyAnswered([{ question: "Which one?", label: "zod", p: 0.9 }], []),
      tool: "AskUserQuestion",
      recovery: /retry the same AskUserQuestion afterwards and it will pass\.$/,
    },
    {
      name: "ROUTER_DENY_LEDGER",
      text: protocol.ROUTER_DENY_LEDGER,
      tool: DECIDE,
      recovery: /retry the same AskUserQuestion afterwards and it will pass\.$/,
    },
    {
      name: "mutationDeny",
      text: protocol.mutationDeny(0.78),
      tool: DECIDE,
      recovery: /retry the same edit and it will pass\.$/,
    },
    {
      name: "stopBlock",
      text: protocol.stopBlock(0.82),
      tool: DECIDE,
      recovery: /send the same reply again and it will pass\.$/,
    },
  ];

  it.each(denies)("$name states the refusal count", ({ text }) => {
    expect(text).toMatch(/refusal \d+ of \d+/);
  });

  it.each(denies)("$name names the tool to call next", ({ text, tool }) => {
    expect(text).toContain(tool);
  });

  it.each(denies)("$name ends with an unambiguous recovery sentence", ({ text, recovery }) => {
    expect(text).toMatch(recovery);
    expect(text.endsWith(".")).toBe(true);
  });

  it.each(denies)("$name says which gate refused, and why, up front", ({ text }) => {
    const first = text.split("\n")[0] ?? "";
    expect(first).toMatch(/^Jev [a-z ]+(gate|backstop): refused /);
    expect(first).toContain("because");
  });

  it("planDenyNoConsultation carries the counts it was given", () => {
    expect(protocol.planDenyNoConsultation(2, 3)).toContain("refusal 2 of 3");
  });

  it("planDenyReview lists the problems as bullets and the review numbers", () => {
    const text = protocol.planDenyReview(1, 2, { defers_a_choice: 0.812 }, 1, [
      "step 3 leaves the storage backend open",
      "step 5 contradicts decision cache-strategy",
    ]);
    expect(text).toContain("- step 3 leaves the storage backend open");
    expect(text).toContain("- step 5 contradicts decision cache-strategy");
    expect(text).toContain("defers_a_choice 0.81 | coverage 1.00/2");
  });

  it("planDenyReview stays coherent with no problems and no numbers", () => {
    const text = protocol.planDenyReview(1, 2, {}, undefined, []);
    expect(text).toContain("- the review did not clear the plan");
    expect(text).not.toContain("Review:");
  });

  it("mutationDeny and stopBlock quote the probability", () => {
    expect(protocol.mutationDeny(0.784)).toContain("(0.78)");
    expect(protocol.stopBlock(0.8)).toContain("(0.80)");
  });
});

describe("routerDenyAnswered", () => {
  const answered = [
    { question: "Which validation library?", label: "zod", p: 0.912 },
    { question: "Where should the schema live?", label: "src/schema.ts", p: 0.87 },
  ];

  it("lists each answered question with the chosen label and probability", () => {
    const text = protocol.routerDenyAnswered(answered, []);
    expect(text).toContain("- Which validation library? -> zod (0.91)");
    expect(text).toContain("- Where should the schema live? -> src/schema.ts (0.87)");
  });

  it("requires honest attribution", () => {
    const text = protocol.routerDenyAnswered(answered, []);
    expect(text).toContain("Jev chose them from the user's own words");
    expect(text).toContain("do not say the user chose them");
  });

  it("asks for a re-ask of only the remaining questions", () => {
    const text = protocol.routerDenyAnswered(answered, ["Which database?", "Which runtime?"]);
    expect(text).toContain("Re-ask ONLY");
    expect(text).toContain("- Which database?");
    expect(text).toContain("- Which runtime?");
  });

  it("omits the re-ask sentence when nothing remains", () => {
    const text = protocol.routerDenyAnswered(answered, []);
    expect(text).not.toContain("Re-ask ONLY");
    expect(text).not.toMatch(/Re-ask/i);
  });
});

describe("user-facing text", () => {
  it("DISCLOSURE names the endpoint, the log command and the off switch", () => {
    expect(protocol.DISCLOSURE).toContain("api.typesafe.ai");
    expect(protocol.DISCLOSURE).toContain("/jev:log");
    expect(protocol.DISCLOSURE).toContain("JEV_ENFORCEMENT=off");
    expect(protocol.DISCLOSURE.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(2);
  });

  it("HOOKS_NOT_RUNNING is one line saying enforcement is advisory", () => {
    expect(protocol.HOOKS_NOT_RUNNING.split("\n")).toHaveLength(1);
    expect(protocol.HOOKS_NOT_RUNNING).toContain("advisory only");
  });

  it("noKeyWarning says how to set a key", () => {
    expect(protocol.noKeyWarning()).toContain("TYPESAFE_API_KEY");
    expect(protocol.noKeyWarning()).toContain("/plugin configure jev@jev-claude");
    expect(protocol.noKeyWarning()).toContain("TYPESAFE_API_KEY");
  });
});

describe("hygiene", () => {
  it("covers every export", () => {
    const exported = Object.keys(protocol).sort();
    expect(exported).toEqual(
      [
        "DISCLOSURE",
        "HOOKS_NOT_RUNNING",
        "REMINDER",
        "REMINDER_PLAN",
        "ROUTER_DENY_LEDGER",
        "bashDeny",
        "dependencyDeny",
        "SERVER_INSTRUCTIONS",
        "TOOL_DESC_CHECK",
        "TOOL_DESC_DECIDE",
        "mutationDeny",
        "noKeyWarning",
        "planDenyNoConsultation",
        "planDenyReview",
        "planReviewSummary",
        "routerDenyAnswered",
        "sessionProtocol",
        "stopBlock",
        "subagentProtocol",
      ].sort(),
    );
    const covered = new Set(ALL_TEXT.map((t) => t.name.split("/")[0]));
    for (const name of exported) expect(covered.has(name)).toBe(true);
  });

  it.each(ALL_TEXT)("$name has no leftover template placeholder", ({ text }) => {
    expect(text).not.toMatch(/\$\{/);
  });

  it.each(ALL_TEXT)("$name has no tab character", ({ text }) => {
    expect(text).not.toMatch(/\t/);
  });

  it.each(ALL_TEXT)("$name has no trailing whitespace on any line", ({ text }) => {
    expect(text).not.toMatch(/[ \t]+$/m);
    expect(text).toBe(text.trim());
  });

  it.each(ALL_TEXT)("$name is non-empty", ({ text }) => {
    expect(text.length).toBeGreaterThan(0);
  });
});
