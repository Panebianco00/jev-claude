/**
 * Scrubbing and size control for everything that leaves the machine or lands in
 * the ledger.
 *
 * The patterns are deliberately narrow. Over-redaction is not free: the state is
 * the evidence Jev reasons over, so a sentence mangled because it contained the
 * word "token" costs an answer.
 */

interface Pattern {
  kind: string;
  re: RegExp;
  /** Groups to keep verbatim in front of the marker, e.g. the assignment's name. */
  keep?: number;
}

const PATTERNS: Pattern[] = [
  {
    kind: "private_key",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  // Name, separator and an optional auth scheme survive; only the value goes.
  {
    kind: "secret",
    re: /\b([\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|authorization))(\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+|Token\s+)?)[^\s"',;]+/gi,
    keep: 2,
  },
  { kind: "api_key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "aws_key_id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
];

export function redactText(s: string): string {
  let out = s;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      const marker = `[REDACTED:${p.kind}]`;
      if (p.keep === undefined) return marker;
      const groups = args.slice(1, 1 + p.keep).map((g) => (typeof g === "string" ? g : ""));
      return groups.join("") + marker;
    });
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
    return out;
  }
  return value;
}

/* -------------------------------------------------------------- truncation */

export interface TruncateResult {
  value: Record<string, unknown>;
  truncated: string[];
}

/** Fields Jev needs most, kept even when everything else has to go. */
const PRIORITY = ["user_request", "user_request_verbatim", "constraints", "question", "plan"];

const DEFAULT_MAX_FIELD = 4000;
const DEFAULT_MAX_TOTAL = 12000;

/** Below this a shortened field says nothing useful, so it is dropped instead. */
const MIN_KEEP = 40;

function jsonLength(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}

function shorten(s: string, keep: number): string {
  const kept = s.slice(0, Math.max(0, keep));
  return `${kept} …[truncated, ${s.length - kept.length} chars dropped]`;
}

/**
 * Whole fields only: a string cut in the middle of a sentence reads as if the
 * author stopped there, which is worse evidence than an explicit gap.
 */
export function truncateState(
  state: Record<string, unknown>,
  opts?: { maxTotal?: number; maxField?: number },
): TruncateResult {
  const maxField = opts?.maxField ?? DEFAULT_MAX_FIELD;
  const maxTotal = opts?.maxTotal ?? DEFAULT_MAX_TOTAL;

  const keys = Object.keys(state);
  const order = [
    ...PRIORITY.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PRIORITY.includes(k)),
  ];

  const value: Record<string, unknown> = {};
  const truncated = new Set<string>();

  for (const key of order) {
    const raw = state[key];
    if (raw === undefined) continue;

    let candidate: unknown = raw;
    if (typeof raw === "string") {
      if (raw.length > maxField) {
        candidate = shorten(raw, maxField);
        truncated.add(key);
      }
    } else if (jsonLength(raw) > maxField) {
      // Nested values stay structured, so there is nothing to shorten: drop it.
      truncated.add(key);
      continue;
    }

    value[key] = candidate;
    if (jsonLength(value) <= maxTotal) continue;

    truncated.add(key);
    if (typeof candidate !== "string") {
      delete value[key];
      continue;
    }
    if (!fitToTotal(value, key, candidate, maxTotal)) delete value[key];
  }

  return { value, truncated: [...truncated] };
}

/**
 * Shrinks value[key] until the whole record serialises within maxTotal. JSON
 * escaping means a character removed is not always a character saved, hence the
 * loop rather than one subtraction.
 */
function fitToTotal(
  value: Record<string, unknown>,
  key: string,
  source: string,
  maxTotal: number,
): boolean {
  let keep = source.length;
  for (let i = 0; i < 16; i++) {
    const over = jsonLength(value) - maxTotal;
    if (over <= 0) return true;
    keep = keep - over - 8;
    if (keep < MIN_KEEP) return false;
    value[key] = shorten(source, keep);
  }
  return jsonLength(value) <= maxTotal;
}

/* ---------------------------------------------------------------- origin */

const EXTERNAL_KEY =
  /file|code|snippet|content|excerpt|readme|doc|page|web|fetch|output|log|diff|plan|candidate/i;

/** Length above which a string is almost certainly quoted material, not a fact. */
const EXTERNAL_LEN = 400;

/**
 * Decides whether the injection-screening question is worth asking. A false
 * positive costs one extra Noul; a false negative means third-party text is read
 * as evidence, so this leans towards true.
 */
export function looksExternal(state: Record<string, unknown>): boolean {
  return scanExternal(state, 0);
}

function scanExternal(value: unknown, depth: number): boolean {
  if (typeof value === "string") return value.length > EXTERNAL_LEN;
  if (depth > 6) return false;
  if (Array.isArray(value)) return value.some((v) => scanExternal(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (EXTERNAL_KEY.test(k)) return true;
      if (scanExternal(v, depth + 1)) return true;
    }
  }
  return false;
}
