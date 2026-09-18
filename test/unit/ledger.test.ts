import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildLedgerEntry,
  extractResponseText,
  shrinkLedgerEntry,
  thisTurn,
  turnKey,
} from "../../src/shared/ledger.ts";
import type { CallContext, HookInput, LedgerEntry } from "../../src/shared/types.ts";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    v: 1,
    ts: 1000,
    kind: "decide",
    session_id: "s1",
    label: "pick-lib",
    action: "proceed",
    ...over,
  };
}

const size = (e: LedgerEntry) => Buffer.byteLength(JSON.stringify(e), "utf8");

describe("turnKey", () => {
  it("prefers agent_id, then prompt_id, then the session", () => {
    expect(turnKey({ agent_id: "a1", prompt_id: "p1" })).toBe("agent:a1");
    expect(turnKey({ prompt_id: "p1" })).toBe("prompt:p1");
    expect(turnKey({})).toBe("session");
  });
});

describe("thisTurn", () => {
  const entries = [
    { ts: 10, prompt_id: "p1" },
    { ts: 20, prompt_id: "p1", agent_id: "a1" },
    { ts: 30, prompt_id: "p2" },
    { ts: 40, agent_id: "a1" },
    { ts: 50 },
  ];

  it("scopes the main thread to its prompt and excludes subagent entries", () => {
    const out = thisTurn(entries, { prompt_id: "p1" });
    expect(out.map((e) => e.ts)).toEqual([10]);
  });

  it("scopes a subagent to its agent_id across prompts", () => {
    const out = thisTurn(entries, { agent_id: "a1", prompt_id: "p1" });
    expect(out.map((e) => e.ts)).toEqual([20, 40]);
  });

  it("falls back to a timestamp window when there is no prompt_id", () => {
    expect(thisTurn(entries, {}, 30).map((e) => e.ts)).toEqual([30, 40, 50]);
    expect(thisTurn(entries, {}).map((e) => e.ts)).toEqual([10, 20, 30, 40, 50]);
  });
});

describe("shrinkLedgerEntry", () => {
  it("leaves a small entry untouched and unflagged", () => {
    const e = entry({ option_ids: ["a", "b"] });
    const out = shrinkLedgerEntry(e);
    expect(out).toBe(e);
    expect(out.truncated).toBeUndefined();
  });

  it("brings an oversized entry under 4000 bytes and flags it", () => {
    const big = entry({
      option_ids: Array.from({ length: 200 }, (_, i) => `option-${i}-${"x".repeat(40)}`),
      checks: Array.from({ length: 60 }, (_, i) => ({
        id: `check-${i}-${"y".repeat(60)}`,
        p: 0.5,
        verdict: "yes" as const,
      })),
      scores: Array.from({ length: 30 }, (_, i) => ({
        id: `score-${i}-${"z".repeat(60)}`,
        score: 2,
        status: "pass",
      })),
      model: "some-very-long-model-name",
    });
    expect(size(big)).toBeGreaterThan(4000);

    const out = shrinkLedgerEntry(big);
    expect(size(out)).toBeLessThanOrEqual(4000);
    expect(out.truncated).toBe(true);
    expect(out.option_ids).toBeUndefined();
    // Identity is never dropped: the line stays joinable to its session and label.
    expect(out.session_id).toBe("s1");
    expect(out.label).toBe("pick-lib");
    expect(out.action).toBe("proceed");
  });

  it("does not mutate the entry it was given", () => {
    const big = entry({ option_ids: Array.from({ length: 500 }, (_, i) => `opt-${"q".repeat(30)}-${i}`) });
    const before = JSON.stringify(big);
    shrinkLedgerEntry(big);
    expect(JSON.stringify(big)).toBe(before);
  });

  it("falls back to a skeleton when a single field blows the budget", () => {
    const out = shrinkLedgerEntry(entry({ label: "L".repeat(20000) }));
    expect(size(out)).toBeLessThanOrEqual(4000);
    expect(out.truncated).toBe(true);
    expect(out.kind).toBe("decide");
  });

  it("honours a custom budget", () => {
    const out = shrinkLedgerEntry(entry({ label: "L".repeat(500) }), 200);
    expect(size(out)).toBeLessThanOrEqual(200);
  });
});

