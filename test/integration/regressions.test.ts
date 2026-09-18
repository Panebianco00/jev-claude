/**
 * One test per defect found in review. Each names the behaviour that was wrong, so a
 * regression reads as a sentence rather than as a failing assertion about internals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeTypeSafe, type FakeServer } from "../fake-typesafe/server.ts";
import { evaluate, judgePlanReview, DEFAULT_THRESHOLDS, NONE_OF_THESE, RESERVED } from "../../src/shared/policy.ts";
import { DEFAULT_CONFIG } from "../../src/shared/config.ts";
import { routerDenyAnswered } from "../../src/shared/protocol.ts";
import { SessionStore } from "../../src/shared/state-store.ts";
import type { Config, JevSuccess, LedgerEntry } from "../../src/shared/types.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HOOK = join(ROOT, "dist", "hook.mjs");
const CLI = join(ROOT, "dist", "cli.mjs");

let fake: FakeServer;
let stateDir: string;

function run(name: string, input: unknown, extra: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [HOOK, name], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JEV_STATE_DIR: stateDir,
      TYPESAFE_BASE_URL: fake.url,
      TYPESAFE_API_KEY: "test-key",
      ...extra,
    },
  });
  return {
    out: res.stdout.trim() ? (JSON.parse(res.stdout) as Record<string, unknown>) : undefined,
    status: res.status,
  };
}

/**
 * For hooks that call out to Jev. `spawnSync` blocks this process's event loop, so the fake
 * server cannot answer the child and every network path silently times out into fail-open —
 * which would make a test asserting the request shape pass for the wrong reason.
 */
async function runAsync(
  name: string,
  input: unknown,
  extra: Record<string, string> = {},
): Promise<{ out: Record<string, unknown> | undefined; status: number | null }> {
  const child = spawn(process.execPath, [HOOK, name], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JEV_STATE_DIR: stateDir,
      TYPESAFE_BASE_URL: fake.url,
      TYPESAFE_API_KEY: "test-key",
      ...extra,
    },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { out: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : undefined, status };
}

function decisionOf(out: Record<string, unknown> | undefined): string | undefined {
  return (out?.["hookSpecificOutput"] as { permissionDecision?: string } | undefined)
    ?.permissionDecision;
}

function seedLedger(session: string, entries: Partial<LedgerEntry>[]): void {
  const dir = join(stateDir, "sessions", session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ledger.jsonl"),
    entries
      .map((e) =>
        JSON.stringify({
          v: 1,
          ts: Date.now(),
          kind: "decide",
          session_id: session,
          label: "some-label",
          action: "proceed",
          ...e,
        }),
      )
      .join("\n") + "\n",
  );
}

function seedPrompt(session: string, mode: string | undefined, ts = Date.now()): void {
  const dir = join(stateDir, "sessions", session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "prompts.jsonl"),
    JSON.stringify({ v: 1, ts, prompt_id: "p1", permission_mode: mode, text: "do the thing" }) + "\n",
    { flag: "a" },
  );
}

const PLAN = "# Plan\n\n1. Add a cache layer\n2. Wire it into the read path\n3. Add tests";

const planInput = (session: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  prompt_id: "p1",
  permission_mode: "plan",
  tool_name: "ExitPlanMode",
  tool_input: { plan: PLAN },
  ...extra,
});

beforeAll(async () => {
  fake = await startFakeTypeSafe();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jev-reg-"));
});

