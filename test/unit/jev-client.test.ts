import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@typesafe-ai/sdk";
import { choice, noul, score } from "@typesafe-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STDERR_LOGGER, ask, classifyError } from "../../src/shared/jev-client.ts";
import { startFakeTypeSafe } from "../fake-typesafe/server.ts";
import type { FakeServer, Scenario } from "../fake-typesafe/server.ts";
import type { JevErrorCode, JevSuccess } from "../../src/shared/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
// An empty state dir keeps resolveApiKey away from a real ~/.claude/jev/credentials.json.
const stateDir = join(here, "..", ".tmp", "jev-client");

let fake: FakeServer;

const envWith = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  JEV_STATE_DIR: stateDir,
  TYPESAFE_BASE_URL: fake.url,
  TYPESAFE_API_KEY: "sk-test-fake",
  ...extra,
});

const QUESTIONS = {
  decision: choice("Which validation library?", {
    zod: "the incumbent",
    valibot: "smaller bundle",
    none_of_these: "neither fits",
  }),
  reversible_locally: noul("Can this be undone with one edit?"),
  coverage: score("How completely does the plan cover the request?", ["not at all", "partly", "fully"]),
} as const;

beforeAll(async () => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  fake = await startFakeTypeSafe();
});

afterAll(async () => {
  await fake.close();
  rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  fake.requests.length = 0;
  fake.setScenario("ok");
  vi.restoreAllMocks();
});

const succeed = (r: Awaited<ReturnType<typeof ask>>): JevSuccess => {
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r;
};

