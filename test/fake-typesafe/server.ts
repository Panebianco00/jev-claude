/**
 * A stand-in for api.typesafe.ai, used by the unit tests and by the e2e suite.
 *
 * Answers are derived from the question id with a small hash, so the same question
 * always comes back with the same numbers and a test can assert exact values. A test
 * that needs a specific distribution puts it in `state.__answers` instead, and a test
 * that needs one failing request puts a scenario name in `state.__fail`.
 *
 * Dependency-free on purpose: this file is also loaded by scripts that run outside vitest.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type Scenario =
  | "ok"
  | "auth"
  | "invalid"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "slow"
  | "garbage";

export interface FakeServer {
  url: string;
  /** One entry per received request: the parsed body for /v1/systemone, `{method, url}` otherwise. */
  requests: unknown[];
  close(): Promise<void>;
  setScenario(s: Scenario): void;
}

/** Longer than any budget the plugin ever passes, so "slow" always loses the race. */
const SLOW_MS = 30_000;

const SCENARIOS = new Set<string>([
  "ok",
  "auth",
  "invalid",
  "rate_limit",
  "overloaded",
  "server",
  "slow",
  "garbage",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** FNV-1a: short, stable across runs and platforms, which is all a fixture needs. */
function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const confidenceOf = (h: number): number => round2(0.55 + ((h >>> 5) % 40) / 100);

/**
 * A distribution over `keys` whose winner is the argmax and whose rounded values sum to 1:
 * the winner absorbs the rounding residual.
 */
function distribute(h: number, keys: string[]): { probabilities: Record<string, number>; winner: string } {
  const n = keys.length;
  const winnerIndex = h % n;
  const winner = keys[winnerIndex] ?? "";
  const weights = keys.map((_, i) => (i === winnerIndex ? 3 * n + (h % 5) : 1 + ((h >>> (i % 16)) % 3)));
  const total = weights.reduce((a, b) => a + b, 0);

  const values = keys.map((_, i) => (i === winnerIndex ? 0 : round2((weights[i] ?? 0) / total)));
  const rest = values.reduce((a, b) => a + b, 0);
  values[winnerIndex] = round2(1 - rest);

  // Keys keep the order of the question's criteria, so a fixture reads like the question.
  const probabilities: Record<string, number> = {};
  keys.forEach((k, i) => {
    probabilities[k] = values[i] ?? 0;
  });
  return { probabilities, winner };
}

const describeLevel = (level: unknown): string =>
  typeof level === "string" ? level : level === null || level === undefined ? "" : JSON.stringify(level);

/** `undefined` when the question is well-formed; a reason when it is not. */
function rejectQuestion(name: string, q: unknown): string | undefined {
  if (!isRecord(q) || typeof q.type !== "string") return `questions.${name}: not a question object`;
  if (q.type === "choice" && (!isRecord(q.criteria) || Object.keys(q.criteria).length === 0)) {
    return `questions.${name}: choice criteria must be a non-empty object`;
  }
  if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) {
    return `questions.${name}: score criteria must be a list of at least two levels`;
  }
  return undefined;
}

function answerFor(name: string, q: Record<string, unknown>): Record<string, unknown> {
  const h = hash(name);
  switch (q.type) {
    case "noul":
      return { type: "noul", noul: round2((h % 101) / 100) };
    case "choice": {
      const labels = isRecord(q.criteria) ? Object.keys(q.criteria) : [];
      const { probabilities, winner } = distribute(h, labels);
      return { type: "choice", choice: winner, confidence: confidenceOf(h), probabilities };
    }
    case "score": {
      const levels = Array.isArray(q.criteria) ? q.criteria : [];
      const keys = levels.map((_, i) => String(i));
      const { probabilities } = distribute(h, keys);
      const score = round2(keys.reduce((sum, k, i) => sum + i * (probabilities[k] ?? 0), 0));
      const legend: Record<string, string> = {};
      levels.forEach((level, i) => {
        legend[String(i)] = describeLevel(level);
      });
      return { type: "score", score, confidence: confidenceOf(h), legend, probabilities };
    }
    default:
      // An answer of a type nobody has taught the client about yet; it must be ignored, not fatal.
      return { type: q.type };
  }
}

const AUTH_BODY = {
  error: { type: "authentication_error", message: "Invalid API key. Check the key at console.typesafe.ai/keys." },
};

const validationBody = (field: string, msg: string) => ({
  detail: [{ loc: ["body", field], msg, type: "value_error" }],
});

export async function startFakeTypeSafe(opts?: { scenario?: Scenario }): Promise<FakeServer> {
  let scenario: Scenario = opts?.scenario ?? "ok";
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let seq = 0;

  const send = (res: ServerResponse, status: number, body: unknown, requestId: string): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "x-typesafe-request-id": requestId,
    });
    res.end(text);
  };

  /** True when the scenario produced the whole response and the handler is done. */
  const playScenario = (s: Scenario, res: ServerResponse, requestId: string): boolean => {
    switch (s) {
      case "ok":
        return false;
      case "auth":
        send(res, 401, AUTH_BODY, requestId);
        return true;
      case "invalid":
        send(res, 422, validationBody("questions", "Value error, questions must not be empty"), requestId);
        return true;
      case "rate_limit":
        send(res, 429, { error: { type: "rate_limit_error", message: "Rate limit exceeded." } }, requestId);
        return true;
      case "overloaded":
        send(res, 529, { error: { type: "overloaded_error", message: "Overloaded." } }, requestId);
        return true;
      case "server":
        send(res, 500, { error: { type: "api_error", message: "Internal server error." } }, requestId);
        return true;
      case "garbage":
        res.writeHead(200, { "content-type": "text/plain", "x-typesafe-request-id": requestId });
        res.end("<!doctype html><html>gateway says hello</html>");
        return true;
      case "slow": {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(res, 200, { model: "jev-latest", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }, requestId);
        }, SLOW_MS);
        timers.add(timer);
        res.on("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return true;
      }
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = `req_fake_${++seq}`;
    const path = (req.url ?? "").split("?")[0] ?? "";

    if (req.method === "GET" && path === "/v1/models") {
      requests.push({ method: "GET", url: path });
      send(
        res,
        200,
        [
          { name: "jev-latest", description: "Alias for the current Jev model.", release_date: "2025-01-01" },
          { name: "jev-1", description: "First Jev release.", release_date: "2024-11-01" },
        ],
        requestId,
      );
      return;
    }

    if (req.method !== "POST" || path !== "/v1/systemone") {
      requests.push({ method: req.method, url: path });
      send(res, 404, { error: { type: "not_found_error", message: `No route for ${req.method} ${path}` } }, requestId);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    requests.push(body);

    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !/^Bearer\s+\S/.test(auth)) {
      send(res, 401, AUTH_BODY, requestId);
      return;
    }

    const state = isRecord(body) ? body.state : undefined;
    const override = isRecord(state) && typeof state.__fail === "string" ? state.__fail : undefined;
    const effective: Scenario = override !== undefined && SCENARIOS.has(override) ? (override as Scenario) : scenario;
    if (playScenario(effective, res, requestId)) return;

    if (!isRecord(body) || !("state" in body)) {
      send(res, 422, validationBody("state", "Field required"), requestId);
      return;
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      send(res, 422, validationBody("model", "Field required"), requestId);
      return;
    }
    const questions = body.questions;
    if (!isRecord(questions) || Object.keys(questions).length === 0) {
      send(res, 422, validationBody("questions", "Value error, questions must not be empty"), requestId);
      return;
    }
    for (const [name, q] of Object.entries(questions)) {
      const reason = rejectQuestion(name, q);
      if (reason !== undefined) {
        send(res, 422, validationBody("questions", reason), requestId);
        return;
      }
    }

    const overrides = isRecord(state) && isRecord(state.__answers) ? state.__answers : {};
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(questions)) {
      const given = overrides[name];
      if (given !== undefined) {
        // Verbatim, including answer types the client is not expected to understand.
        answers[name] = typeof given === "number" ? { type: "noul", noul: given } : given;
        continue;
      }
      answers[name] = answerFor(name, q as Record<string, unknown>);
    }

    send(
      res,
      200,
      {
        model: body.model,
        answers,
        usage: {
          input_tokens: JSON.stringify(body.state ?? null).length,
          output_tokens: Object.keys(questions).length * 4,
        },
      },
      requestId,
    );
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } }, "req_fake_error");
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake TypeSafe server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setScenario(s: Scenario) {
      scenario = s;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // A "slow" request holds its socket open; closing the server would otherwise hang.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