describe("plan gate", () => {
  it("does not demand a consultation the user cannot supply when there is no API key", () => {
    // Previously: every decide call returned proceed_unverified, which the gate did not
    // count, so it refused a plan twice for something no key could satisfy.
    seedPrompt("nokey", "plan");
    seedLedger("nokey", [
      { label: "cache-strategy", action: "proceed_unverified", error: "no_api_key", permission_mode: "plan", prompt_id: "p1" },
    ]);
    const h = run("plan-gate", planInput("nokey"), { TYPESAFE_API_KEY: "" });
    expect(decisionOf(h.out)).toBeUndefined();
    expect(String(h.out?.["systemMessage"])).toContain("not verified");
  });

  it("does not refuse when Jev was consulted but could not be reached", () => {
    seedPrompt("down", "plan");
    seedLedger("down", [
      { label: "cache-strategy", action: "proceed_unverified", error: "rate_limit", permission_mode: "plan", prompt_id: "p1" },
    ]);
    const h = run("plan-gate", planInput("down"));
    expect(decisionOf(h.out)).toBeUndefined();
  });

  it("does not count a failed call as a verdict, even when fail=closed made it look like one", () => {
    // fail=closed records escalate_to_user for an unreachable Jev. Counting it would make
    // the stricter setting more permissive than the default.
    seedPrompt("closed", "plan");
    seedLedger("closed", [
      { label: "cache-strategy", action: "escalate_to_user", error: "rate_limit", permission_mode: "plan", prompt_id: "p1" },
    ]);
    const h = run("plan-gate", planInput("closed"), { JEV_FAIL: "closed" });
    expect(String(h.out?.["systemMessage"])).toContain("not verified");
  });

  it("does not accept a decision from an ordinary earlier turn as consultation for this plan", () => {
    const old = Date.now() - 60_000;
    seedPrompt("scope", undefined, old);
    seedPrompt("scope", "plan");
    seedLedger("scope", [
      { label: "logging-library", action: "proceed", ts: old + 1, prompt_id: "p0", permission_mode: "default" },
    ]);
    const h = run("plan-gate", planInput("scope", { prompt_id: "p1" }));
    expect(decisionOf(h.out)).toBe("deny");
  });

  it("does not assert an unsettled decision back to Jev as one already taken", async () => {
    // The plan gate told Claude to leave an escalated decision open, then asked Jev whether
    // the plan acts on it — refusing the plan for doing exactly as instructed.
    seedPrompt("unsettled", "plan");
    seedLedger("unsettled", [
      { label: "cache-store", action: "escalate_to_user", choice: "redis", permission_mode: "plan", prompt_id: "p1" },
      { label: "retention", action: "revise", choice: "none_of_these", permission_mode: "plan", prompt_id: "p1" },
      { label: "http-client", action: "proceed", choice: "undici", permission_mode: "plan", prompt_id: "p1" },
    ]);
    const before = fake.requests.length;
    await runAsync("plan-gate", planInput("unsettled"));
    const req = fake.requests[before] as { questions: Record<string, { instructions?: string }> };
    const asked = Object.entries(req.questions)
      .filter(([id]) => id.startsWith("follows_decision_"))
      .map(([, q]) => String(q.instructions));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("http-client");
    expect(asked.join(" ")).not.toContain("cache-store");
    expect(asked.join(" ")).not.toContain("none_of_these");
  });

  it("does not let a failure from an earlier turn waive the gate for the rest of the run", () => {
    const old = Date.now() - 60_000;
    seedPrompt("stale", "plan", old);
    seedPrompt("stale", "plan");
    seedLedger("stale", [
      { label: "unrelated", action: "proceed_unverified", error: "rate_limit", permission_mode: "plan", prompt_id: "p0", ts: old + 1 },
    ]);
    const h = run("plan-gate", planInput("stale", { prompt_id: "p1" }));
    expect(decisionOf(h.out)).toBe("deny");
  });

  it("refuses to read a plan file that is not a regular file", () => {
    // /dev/zero has no size: an unguarded read allocates until the hook is killed.
    const h = run("plan-gate", {
      ...planInput("dev"),
      tool_input: { plan: "", planFilePath: "/dev/zero" },
    });
    expect(h.status).toBe(0);
    expect(decisionOf(h.out)).toBe("deny"); // no plan text, but still no consultation
  });
});

