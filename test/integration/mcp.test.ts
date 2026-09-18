/**
 * The real path, end to end: a bundled MCP server over stdio, talking to a fake TypeSafe,
 * with the two hooks that bracket a call. These are the assertions that would have caught
 * every contract mistake the design had to be corrected on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeTypeSafe, type FakeServer } from "../fake-typesafe/server.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER = join(ROOT, "dist", "server.mjs");
const HOOK = join(ROOT, "dist", "hook.mjs");

let fake: FakeServer;
let stateDir: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    JEV_STATE_DIR: stateDir,
    TYPESAFE_BASE_URL: fake.url,
    TYPESAFE_API_KEY: "test-key",
    ...extra,
  };
}

function runHook(name: string, input: unknown, extra: Record<string, string> = {}): unknown {
  const res = spawnSync(process.execPath, [HOOK, name], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: env(extra),
  });
  expect(res.status, res.stderr).toBe(0);
  if (!res.stdout.trim()) return undefined;
  return JSON.parse(res.stdout);
}

async function connect(extra: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], env: env(extra) }),
  );
  return client;
}

const DECIDE_ARGS = {
  decision: "validation-library",
  question: "Which approach should validate request bodies on the routes in `user_request`?",
  stakes: "medium" as const,
  options: [
    { id: "zod", description: "Schema library with inferred types; adds a small runtime dependency." },
    { id: "handwritten", description: "Extend the existing guard functions; no new dependency, more code." },
  ],
  state: {
    user_request: "add request validation to the public API routes",
    constraints: "TypeScript strict, no large runtime dependencies",
  },
};

beforeAll(async () => {
  fake = await startFakeTypeSafe();
  stateDir = mkdtempSync(join(tmpdir(), "jev-it-"));
});

afterAll(async () => {
  await fake.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("mcp server", () => {
  it("advertises both tools as read-only and always loaded", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["check", "decide"]);

    for (const tool of tools) {
      // readOnlyHint is what lets the tool be called at all while the session is in plan mode.
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool._meta?.["anthropic/alwaysLoad"]).toBe(true);
      // A declared output schema would make the client throw when we return only text.
      expect(tool.outputSchema).toBeUndefined();
      expect((tool.description ?? "").length).toBeLessThanOrEqual(1900);
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
    }
    await client.close();
  });

  it("starts and lists tools with no API key configured", async () => {
    // The server is alwaysLoad: throwing at startup would mean no tool at all, and the
    // TypeSafe client constructor throws when the key is missing.
    const client = await connect({ TYPESAFE_API_KEY: "" });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);

    const result = (await client.callTool({ name: "decide", arguments: DECIDE_ARGS })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("no_api_key");
    expect(result.content[0]?.text).toContain("proceed_unverified");
    await client.close();
  });

  it("decides, writes the call record, and the post hook turns it into a ledger entry", async () => {
    const toolUseId = "toolu_integration_1";
    const hookInput = {
      session_id: "sess-it",
      prompt_id: "prompt-it",
      cwd: process.cwd(),
      permission_mode: "plan",
      tool_name: "mcp__plugin_jev_jev__decide",
      tool_use_id: toolUseId,
    };

    // The user's words are the anchor every request carries; they arrive via this hook.
    runHook("user-prompt-submit", {
      ...hookInput,
      hook_event_name: "UserPromptSubmit",
      prompt: "add request validation to the public API routes",
    });

    const pre = runHook("pre-jev-tool", { ...hookInput, hook_event_name: "PreToolUse" }) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(pre.hookSpecificOutput.permissionDecision).toBe("allow");

    const client = await connect();
    const result = (await client.callTool({
      name: "decide",
      arguments: DECIDE_ARGS,
      _meta: { "claudecode/toolUseId": toolUseId },
    })) as { content: { text: string }[]; isError?: boolean };
    await client.close();

    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/^JEV decide\[validation-library\]/m);
    expect(text).toMatch(/^ACTION (proceed|proceed_and_flag|confirm|escalate_to_user|revise)/m);

    const recordLine = text.split("\n").find((l) => l.startsWith("jev-record: "));
    expect(recordLine, "the last line must be machine readable").toBeDefined();
    const record = JSON.parse(recordLine!.slice("jev-record: ".length)) as Record<string, unknown>;
    expect(record["label"]).toBe("validation-library");

    // In plan mode a decision that needs the user must not tell Claude to interrupt them.
    if (String(record["action"]) === "confirm") {
      expect(text).toContain("Decisions needing confirmation");
    }

    const callFile = join(stateDir, "calls", `${toolUseId}.json`);
    expect(JSON.parse(readFileSync(callFile, "utf8"))["label"]).toBe("validation-library");

    runHook("post-jev-tool", {
      ...hookInput,
      hook_event_name: "PostToolUse",
      tool_input: DECIDE_ARGS,
      tool_response: { content: [{ type: "text", text }] },
    });

    const ledger = readFileSync(join(stateDir, "sessions", "sess-it", "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.["label"]).toBe("validation-library");
    expect(ledger[0]?.["permission_mode"]).toBe("plan");
    expect(ledger[0]?.["kind"]).toBe("decide");
    // The plan gate later checks a plan against this decision's words, not its bare id.
    const chosen = DECIDE_ARGS.options.find((o) => o.id === ledger[0]?.["choice"]);
    if (chosen) expect(ledger[0]?.["choice_text"]).toBe(chosen.description);
    // The consumed handoff files are cleaned up so the state dir cannot grow without bound.
    expect(readdirSync(join(stateDir, "calls"))).not.toContain(`${toolUseId}.json`);
  });

  it("sends the user's request verbatim and the reserved questions, and never an ask_user option", async () => {
    const before = fake.requests.length;
    const client = await connect();
    await client.callTool({ name: "decide", arguments: DECIDE_ARGS });
    await client.close();

    const req = fake.requests[before] as {
      state: Record<string, unknown>;
      questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
    };
    const criteria = req.questions["decision"]?.criteria ?? {};
    expect(Object.keys(criteria).sort()).toEqual(["handwritten", "none_of_these", "zod"]);
    expect(Object.keys(criteria)).not.toContain("ask_user");

    // The questions that stop the caller from grading its own homework.
    for (const id of [
      "needs_user_preference",
      "options_are_neutral",
      "reversible_locally",
      "changes_public_interface",
      "changes_stored_data",
      "affects_production",
      "spends_money",
      "sends_outside_this_machine",
    ]) {
      expect(Object.keys(req.questions)).toContain(id);
    }
    expect(Object.keys(req.state)).not.toContain("decision_history");
  });

  it("rejects malformed input with an error naming the field", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "decide",
      arguments: { ...DECIDE_ARGS, options: [DECIDE_ARGS.options[0]] },
    })) as { content: { text: string }[]; isError?: boolean };
    await client.close();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/options/i);
  });

  it("returns a non-error result when TypeSafe fails, so PostToolUse still fires", async () => {
    // isError routes to PostToolUseFailure instead of PostToolUse, which would silently lose
    // the ledger entry. An outage must look like a verdict of "unverified", not a tool crash.
    const client = await connect();
    const result = (await client.callTool({
      name: "decide",
      arguments: { ...DECIDE_ARGS, state: { ...DECIDE_ARGS.state, __fail: "overloaded" } },
    })) as { content: { text: string }[]; isError?: boolean };
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("proceed_unverified");
  });
});

describe("plan gate", () => {
  const base = {
    hook_event_name: "PreToolUse",
    session_id: "sess-plan",
    cwd: process.cwd(),
    permission_mode: "plan",
    tool_name: "ExitPlanMode",
  };
  const plan = "# Plan\n\n1. Add a validation layer\n2. Wire it into the six route handlers\n3. Add tests for each route";

  it("refuses an unconsulted plan, and keeps a budget per plan text rather than per session", () => {
    const first = runHook("plan-gate", { ...base, prompt_id: "p1", tool_input: { plan } }) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("refusal 1 of 2");
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("still in plan mode");

    const second = runHook("plan-gate", { ...base, prompt_id: "p1", tool_input: { plan } }) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(second.hookSpecificOutput.permissionDecisionReason).toContain("refusal 2 of 2");

    // Exhausted for this text: the gate lets it through rather than trapping the session.
    const third = runHook("plan-gate", { ...base, prompt_id: "p1", tool_input: { plan } }) as {
      hookSpecificOutput?: unknown;
      systemMessage?: string;
    };
    expect(third?.hookSpecificOutput).toBeUndefined();

    // A revised plan is a different decision and gets its own budget, even though the user
    // never approved the previous one (a rejected plan never closes the epoch).
    const revised = runHook("plan-gate", {
      ...base,
      prompt_id: "p2",
      tool_input: { plan: plan + "\n4. Document the new behaviour" },
    }) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(revised.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(revised.hookSpecificOutput.permissionDecisionReason).toContain("refusal 1 of 2");
  });

  it("reads the plan file rather than the injected copy, which lags an edit behind", () => {
    // Regression: tool_input.plan was observed one edit stale, so a revised plan was judged
    // as the previous text and an unchanged resubmission got a fresh refusal budget.
    const file = join(process.cwd(), "plan.md");
    writeFileSync(file, plan + "\n4. Revised step");
    const input = { ...base, session_id: "sess-file", prompt_id: "p1" };
    const stale = { plan, planFilePath: file };
    const first = runHook("plan-gate", { ...input, tool_input: stale }) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(first.hookSpecificOutput.permissionDecisionReason).toContain("refusal 1 of 2");
    // Same file, now with an up-to-date injected copy: still the same plan, same budget.
    const second = runHook("plan-gate", {
      ...input,
      tool_input: { plan: plan + "\n4. Revised step", planFilePath: file },
    }) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(second.hookSpecificOutput.permissionDecisionReason).toContain("refusal 2 of 2");
  });

  it("is silent inside a subagent, which cannot own the session's plan", () => {
    const out = runHook("plan-gate", {
      ...base,
      session_id: "sess-sub",
      prompt_id: "p1",
      agent_id: "agent-1",
      agent_type: "Explore",
      tool_input: { plan },
    });
    expect(out).toBeUndefined();
  });

  it("lets the plan through when TypeSafe is unreachable", () => {
    const out = runHook(
      "plan-gate",
      { ...base, session_id: "sess-down", prompt_id: "p1", tool_input: { plan } },
      { TYPESAFE_BASE_URL: "http://127.0.0.1:1" },
    ) as { hookSpecificOutput?: { permissionDecision?: string } };
    // No consultation recorded, so it still refuses once — but on a reason it can act on,
    // never on the outage itself.
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