describe("ask", () => {
  it("splits a mixed answer set into nouls, choices and scores", async () => {
    const result = succeed(
      await ask({
        questions: QUESTIONS,
        state: { task: "pick a validation library" },
        budgetMs: 5000,
        env: envWith(),
      }),
    );

    expect(Object.keys(result.nouls)).toEqual(["reversible_locally"]);
    expect(Object.keys(result.choices)).toEqual(["decision"]);
    expect(Object.keys(result.scores)).toEqual(["coverage"]);

    // A noul's value is the bare probability, not the wrapper object.
    expect(result.nouls["reversible_locally"]).toBe(0.19);

    const decision = result.choices["decision"];
    expect(decision).toEqual({
      choice: "valibot",
      confidence: 0.86,
      probabilities: { zod: 0.15, valibot: 0.7, none_of_these: 0.15 },
    });
    expect(Object.keys(decision?.probabilities ?? {})).toEqual(["zod", "valibot", "none_of_these"]);

    const coverage = result.scores["coverage"];
    expect(coverage).toEqual({
      score: 1,
      confidence: 0.55,
      legend: { "0": "not at all", "1": "partly", "2": "fully" },
      probabilities: { "0": 0.13, "1": 0.74, "2": 0.13 },
    });

    expect(result.model).toBe("jev-latest");
    expect(result.usage).toEqual({ input_tokens: 36, output_tokens: 12 });
    expect(result.requestId).toMatch(/^req_fake_\d+$/);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for the same question ids", async () => {
    const args = { questions: QUESTIONS, state: { task: "again" }, budgetMs: 5000, env: envWith() };
    const first = succeed(await ask(args));
    const second = succeed(await ask(args));
    expect(second.nouls).toEqual(first.nouls);
    expect(second.choices).toEqual(first.choices);
    expect(second.scores).toEqual(first.scores);
  });

  it("takes __answers verbatim and ignores an answer type it does not model", async () => {
    const result = succeed(
      await ask({
        questions: {
          gate: noul("Is this safe?"),
          decision: QUESTIONS.decision,
          oracle: noul("What does the future hold?"),
        },
        state: {
          __answers: {
            gate: 0.91,
            decision: { type: "choice", choice: "zod", confidence: 0.95, probabilities: { zod: 0.95, valibot: 0.05 } },
            oracle: { type: "prophecy", vision: "rain" },
          },
        },
        budgetMs: 5000,
        env: envWith(),
      }),
    );

    expect(result.nouls).toEqual({ gate: 0.91 });
    expect(result.choices["decision"]?.choice).toBe("zod");
    expect(result.scores).toEqual({});
    expect(Object.keys(result.nouls)).not.toContain("oracle");
  });

  it("sends the questions verbatim plus a model field", async () => {
    await ask({ questions: QUESTIONS, state: { task: "audit" }, budgetMs: 5000, env: envWith() });

    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0] as { questions: unknown; model: unknown; state: unknown };
    expect(body.questions).toEqual(QUESTIONS);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ task: "audit" });
  });

  it("honours TYPESAFE_DEFAULT_MODEL from the passed env", async () => {
    const result = succeed(
      await ask({
        questions: { gate: noul("ok?") },
        state: "text state",
        budgetMs: 5000,
        env: envWith({ TYPESAFE_DEFAULT_MODEL: "jev-1" }),
      }),
    );
    expect(result.model).toBe("jev-1");
    expect((fake.requests[0] as { model: unknown }).model).toBe("jev-1");
  });

  it("reports no_api_key without constructing a client or sending a request", async () => {
    const result = await ask({
      questions: QUESTIONS,
      state: {},
      budgetMs: 5000,
      env: { JEV_STATE_DIR: stateDir, TYPESAFE_BASE_URL: fake.url },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_api_key");
    expect(result.userFixable).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  const scenarios: [Scenario, JevErrorCode, boolean, number | undefined][] = [
    ["auth", "auth", true, 401],
    ["invalid", "invalid_request", true, 422],
    ["rate_limit", "rate_limit", false, 429],
    ["overloaded", "overloaded", false, 529],
    ["server", "server", false, 500],
    ["garbage", "server", false, undefined],
  ];

  it.each(scenarios)("maps the %s scenario to code %s", async (scenario, code, userFixable, status) => {
    const result = await ask({
      questions: { gate: noul("ok?") },
      // __fail applies to this request only, so the scenarios stay independent.
      state: { __fail: scenario },
      budgetMs: 5000,
      maxRetries: 0,
      env: envWith(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(result.userFixable).toBe(userFixable);
    expect(result.status).toBe(status);
    expect(result.message).not.toBe("");
    expect(result.requestId).toMatch(/^req_fake_\d+$/);
  });

  it("gives up at budgetMs rather than at the SDK's per-attempt timeout", async () => {
    const started = Date.now();
    const result = await ask({
      questions: { gate: noul("ok?") },
      state: { __fail: "slow" },
      budgetMs: 400,
      maxRetries: 2,
      env: envWith(),
    });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("timeout");
    expect(result.userFixable).toBe(false);
    // The SDK default would be 10s per attempt.
    expect(elapsed).toBeLessThan(2000);
    // Three attempts at 133ms plus the SDK's 0.5s and 1s backoffs would take at least 1.5s:
    // only a total AbortSignal deadline can come back this fast.
    expect(elapsed).toBeLessThan(1200);
  });

  it("classifies a connection failure to a closed port as network", async () => {
    const result = await ask({
      questions: { gate: noul("ok?") },
      state: {},
      budgetMs: 2000,
      maxRetries: 0,
      env: envWith({ TYPESAFE_BASE_URL: "http://127.0.0.1:1" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("network");
    expect(result.status).toBeUndefined();
  });
});

describe("classifyError", () => {
  it("reads 529 as overloaded and other 5xx as server", () => {
    const overloaded = classifyError(APIError.fromResponse(529, { error: { message: "busy" } }, new Headers()));
    expect(overloaded.code).toBe("overloaded");
    expect(overloaded.status).toBe(529);
    expect(overloaded.userFixable).toBe(false);

    expect(classifyError(APIError.fromResponse(503, undefined, new Headers())).code).toBe("server");
  });

  it("captures the request id an APIError exposes", () => {
    const headers = new Headers({ "x-typesafe-request-id": "req_abc" });
    expect(classifyError(APIError.fromResponse(401, undefined, headers)).requestId).toBe("req_abc");
  });

  it("falls back to unknown for anything else", () => {
    const result = classifyError(new Error("boom"));
    expect(result).toEqual({
      ok: false,
      code: "unknown",
      message: "boom",
      status: undefined,
      requestId: undefined,
      userFixable: false,
    });
    expect(classifyError(APIError.fromResponse(404, undefined, new Headers())).code).toBe("unknown");
  });
});

describe("STDERR_LOGGER", () => {
  it("writes every level to stderr and never to stdout", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    STDERR_LOGGER.debug("request", { body: 1 });
    STDERR_LOGGER.info("response");
    STDERR_LOGGER.warn("retrying");
    STDERR_LOGGER.error("failed");

    expect(err).toHaveBeenCalledTimes(4);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain("[jev:debug] request");
  });
});