describe("bash gate", () => {
  const bash = (session: string, prompt: string, command: string) => ({
    hook_event_name: "PreToolUse",
    session_id: session,
    prompt_id: prompt,
    tool_name: "Bash",
    tool_input: { command },
  });

  it("refuses a dependency install once per turn until Jev is consulted", async () => {
    const first = await runAsync("bash-gate", bash("dep-1", "p1", "npm install left-pad"));
    expect(decisionOf(first.out)).toBe("deny");
    expect(JSON.stringify(first.out)).toContain("left-pad");
    // Bounded: the retry in the same turn passes.
    const retry = await runAsync("bash-gate", bash("dep-1", "p1", "npm install left-pad"));
    expect(decisionOf(retry.out)).toBeUndefined();
  });

  it("lets a dependency install through when Jev was consulted this turn", async () => {
    seedLedger("dep-2", [{ prompt_id: "p1", label: "http-client", choice: "undici" }]);
    const out = await runAsync("bash-gate", bash("dep-2", "p1", "npm install undici"));
    expect(decisionOf(out.out)).toBeUndefined();
  });

  it("never gates restoring the lockfile", async () => {
    const out = await runAsync("bash-gate", bash("dep-3", "p1", "npm install"));
    expect(out.out).toBeUndefined();
  });

  it("does not call out for an ordinary command", async () => {
    const out = await runAsync("bash-gate", bash("bash-1", "p1", "ls -la && git status"), {
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
    });
    expect(out.out).toBeUndefined();
  });

  it("checks a destructive command at most once, and fails open when Jev is unreachable", async () => {
    const cmd = "git push --force origin main";
    const down = await runAsync("bash-gate", bash("bash-2", "p1", cmd), { TYPESAFE_BASE_URL: "http://127.0.0.1:1" });
    expect(decisionOf(down.out)).toBeUndefined();
    expect(String(down.out?.["systemMessage"])).toContain("not verified");
    const again = await runAsync("bash-gate", bash("bash-2", "p2", cmd));
    expect(again.out).toBeUndefined();
  });

  it("runs the risky_command check against Jev and, if it refuses, names the findings", async () => {
    const out = await runAsync("bash-gate", bash("bash-3", "p1", "rm -rf ./data"));
    // The fake's answers are arbitrary but fixed; either outcome must be well formed.
    if (decisionOf(out.out) === "deny") {
      const reason = (out.out?.["hookSpecificOutput"] as { permissionDecisionReason: string }).permissionDecisionReason;
      expect(reason).toContain("Jev Bash gate");
      expect(reason).toContain("recursive delete");
    } else {
      expect(decisionOf(out.out)).toBeUndefined();
    }
  });

  it("stands down in soft mode", async () => {
    const out = await runAsync("bash-gate", bash("bash-4", "p1", "npm install left-pad"), { JEV_ENFORCEMENT: "soft" });
    expect(out.out).toBeUndefined();
  });
});

describe("plan entered mid-turn", () => {
  it("injects the plan-mode instructions", () => {
    const { out } = run("plan-entered", { hook_event_name: "PostToolUse", session_id: "pe", tool_name: "EnterPlanMode" });
    const ctx = (out?.["hookSpecificOutput"] as { additionalContext?: string })?.additionalContext;
    expect(ctx).toContain("ExitPlanMode is gated");
  });
});

describe("question router", () => {
  const ask = (session: string, question: string, options: unknown) => ({
    hook_event_name: "PreToolUse",
    session_id: session,
    prompt_id: "p1",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question, multiSelect: false, options }] },
  });

  const OPTS = [
    { label: "npm", description: "Ships with Node." },
    { label: "pnpm", description: "Content-addressed store." },
  ];

  it("refuses only once per turn in ledger mode, however the question is rephrased", () => {
    // Previously: ledger mode never recorded a gate entry, so the per-turn ceiling never
    // engaged and every new wording was refused again.
    const first = run("question-router", ask("led", "Which package manager?", OPTS), {
      JEV_ROUTER: "ledger",
    });
    expect(decisionOf(first.out)).toBe("deny");

    const rephrased = run(
      "question-router",
      ask("led", "So which package manager do you prefer?", OPTS),
      { JEV_ROUTER: "ledger" },
    );
    expect(rephrased.out).toBeUndefined();
  });

  it("survives options that are not objects, and does not spend the question's one routing", () => {
    const h = run("question-router", ask("bad", "Which one?", ["npm", "pnpm"]));
    expect(h.status).toBe(0);
    expect(h.out).toBeUndefined();
    expect(existsSync(join(stateDir, "sessions", "bad", "claims", "router"))).toBe(false);
  });
});

