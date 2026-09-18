/**
 * The hooks as Claude Code actually runs them: a bundled process, JSON on stdin, JSON on
 * stdout, exit 0 whatever happens.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeTypeSafe, type FakeServer } from "../fake-typesafe/server.ts";

const HOOK = join(resolve(import.meta.dirname, "..", ".."), "dist", "hook.mjs");

let fake: FakeServer;
let stateDir: string;

interface HookRun {
  out: Record<string, unknown> | undefined;
  status: number | null;
  stderr: string;
}

function run(name: string, input: unknown, extra: Record<string, string> = {}): HookRun {
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
    stderr: res.stderr,
  };
}

function decision(h: HookRun): { permissionDecision?: string; permissionDecisionReason?: string } {
  return (h.out?.["hookSpecificOutput"] ?? {}) as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

const ASK = (session: string, prompt: string, questions: unknown[]): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  prompt_id: prompt,
  tool_name: "AskUserQuestion",
  tool_input: { questions },
});

const SINGLE = [
  {
    question: "Which package manager should the project use?",
    header: "Package manager",
    multiSelect: false,
    options: [
      { label: "npm", description: "Ships with Node." },
      { label: "pnpm", description: "Faster installs, content-addressed store." },
    ],
  },
];

beforeAll(async () => {
  fake = await startFakeTypeSafe();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "jev-hooks-"));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("session-start", () => {
  it("injects the protocol and warns when there is no key", () => {
    const h = run(
      "session-start",
      { hook_event_name: "SessionStart", session_id: "s1", source: "startup", cwd: "/tmp/p1" },
      { TYPESAFE_API_KEY: "" },
    );
    expect(h.status).toBe(0);
    const ctx = (h.out?.["hookSpecificOutput"] as { additionalContext?: string })?.additionalContext;
    expect(ctx).toContain("<jev-protocol");
    expect(ctx).toContain("mcp__plugin_jev_jev__decide");
    expect(String(h.out?.["systemMessage"])).toContain("no TypeSafe API key");
  });

  it("discloses what is sent once per project, not once per session", () => {
    const first = run("session-start", {
      hook_event_name: "SessionStart",
      session_id: "s1",
      source: "startup",
      cwd: "/tmp/same-project",
    });
    expect(String(first.out?.["systemMessage"])).toContain("api.typesafe.ai");

    const second = run("session-start", {
      hook_event_name: "SessionStart",
      session_id: "s2",
      source: "startup",
      cwd: "/tmp/same-project",
    });
    expect(String(second.out?.["systemMessage"] ?? "")).not.toContain("api.typesafe.ai");
  });

  it("says nothing at all when enforcement is off", () => {
    const h = run(
      "session-start",
      { hook_event_name: "SessionStart", session_id: "s1", source: "startup", cwd: "/tmp/p" },
      { JEV_ENFORCEMENT: "off" },
    );
    expect(h.out?.["hookSpecificOutput"]).toBeUndefined();
  });
});

describe("subagent-start", () => {
  it("tells a subagent it cannot ask the human", () => {
    const h = run("subagent-start", {
      hook_event_name: "SubagentStart",
      session_id: "s1",
      agent_id: "a1",
      agent_type: "general-purpose",
    });
    const ctx = (h.out?.["hookSpecificOutput"] as { additionalContext?: string })?.additionalContext;
    expect(ctx).toContain("general-purpose");
    expect(ctx).toContain("OPEN");
  });

  it("stays out of the way of agents that do not make decisions", () => {
    const h = run("subagent-start", {
      hook_event_name: "SubagentStart",
      session_id: "s1",
      agent_id: "a1",
      agent_type: "statusline-setup",
    });
    expect(h.out).toBeUndefined();
  });
});

describe("user-prompt-submit", () => {
  const prompt = (session: string, id: string, mode?: string): Record<string, unknown> => ({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    prompt_id: id,
    permission_mode: mode,
    prompt: "add validation to the api routes",
  });

  it("always reminds while planning", () => {
    const h = run("user-prompt-submit", prompt("s1", "p1", "plan"));
    const ctx = (h.out?.["hookSpecificOutput"] as { additionalContext?: string })?.additionalContext;
    expect(ctx).toContain("ExitPlanMode is gated");
  });

  it("reminds after a turn with no consultation, and stays quiet after one with", () => {
    run("user-prompt-submit", prompt("s2", "p1"));
    // p1 produced no ledger entry, so p2 is reminded.
    const second = run("user-prompt-submit", prompt("s2", "p2"));
    expect(second.out).toBeDefined();

    // A consultation during p2 means p3 needs no nudge.
    appendFileSync(
      join(stateDir, "sessions", "s2", "ledger.jsonl"),
      JSON.stringify({ v: 1, ts: Date.now(), kind: "decide", session_id: "s2", prompt_id: "p2", label: "x", action: "proceed" }) + "\n",
    );
    const third = run("user-prompt-submit", prompt("s2", "p3"));
    expect(third.out).toBeUndefined();
  });

  it("never nags about a slash command", () => {
    const h = run("user-prompt-submit", {
      ...prompt("s3", "p1", "plan"),
      prompt: "/jev:log --all",
    });
    expect(h.out).toBeUndefined();
  });

  it("records neither a bare slash command nor a harness notification as the user's request", () => {
    // Regression: a background agent's completion notice was stored as what the user asked,
    // tripped the injection screen and escalated an ordinary decision.
    run("user-prompt-submit", { ...prompt("s5", "p1"), prompt: "add retries to the fetcher" });
    run("user-prompt-submit", { ...prompt("s5", "p2"), prompt: "/jev:log" });
    run("user-prompt-submit", {
      ...prompt("s5", "p3"),
      prompt: "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>",
    });
    run("user-prompt-submit", { ...prompt("s5", "p4"), prompt: "/review the retry change" });
    const res = spawnSync(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))`, join(stateDir, "sessions", "s5", "prompts.jsonl")], { encoding: "utf8" });
    const texts = res.stdout.trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts).toEqual(["add retries to the fetcher", "/review the retry change"]);
  });

  it("redacts a secret out of the recorded prompt", () => {
    run("user-prompt-submit", {
      ...prompt("s4", "p1"),
      prompt: "use TYPESAFE_API_KEY=sk-abcdefghijklmnopqrst for the call",
    });
    const res = spawnSync(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))`, join(stateDir, "sessions", "s4", "prompts.jsonl")], { encoding: "utf8" });
    expect(res.stdout).not.toContain("sk-abcdefghijklmnopqrst");
    expect(res.stdout).toContain("REDACTED");
  });
});

describe("question router", () => {
  it("leaves multi-select questions alone", () => {
    const h = run(
      "question-router",
      ASK("r1", "p1", [{ ...SINGLE[0], multiSelect: true }]),
    );
    expect(h.out).toBeUndefined();
  });

  it("stands aside when Jev already said to ask the user", () => {
    const dir = join(stateDir, "sessions", "r2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ledger.jsonl"),
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        kind: "decide",
        session_id: "r2",
        prompt_id: "p1",
        label: "pkg-manager",
        action: "escalate_to_user",
      }) + "\n",
    );
    const h = run("question-router", ASK("r2", "p1", SINGLE));
    expect(h.out).toBeUndefined();
  });

  it("refuses at most once per turn, however the question is rephrased", () => {
    const first = run("question-router", ASK("r3", "p1", SINGLE));
    // Whatever Jev answered, a second distinct question set in the same turn is not routed.
    const rephrased = run(
      "question-router",
      ASK("r3", "p1", [{ ...SINGLE[0], question: "So which package manager do you want?" }]),
    );
    if (decision(first).permissionDecision === "deny") {
      expect(rephrased.out).toBeUndefined();
    }
    expect(first.status).toBe(0);
  });

  it("asks the user, rather than guessing, when Jev cannot be reached", () => {
    const h = run("question-router", ASK("r4", "p1", SINGLE), {
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
    });
    expect(h.out).toBeUndefined();
  });

  it("requires a Jev consultation first in ledger mode, without calling out", () => {
    const before = fake.requests.length;
    const h = run("question-router", ASK("r5", "p1", SINGLE), { JEV_ROUTER: "ledger" });
    expect(decision(h).permissionDecision).toBe("deny");
    expect(decision(h).permissionDecisionReason).toContain("mcp__plugin_jev_jev__decide");
    expect(fake.requests.length).toBe(before);
  });

  it("is disabled with the gates", () => {
    const h = run("question-router", ASK("r6", "p1", SINGLE), { JEV_ENFORCEMENT: "soft" });
    expect(h.out).toBeUndefined();
  });
});

describe("strict-mode gates", () => {
  const edit = (session: string, prompt: string): Record<string, unknown> => ({
    hook_event_name: "PreToolUse",
    session_id: session,
    prompt_id: prompt,
    tool_name: "Write",
    tool_input: { file_path: "/tmp/x.ts", content: "export const x = 1;\n" },
  });

  it("does nothing outside strict mode", () => {
    const h = run("mutation-gate", edit("m1", "p1"));
    expect(h.out).toBeUndefined();
  });

  it("fires at most once per turn", () => {
    const first = run("mutation-gate", edit("m2", "p1"), { JEV_ENFORCEMENT: "strict" });
    const second = run("mutation-gate", edit("m2", "p1"), { JEV_ENFORCEMENT: "strict" });
    // Whether the first refused depends on Jev; the second never can, because the claim
    // taken on the turn's first edit is what makes the retry pass.
    expect(second.out).toBeUndefined();
    expect(first.status).toBe(0);
  });

  it("never blocks a stop that is already being continued by a stop hook", () => {
    const h = run(
      "stop-backstop",
      {
        hook_event_name: "Stop",
        session_id: "st1",
        prompt_id: "p1",
        stop_hook_active: true,
        last_assistant_message: "I chose the streaming approach over reading the whole file.".repeat(4),
      },
      { JEV_ENFORCEMENT: "strict" },
    );
    expect(h.out).toBeUndefined();
  });
});

describe("failure handling", () => {
  it("exits 0 and stays silent on a payload it cannot parse", () => {
    const res = spawnSync(process.execPath, [HOOK, "plan-gate"], {
      input: "not json at all",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEV_STATE_DIR: stateDir },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  it("exits 0 on an unknown hook name", () => {
    const res = spawnSync(process.execPath, [HOOK, "no-such-hook"], {
      input: "{}",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    expect(res.status).toBe(0);
  });
});
