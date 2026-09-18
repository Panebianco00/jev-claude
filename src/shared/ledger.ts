/**
 * Turning a tool call into one ledger line, and keeping that line small.
 *
 * The post-tool hook is the only place the three payload sources meet: the record file
 * the server wrote, the `jev-record:` line in the tool result, and — when neither
 * survived — the tool input alone. Reading the record is deliberately liberal: the
 * server owns its shape, and a ledger line is worth more than a strict parse.
 */
import { Buffer } from "node:buffer";
import type {
  Action,
  CallContext,
  HookInput,
  JevErrorCode,
  LedgerEntry,
  PermissionMode,
  Stakes,
  Verdict,
} from "./types.ts";

const MAX_LINE_BYTES = 4000;

/** Anchored so a line of prose merely mentioning the marker cannot be mistaken for one. */
const RECORD_LINE = /^[ \t]*jev-record:[ \t]*(\{.*\})[ \t]*$/;

const ACTIONS = new Set<string>([
  "proceed",
  "proceed_and_flag",
  "revise",
  "confirm",
  "escalate_to_user",
  "proceed_unverified",
]);
const STAKES = new Set<string>(["low", "medium", "high"]);
const VERDICTS = new Set<string>(["yes", "no", "uncertain"]);

/* -------------------------------------------------------------- scoping */

/** Identity of the unit of work a one-shot decision is scoped to. */
export function turnKey(input: HookInput): string {
  if (input.agent_id) return `agent:${input.agent_id}`;
  if (input.prompt_id) return `prompt:${input.prompt_id}`;
  return "session";
}

/**
 * The entries belonging to the current turn.
 *
 * A subagent's entries carry its `agent_id` and must not count towards the main
 * thread's turn, hence the explicit exclusion in the prompt_id branch.
 */
export function thisTurn<T extends { ts: number; prompt_id?: string; agent_id?: string }>(
  entries: T[],
  input: HookInput,
  fallbackSinceTs = 0,
): T[] {
  if (input.agent_id) {
    const id = input.agent_id;
    return entries.filter((e) => e.agent_id === id);
  }
  if (input.prompt_id) {
    const id = input.prompt_id;
    return entries.filter((e) => e.prompt_id === id && !e.agent_id);
  }
  return entries.filter((e) => typeof e.ts === "number" && e.ts >= fallbackSinceTs);
}

/* ------------------------------------------------------------ shrinking */

function byteLength(entry: LedgerEntry): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clip(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

/**
 * Bring an entry under the line budget, dropping the least useful field first.
 * The budget is enforced rather than assumed: appends rely on a single write staying
 * small enough that two writers cannot interleave within one line.
 */
export function shrinkLedgerEntry(entry: LedgerEntry, maxBytes = MAX_LINE_BYTES): LedgerEntry {
  if (byteLength(entry) <= maxBytes) return entry;

  // Set the flag up front so every size check below includes its own cost.
  const e: LedgerEntry = { ...entry, truncated: true };

  const stages: ((x: LedgerEntry) => void)[] = [
    (x) => {
      delete x.option_ids;
    },
    (x) => {
      delete x.choice_text;
      delete x.why;
    },
    (x) => {
      if (x.checks) x.checks = x.checks.slice(0, 8).map((c) => ({ ...c, id: clip(c.id, 40) }));
      if (x.scores) x.scores = x.scores.slice(0, 4).map((s) => ({ ...s, id: clip(s.id, 40) }));
    },
    (x) => {
      delete x.checks;
      delete x.scores;
      delete x.model;
    },
    (x) => {
      x.label = clip(x.label, 200);
    },
  ];

  for (const stage of stages) {
    stage(e);
    if (byteLength(e) <= maxBytes) return e;
  }

  const skeleton: LedgerEntry = {
    v: 1,
    ts: e.ts,
    kind: e.kind,
    session_id: clip(e.session_id, 64),
    label: e.label,
    action: e.action,
    truncated: true,
  };
  for (let n = 200; n >= 0 && byteLength(skeleton) > maxBytes; n = Math.floor(n / 2) - 1) {
    skeleton.label = clip(skeleton.label, Math.max(0, n));
  }
  return skeleton;
}

/* ------------------------------------------------------------- building */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pick(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function asStakes(v: unknown): Stakes | undefined {
  return typeof v === "string" && STAKES.has(v) ? (v as Stakes) : undefined;
}

function asChecks(v: unknown): { id: string; p: number; verdict: Verdict }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { id: string; p: number; verdict: Verdict }[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]);
    const p = num(raw["p"]);
    const verdict = raw["verdict"];
    if (id === undefined || p === undefined || typeof verdict !== "string" || !VERDICTS.has(verdict)) {
      continue;
    }
    out.push({ id, p, verdict: verdict as Verdict });
  }
  return out.length ? out : undefined;
}

function asScores(v: unknown): { id: string; score: number; status: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { id: string; score: number; status: string }[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const id = str(raw["id"]);
    const score = num(raw["score"]);
    const status = str(raw["status"]);
    if (id === undefined || score === undefined || status === undefined) continue;
    out.push({ id, score, status });
  }
  return out.length ? out : undefined;
}

function asOptionIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

/** The last `jev-record:` line of a tool result, parsed. */
function recordFromText(text: string): Record<string, unknown> | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = RECORD_LINE.exec(line.replace(/\r$/, ""));
    if (!m || m[1] === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(m[1]);
      if (isRecord(parsed)) return parsed;
    } catch {
      // A malformed marker line is treated as absent: the next source takes over.
    }
  }
  return undefined;
}

export interface BuildLedgerArgs {
  input: HookInput;
  ctx?: CallContext;
  record?: unknown;
  toolInput?: Record<string, unknown>;
  toolResponseText?: string;
}

export function buildLedgerEntry(args: BuildLedgerArgs): LedgerEntry {
  const { input, ctx, toolInput } = args;

  const rec: Record<string, unknown> | undefined = isRecord(args.record)
    ? args.record
    : args.toolResponseText
      ? recordFromText(args.toolResponseText)
      : undefined;

  const declaredKind = typeof toolInput?.["decision"] === "string" ? "decide" : undefined;
  const recKind = rec ? str(pick(rec, "kind", "tool")) : undefined;
  const kind: "decide" | "check" = declaredKind ?? (recKind === "decide" ? "decide" : "check");

  const label =
    (rec ? str(rec["label"]) : undefined) ??
    str(toolInput?.["decision"]) ??
    str(toolInput?.["label"]) ??
    "(unlabelled)";

  const recAction = rec ? str(pick(rec, "action")) : undefined;
  const action: Action =
    recAction !== undefined && ACTIONS.has(recAction) ? (recAction as Action) : "proceed_unverified";

  const entry: LedgerEntry = {
    v: 1,
    ts: Date.now(),
    kind,
    session_id: ctx?.session_id ?? input.session_id ?? "",
    label,
    action,
  };

  const promptId = ctx?.prompt_id ?? input.prompt_id;
  if (promptId !== undefined) entry.prompt_id = promptId;
  const agentId = ctx?.agent_id ?? input.agent_id;
  if (agentId !== undefined) entry.agent_id = agentId;
  const agentType = ctx?.agent_type ?? input.agent_type;
  if (agentType !== undefined) entry.agent_type = agentType;
  const mode: PermissionMode | undefined = ctx?.permission_mode ?? input.permission_mode;
  if (mode !== undefined) entry.permission_mode = mode;
  if (input.tool_use_id !== undefined) entry.tool_use_id = input.tool_use_id;

  const declared = asStakes(toolInput?.["stakes"]);
  if (declared !== undefined) entry.declared_stakes = declared;

  if (rec) {
    const choice = str(rec["choice"]);
    if (choice !== undefined) entry.choice = choice;
    const choiceText = str(pick(rec, "choice_text", "choiceText"));
    if (choiceText !== undefined) entry.choice_text = choiceText.slice(0, 300);
    const why = str(rec["why"]);
    if (why !== undefined) entry.why = why.slice(0, 200);
    const p1 = num(pick(rec, "p1", "p"));
    if (p1 !== undefined) entry.p1 = p1;
    const margin = num(rec["margin"]);
    if (margin !== undefined) entry.margin = margin;
    const confidence = num(pick(rec, "confidence", "conf"));
    if (confidence !== undefined) entry.confidence = confidence;
    const recDeclared = asStakes(pick(rec, "declared_stakes", "declaredStakes"));
    if (recDeclared !== undefined) entry.declared_stakes = recDeclared;
    const effective = asStakes(pick(rec, "effective_stakes", "effectiveStakes"));
    if (effective !== undefined) entry.effective_stakes = effective;
    const optionIds = asOptionIds(pick(rec, "option_ids", "optionIds"));
    if (optionIds !== undefined) entry.option_ids = optionIds;
    const checks = asChecks(rec["checks"]);
    if (checks !== undefined) entry.checks = checks;
    const scores = asScores(rec["scores"]);
    if (scores !== undefined) entry.scores = scores;
    const ms = num(rec["ms"]);
    if (ms !== undefined) entry.ms = ms;
    const model = str(rec["model"]);
    if (model !== undefined) entry.model = model;
    const error = str(rec["error"]);
    if (error !== undefined) entry.error = error as JevErrorCode;
  } else if (toolInput) {
    const optionIds = asOptionIds(
      Array.isArray(toolInput["options"])
        ? toolInput["options"].map((o) => (isRecord(o) ? o["id"] : undefined))
        : undefined,
    );
    if (optionIds !== undefined) entry.option_ids = optionIds;
  }

  return entry;
}

/* ------------------------------------------------------------- response */

function extract(value: unknown, depth: number): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (isRecord(item) && typeof item["text"] === "string") parts.push(item["text"]);
    }
    return parts.filter((p) => p.length > 0).join("\n");
  }
  if (isRecord(value) && value["content"] !== undefined) {
    return extract(value["content"], depth + 1);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Flatten whatever the host put in `tool_response` into searchable text. */
export function extractResponseText(toolResponse: unknown): string {
  try {
    return extract(toolResponse, 0);
  } catch {
    return "";
  }
}