describe("policy", () => {
  const cfg: Config = { ...DEFAULT_CONFIG, thresholds: DEFAULT_THRESHOLDS };

  const success = (choices: JevSuccess["choices"], nouls: Record<string, number> = {}): JevSuccess => ({
    ok: true,
    model: "jev-latest",
    nouls,
    choices,
    scores: {},
    usage: { input_tokens: 1, output_tokens: 1 },
    ms: 1,
  });

  it("refuses to act on an option that was never offered", () => {
    const out = evaluate({
      result: success({
        [RESERVED.decision]: {
          choice: "totally_made_up",
          confidence: 0.97,
          probabilities: { a: 0.6, b: 0.4 },
        },
      }),
      declaredStakes: "medium",
      realOptionIds: ["a", "b"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.action).toBe("revise");
    expect(out.p1).toBeUndefined();
  });

  it("still proceeds on a normal confident answer", () => {
    const out = evaluate({
      result: success({
        [RESERVED.decision]: { choice: "a", confidence: 0.92, probabilities: { a: 0.9, b: 0.1 } },
      }),
      declaredStakes: "low",
      realOptionIds: ["a", "b"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.action).toBe("proceed");
  });

  it("escalates on an injected instruction but keeps Jev's answer for the record", () => {
    // Regression: the early return dropped choice and confidence, so the ledger showed
    // "asked you" with nothing behind it and calibration never saw the decision.
    const out = evaluate({
      result: success(
        { [RESERVED.decision]: { choice: "a", confidence: 0.88, probabilities: { a: 0.8, b: 0.2 } } },
        { [RESERVED.injection]: 0.95 },
      ),
      declaredStakes: "medium",
      realOptionIds: ["a", "b"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.action).toBe("escalate_to_user");
    expect(out.rationale).toContain("steer the answer");
    expect(out.choice).toBe("a");
    expect(out.confidence).toBe(0.88);
    expect(out.p1).toBe(0.8);
  });

  it("reports an injected instruction in a plan without refusing the plan over it", () => {
    // The screen was asked on every plan and its answer discarded. It reports rather than
    // blocks: any repo containing such a line could otherwise stop planning entirely.
    const { problems, blocking } = judgePlanReview(
      { [RESERVED.injection]: 0.97, defers_a_choice: 0.1 },
      2,
      DEFAULT_THRESHOLDS,
    );
    expect(problems.join(" ")).toContain("aimed at whoever reviews it");
    expect(blocking).toBe(false);
  });

  it("says nothing about injection for an ordinary plan", () => {
    const { problems } = judgePlanReview(
      { [RESERVED.injection]: 0.06, defers_a_choice: 0.1 },
      2,
      DEFAULT_THRESHOLDS,
    );
    expect(problems.join(" ")).not.toContain("aimed at whoever");
  });

  it("does not interrupt the user over a preference score when the facts already settled it", () => {
    // Measured against the real model: an obvious choice came back at p 1.00 while the
    // preference side-question scored 0.71. Escalating that is how a decision layer earns
    // the reflex to be switched off.
    const out = evaluate({
      result: success(
        {
          [RESERVED.decision]: { choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } },
        },
        { [RESERVED.needsUserPreference]: 0.71 },
      ),
      declaredStakes: "medium",
      realOptionIds: ["a", "b"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.action).toBe("proceed");
  });

  it("still escalates a preference question when the answer is genuinely open", () => {
    const out = evaluate({
      result: success(
        {
          [RESERVED.decision]: {
            choice: "a",
            confidence: 0.55,
            probabilities: { a: 0.5, b: 0.3, c: 0.2 },
          },
        },
        { [RESERVED.needsUserPreference]: 0.92 },
      ),
      declaredStakes: "medium",
      realOptionIds: ["a", "b", "c"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.action).toBe("escalate_to_user");
  });

  it("does not make a blocking safety check harder to trigger as the stakes rise", () => {
    // The bands used to be indexed by stakes, so promoting a call to high stakes widened the
    // uncertain zone and turned a blocking answer into a shrug.
    const spec = { id: "is_destructive", question: "Does it delete data?", blocking_answer: "yes" as const };
    for (const stakes of ["low", "medium", "high"] as const) {
      const out = evaluate({
        result: success({}, { check_is_destructive: 0.72 }),
        declaredStakes: stakes,
        checks: [spec],
        scores: [],
        cfg,
      });
      expect(out.checks[0]?.verdict, stakes).toBe("yes");
      expect(out.checks[0]?.blocking, stakes).toBe(true);
    }
  });

  it("does not skip a preference escalation on an irreversible high-stakes call", () => {
    const out = evaluate({
      result: success(
        { [RESERVED.decision]: { choice: "drop_now", confidence: 0.92, probabilities: { drop_now: 0.92, wait: 0.08 } } },
        { [RESERVED.needsUserPreference]: 0.98, [RESERVED.affectsProduction]: 0.9 },
      ),
      declaredStakes: "medium",
      realOptionIds: ["drop_now", "wait"],
      checks: [],
      scores: [],
      cfg,
    });
    expect(out.effectiveStakes).toBe("high");
    expect(out.action).toBe("escalate_to_user");
  });

  it("calls a destructive command destructive instead of shrugging at 0.79", () => {
    // The high-stakes noul band used to demand 0.90 either way, so a DROP TABLE scored
    // "uncertain" and no check ever blocked.
    const out = evaluate({
      result: success({}, { check_is_destructive: 0.79 }),
      declaredStakes: "high",
      checks: [{ id: "is_destructive", question: "Does it delete data?", blocking_answer: "yes" }],
      scores: [],
      cfg,
    });
    expect(out.checks[0]?.verdict).toBe("yes");
    expect(out.action).toBe("revise");
  });

  it("asks for a revision the first time no option fits, and escalates only on the second", () => {
    const args = {
      result: success({
        [RESERVED.decision]: {
          choice: NONE_OF_THESE,
          confidence: 0.8,
          probabilities: { a: 0.2, [NONE_OF_THESE]: 0.8 },
        },
      }),
      declaredStakes: "medium" as const,
      realOptionIds: ["a", "b"],
      checks: [],
      scores: [],
      cfg,
    };
    expect(evaluate({ ...args, priorRevisions: 0 }).action).toBe("revise");
    expect(evaluate({ ...args, priorRevisions: 1 }).action).toBe("escalate_to_user");
  });
});

describe("server", () => {
  it("reports a response with no usable decision answer as unavailable, not as proceed", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "dist", "server.mjs")],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          JEV_STATE_DIR: stateDir,
          TYPESAFE_BASE_URL: fake.url,
          TYPESAFE_API_KEY: "test-key",
        },
      }),
    );
    const result = (await client.callTool({
      name: "decide",
      arguments: {
        decision: "shape-test",
        question: "Which option fits the facts in `user_request` best?",
        stakes: "high",
        options: [
          { id: "a", description: "The first option, described plainly." },
          { id: "b", description: "The second option, described plainly." },
        ],
        // The fake server answers every question it is asked; blanking the decision answer
        // simulates a response the client cannot model.
        state: { user_request: "pick one", __answers: { decision: null } },
      },
    })) as { content: { text: string }[]; isError?: boolean };
    await client.close();

    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("ACTION proceed:");
    expect(text).toMatch(/unavailable|proceed_unverified/);
  });
});

describe("state and cli", () => {
  it("keeps the once-per-project disclosure claim when old sessions are pruned", () => {
    const store = new SessionStore(stateDir, "current");
    store.ensureDirs();
    const global = new SessionStore(stateDir, "_global");
    global.ensureDirs();
    expect(global.claim("disclosed", "/tmp/project")).toBe(true);

    store.prune({ retainDays: 7, keepSessionId: "current", now: Date.now() + 30 * 24 * 3600_000 });
    expect(global.hasClaim("disclosed", "/tmp/project")).toBe(true);
  });

  it("writes a whole ledger to a pipe instead of stopping at the buffer", () => {
    // process.exit() discards what is still buffered, so a long ledger came out truncated
    // mid-JSON with a success status.
    const store = new SessionStore(stateDir, "big");
    store.ensureDirs();
    for (let i = 0; i < 3000; i++) {
      store.appendLedger({
        v: 1,
        ts: Date.now(),
        kind: "decide",
        session_id: "big",
        label: `decision-${i}`,
        action: "proceed",
        choice: "an-option-with-a-reasonably-long-identifier",
      });
    }
    const res = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${CLI}" log --all --json | cat`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_STATE_DIR: stateDir },
    });
    expect(res.stdout.length).toBeGreaterThan(200_000);
    expect(() => JSON.parse(res.stdout.trim().split("\n")[0] as string)).not.toThrow();
  });

  it("refuses --session without an id instead of printing a different session", () => {
    const res = spawnSync(process.execPath, [CLI, "log", "--session", "--json"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_STATE_DIR: stateDir },
    });
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain('"session"');
    expect(res.stderr).toContain("--session");
  });
});

describe("protocol", () => {
  it("keeps the router refusal under the reason cap with the recovery sentence intact", () => {
    const long = "Which approach should we take here, ".repeat(30);
    const text = routerDenyAnswered(
      Array.from({ length: 4 }, (_, i) => ({ question: `${long}${i}?`, label: "yes", p: 0.9 })),
      Array.from({ length: 4 }, (_, i) => `${long}remaining ${i}?`),
    );
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("retry the same AskUserQuestion afterwards");
  });
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