describe("buildLedgerEntry", () => {
  const input: HookInput = {
    hook_event_name: "PostToolUse",
    session_id: "sess-1",
    prompt_id: "p-1",
    tool_use_id: "toolu_1",
    permission_mode: "plan",
  };
  const ctx: CallContext = {
    session_id: "sess-1",
    prompt_id: "p-1",
    agent_id: "agent-7",
    agent_type: "explore",
    permission_mode: "default",
    ts: 5,
    enforcement: "standard",
    authority: "autonomous",
    fail: "open",
    interactive: true,
  };

  it("prefers the record file the server wrote", () => {
    const out = buildLedgerEntry({
      input,
      ctx,
      record: {
        tool: "decide",
        label: "validation-library",
        choice: "zod",
        conf: 0.79,
        p1: 0.81,
        margin: 0.66,
        action: "proceed",
        declared_stakes: "low",
        effective_stakes: "medium",
        option_ids: ["zod", "valibot"],
        checks: [{ id: "breaks_api", p: 0.04, verdict: "no" }],
        scores: [{ id: "coverage", score: 2, status: "pass" }],
        ms: 412,
        model: "jev-1",
      },
      toolInput: { decision: "validation-library", stakes: "low" },
      toolResponseText: "jev-record: {\"label\":\"ignored\",\"action\":\"revise\"}",
    });

    expect(out.kind).toBe("decide");
    expect(out.label).toBe("validation-library");
    expect(out.action).toBe("proceed");
    expect(out.choice).toBe("zod");
    expect(out.confidence).toBe(0.79);
    expect(out.p1).toBe(0.81);
    expect(out.margin).toBe(0.66);
    expect(out.effective_stakes).toBe("medium");
    expect(out.option_ids).toEqual(["zod", "valibot"]);
    expect(out.checks).toEqual([{ id: "breaks_api", p: 0.04, verdict: "no" }]);
    expect(out.scores).toEqual([{ id: "coverage", score: 2, status: "pass" }]);
    expect(out.ms).toBe(412);
    expect(out.model).toBe("jev-1");
    // The context file wins over the hook payload for identity.
    expect(out.agent_id).toBe("agent-7");
    expect(out.permission_mode).toBe("default");
    expect(out.tool_use_id).toBe("toolu_1");
  });

  it("falls back to the last jev-record line of the response", () => {
    const text = [
      "JEV check[plan-review] -> ok",
      "jev-record: {\"kind\":\"check\",\"label\":\"stale\",\"action\":\"proceed\"}",
      "some prose mentioning jev-record: not a real one",
      '  jev-record: {"kind":"check","label":"plan-review","action":"revise","p1":0.3}',
    ].join("\n");

    const out = buildLedgerEntry({ input, toolInput: { label: "plan-review" }, toolResponseText: text });
    expect(out.kind).toBe("check");
    expect(out.label).toBe("plan-review");
    expect(out.action).toBe("revise");
    expect(out.p1).toBe(0.3);
    expect(out.session_id).toBe("sess-1");
  });

  it("ignores a malformed marker line and keeps looking", () => {
    const text = ['jev-record: {"kind":"decide","label":"good","action":"confirm"}', "jev-record: {broken"].join(
      "\n",
    );
    const out = buildLedgerEntry({ input, toolResponseText: text });
    expect(out.label).toBe("good");
    expect(out.action).toBe("confirm");
  });

  it("builds a minimal unverified entry from the tool input alone", () => {
    const out = buildLedgerEntry({
      input,
      toolInput: {
        decision: "cache-layer",
        stakes: "high",
        options: [{ id: "redis" }, { id: "memory" }],
      },
      toolResponseText: "Jev unavailable: no API key.",
    });
    expect(out.kind).toBe("decide");
    expect(out.label).toBe("cache-layer");
    expect(out.action).toBe("proceed_unverified");
    expect(out.declared_stakes).toBe("high");
    expect(out.option_ids).toEqual(["redis", "memory"]);
    expect(out.choice).toBeUndefined();
  });

  it("uses label for a check and survives an empty payload", () => {
    expect(buildLedgerEntry({ input, toolInput: { label: "risky-command" } }).kind).toBe("check");
    const bare = buildLedgerEntry({ input: {} });
    expect(bare.session_id).toBe("");
    expect(bare.label).toBe("(unlabelled)");
    expect(bare.action).toBe("proceed_unverified");
    expect(bare.v).toBe(1);
  });

  it("rejects an action the policy does not define", () => {
    const out = buildLedgerEntry({ input, record: { label: "x", action: "explode" } });
    expect(out.action).toBe("proceed_unverified");
  });
});

describe("extractResponseText", () => {
  it("returns a string unchanged", () => {
    expect(extractResponseText("hello")).toBe("hello");
  });

  it("joins the text fields of an array", () => {
    expect(extractResponseText([{ type: "text", text: "a" }, { type: "image" }, { text: "b" }])).toBe("a\nb");
  });

  it("recurses into an object with content", () => {
    expect(extractResponseText({ content: [{ type: "text", text: "inner" }] })).toBe("inner");
    expect(extractResponseText({ content: { content: "deep" } })).toBe("deep");
  });

  it("stringifies anything else", () => {
    expect(extractResponseText({ foo: 1 })).toBe('{"foo":1}');
    expect(extractResponseText(42)).toBe("42");
  });

  it("returns an empty string for nullish input and never throws on a cycle", () => {
    expect(extractResponseText(undefined)).toBe("");
    expect(extractResponseText(null)).toBe("");
    const cyclic: Record<string, unknown> = {};
    cyclic["content"] = cyclic;
    expect(() => extractResponseText(cyclic)).not.toThrow();
    expect(extractResponseText(cyclic)).toBe("");
  });
});
