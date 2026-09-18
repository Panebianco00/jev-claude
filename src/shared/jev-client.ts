/**
 * The only module that talks to TypeSafe.
 *
 * Everything here exists to keep a Jev call from taking down its host: the client is built
 * per call rather than at import, the whole call is bounded by one wall-clock budget, and
 * every failure comes back as a value with a code the policy can reason about.
 */
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { EntryType, Logger, Questions } from "@typesafe-ai/sdk";
import { resolveApiKey } from "./config.ts";
import type { ChoiceAnswer, Config, JevErrorCode, JevFailure, JevResult, ScoreAnswer } from "./types.ts";

export interface AskArgs {
  /** Already-built Jev question objects, keyed by answer name. */
  questions: Record<string, unknown>;
  state: unknown;
  /** Total wall-clock budget for the whole call, retries included. */
  budgetMs: number;
  maxRetries?: number;
  cfg?: Config;
  env?: NodeJS.ProcessEnv;
}

/**
 * The SDK's default logger writes debug and info through console.debug/console.info, i.e. to
 * stdout. The MCP server speaks JSON-RPC on stdout, so one info line would corrupt the stream.
 */
export const STDERR_LOGGER: Logger = {
  debug: (message, ...args) => emit("debug", message, args),
  info: (message, ...args) => emit("info", message, args),
  warn: (message, ...args) => emit("warn", message, args),
  error: (message, ...args) => emit("error", message, args),
};

function emit(level: string, message: string, args: unknown[]): void {
  const extra = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: 200 })));
  try {
    process.stderr.write([`[jev:${level}]`, message, ...extra].join(" ") + "\n");
  } catch {
    // A closed or full stderr (EPIPE when the host has gone away) must not fail a decision.
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Empty and whitespace-only values are unset, matching how the SDK reads its own env vars. */
function text(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function ask(args: AskArgs): Promise<JevResult> {
  const started = Date.now();
  const maxRetries = args.maxRetries ?? 1;
  const key = text(resolveApiKey(args.cfg, args.env).key);

  if (key === undefined) {
    // No client is constructed: its constructor throws without a key, and this module is
    // imported by an alwaysLoad MCP server, where a throw would mean the tools do not exist.
    return {
      ok: false,
      code: "no_api_key",
      message:
        "No TypeSafe API key configured. Set TYPESAFE_API_KEY or run `jev-doctor set-key` (get one at https://console.typesafe.ai/keys).",
      userFixable: true,
    };
  }

  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient({
      apiKey: key,
      baseURL: args.cfg?.baseUrl ?? text(args.env?.TYPESAFE_BASE_URL),
      defaultModel: args.cfg?.model ?? text(args.env?.TYPESAFE_DEFAULT_MODEL),
      logger: STDERR_LOGGER,
      // Explicit, so TYPESAFE_LOG_LEVEL in the environment can never turn request bodies on.
      logLevel: args.cfg?.debug ? "debug" : "warn",
    });
  } catch (err) {
    return classifyError(err);
  }

  // `timeout` is per attempt and the SDK has no total budget, so the deadline is the signal;
  // the per-attempt timeout only keeps a single stalled attempt from eating the whole budget.
  const perAttemptMs = Math.max(1, Math.floor(args.budgetMs / (maxRetries + 1)));

  try {
    const { data, requestId } = await client
      .systemOne(
        {
          // Both shapes are built by questions.ts, which owns their validity.
          state: args.state as EntryType,
          questions: args.questions as Questions,
        },
        {
          signal: AbortSignal.timeout(args.budgetMs),
          timeout: perAttemptMs,
          retry: { maxRetries },
        },
      )
      .withResponse();

    const body: unknown = data;
    const answers = isRecord(body) ? body.answers : undefined;
    if (!isRecord(answers)) {
      return {
        ok: false,
        code: "server",
        message: "TypeSafe returned a body without an `answers` object.",
        requestId,
        userFixable: false,
      };
    }

    const split = splitAnswers(answers);
    const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
    return {
      ok: true,
      model: isRecord(body) && typeof body.model === "string" ? body.model : client.defaultModel,
      nouls: split.nouls,
      choices: split.choices,
      scores: split.scores,
      usage: {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
      ms: Date.now() - started,
      requestId,
    };
  } catch (err) {
    return classifyError(err);
  }
}

interface SplitAnswers {
  nouls: Record<string, number>;
  choices: Record<string, ChoiceAnswer>;
  scores: Record<string, ScoreAnswer>;
}

function splitAnswers(answers: Record<string, unknown>): SplitAnswers {
  const out: SplitAnswers = { nouls: {}, choices: {}, scores: {} };
  for (const [name, raw] of Object.entries(answers)) {
    if (!isRecord(raw)) continue;
    switch (raw.type) {
      case "noul":
        if (typeof raw.noul === "number") out.nouls[name] = raw.noul;
        break;
      case "choice":
        if (typeof raw.choice === "string" && typeof raw.confidence === "number" && isRecord(raw.probabilities)) {
          out.choices[name] = {
            choice: raw.choice,
            confidence: raw.confidence,
            probabilities: numbers(raw.probabilities),
          };
        }
        break;
      case "score":
        if (typeof raw.score === "number" && typeof raw.confidence === "number" && isRecord(raw.probabilities)) {
          out.scores[name] = {
            score: raw.score,
            confidence: raw.confidence,
            legend: isRecord(raw.legend) ? strings(raw.legend) : {},
            probabilities: numbers(raw.probabilities),
          };
        }
        break;
      default:
      // An answer type this version does not model is dropped: the API may grow one before we do.
    }
  }
  return out;
}

function numbers(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === "number") out[k] = v;
  return out;
}

function strings(source: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

export function classifyError(err: unknown): JevFailure {
  const status = err instanceof APIError ? err.status : undefined;
  const requestId = isRecord(err) && typeof err.requestId === "string" ? err.requestId : undefined;
  const message = err instanceof Error ? err.message : String(err);

  const as = (code: JevErrorCode, userFixable = false): JevFailure => ({
    ok: false,
    code,
    message,
    status,
    requestId,
    userFixable,
  });

  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return as("auth", true);
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) return as("invalid_request", true);
  if (err instanceof RateLimitError) return as("rate_limit");
  // 529 arrives as an InternalServerError, so it has to be recognised before that check.
  if (status === 529) return as("overloaded");
  if (err instanceof InternalServerError) return as("server");
  // APITimeoutError extends APIConnectionError; the timeout reading is the specific one.
  if (err instanceof APITimeoutError || err instanceof APIUserAbortError) return as("timeout");
  if (err instanceof APIConnectionError) return as("network");
  if (status !== undefined && status >= 500) return as("server");
  return as("unknown");
}
