/**
 * Configuration, state-dir and API-key resolution.
 *
 * Everything here runs inside hooks that must fail open, so nothing in this file
 * throws: a missing, unreadable or malformed file, and an invalid value of any
 * kind, all degrade to the previous layer's value.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THRESHOLDS } from "./policy.ts";
import type {
  Authority,
  ConfAxis,
  Config,
  Enforcement,
  FailMode,
  RouterMode,
  Thresholds,
} from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  enforcement: "standard",
  authority: "autonomous",
  fail: "open",
  confAxis: "confidence",
  model: undefined,
  baseUrl: undefined,
  stateDir: undefined,
  retainDays: 7,
  debug: false,
  timeoutMs: 6000,
  planReview: true,
  planMaxDenies: 2,
  router: "stated",
  routerMaxPerTurn: 1,
  mutationGate: false,
  stopBackstop: false,
  bashGate: true,
  dependencyGate: true,
  subagentSkip: ["statusline-setup", "output-style-setup", "claude-code-guide"],
  thresholds: DEFAULT_THRESHOLDS,
};

/** Total ms per surface. Invariant: each is at least 2s under its hook timeout. */
export const BUDGETS: Record<
  "server" | "planGate" | "router" | "mutationGate" | "stopBackstop" | "bashGate",
  number
> = {
  server: 6000,
  planGate: 8000,
  router: 6000,
  mutationGate: 5000,
  stopBackstop: 6000,
  bashGate: 6000,
};

/* ------------------------------------------------------------- coercion */

const ENFORCEMENTS: readonly Enforcement[] = ["off", "soft", "standard", "strict"];
const AUTHORITIES: readonly Authority[] = ["autonomous", "advisory"];
const FAIL_MODES: readonly FailMode[] = ["open", "closed"];
const CONF_AXES: readonly ConfAxis[] = ["confidence", "top_probability", "min"];
const ROUTER_MODES: readonly RouterMode[] = ["stated", "ledger", "off"];

const TRUE_WORDS = new Set(["1", "true", "yes"]);
const FALSE_WORDS = new Set(["0", "false", "no"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = asString(v)?.toLowerCase();
  if (s === undefined) return undefined;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return undefined;
}

function asNumber(v: unknown, min: number): number | undefined {
  const n = typeof v === "number" ? v : Number(asString(v) ?? Number.NaN);
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  const s = asString(v)?.toLowerCase();
  return allowed.find((a) => a === s);
}

function asList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const items = v.map(asString).filter((s): s is string => s !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const s = asString(v);
  if (s === undefined) return undefined;
  const items = s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  return items.length > 0 ? items : undefined;
}

/** JSON that may arrive already parsed (config file) or as a string (env var). */
function asJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/**
 * Deep merge that only ever writes finite numbers, so a malformed patch can
 * replace a threshold but can never turn one into a string or delete a group.
 */
function mergeNumbers(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const current = out[k];
    if (isRecord(v) && isRecord(current)) out[k] = mergeNumbers(current, v);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/* ---------------------------------------------------------------- fields */

interface Field {
  /** JEV_* / TYPESAFE_* variable. */
  env: string;
  /** CLAUDE_PLUGIN_OPTION_* variable, derived from the config key. */
  option: string;
  /** Returns false when the value was unusable, so the layer counts as absent. */
  apply(cfg: Config, raw: unknown): boolean;
}

function field(env: string, option: string, apply: Field["apply"]): Field {
  return { env, option, apply };
}

/**
 * The only recognised keys, for files and for env alike. `apiKey` is absent on
 * purpose: a key never comes from a config file, only from the environment or
 * from credentials.json.
 */
const FIELDS: Record<string, Field> = {
  enforcement: field("JEV_ENFORCEMENT", "CLAUDE_PLUGIN_OPTION_ENFORCEMENT", (cfg, raw) => {
    const v = asEnum(raw, ENFORCEMENTS);
    if (v === undefined) return false;
    cfg.enforcement = v;
    return true;
  }),
  authority: field("JEV_AUTHORITY", "CLAUDE_PLUGIN_OPTION_AUTHORITY", (cfg, raw) => {
    const v = asEnum(raw, AUTHORITIES);
    if (v === undefined) return false;
    cfg.authority = v;
    return true;
  }),
  fail: field("JEV_FAIL", "CLAUDE_PLUGIN_OPTION_FAIL", (cfg, raw) => {
    const v = asEnum(raw, FAIL_MODES);
    if (v === undefined) return false;
    cfg.fail = v;
    return true;
  }),
  confAxis: field("JEV_CONF_AXIS", "CLAUDE_PLUGIN_OPTION_CONF_AXIS", (cfg, raw) => {
    const v = asEnum(raw, CONF_AXES);
    if (v === undefined) return false;
    cfg.confAxis = v;
    return true;
  }),
  router: field("JEV_ROUTER", "CLAUDE_PLUGIN_OPTION_ROUTER", (cfg, raw) => {
    const v = asEnum(raw, ROUTER_MODES);
    if (v === undefined) return false;
    cfg.router = v;
    return true;
  }),
  model: field("TYPESAFE_DEFAULT_MODEL", "CLAUDE_PLUGIN_OPTION_MODEL", (cfg, raw) => {
    const v = asString(raw);
    if (v === undefined) return false;
    cfg.model = v;
    return true;
  }),
  baseUrl: field("TYPESAFE_BASE_URL", "CLAUDE_PLUGIN_OPTION_BASE_URL", (cfg, raw) => {
    const v = asString(raw);
    if (v === undefined) return false;
    cfg.baseUrl = v;
    return true;
  }),
  stateDir: field("JEV_STATE_DIR", "CLAUDE_PLUGIN_OPTION_STATE_DIR", (cfg, raw) => {
    const v = usable(asString(raw));
    if (v === undefined) return false;
    cfg.stateDir = v;
    return true;
  }),
  retainDays: field("JEV_RETAIN_DAYS", "CLAUDE_PLUGIN_OPTION_RETAIN_DAYS", (cfg, raw) => {
    const v = asNumber(raw, 0);
    if (v === undefined) return false;
    cfg.retainDays = v;
    return true;
  }),
  debug: field("JEV_DEBUG", "CLAUDE_PLUGIN_OPTION_DEBUG", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.debug = v;
    return true;
  }),
  timeoutMs: field("JEV_TIMEOUT_MS", "CLAUDE_PLUGIN_OPTION_TIMEOUT_MS", (cfg, raw) => {
    const v = asNumber(raw, 1);
    if (v === undefined) return false;
    cfg.timeoutMs = v;
    return true;
  }),
  planReview: field("JEV_PLAN_REVIEW", "CLAUDE_PLUGIN_OPTION_PLAN_REVIEW", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.planReview = v;
    return true;
  }),
  planMaxDenies: field("JEV_PLAN_MAX_DENIES", "CLAUDE_PLUGIN_OPTION_PLAN_MAX_DENIES", (cfg, raw) => {
    const v = asNumber(raw, 0);
    if (v === undefined) return false;
    cfg.planMaxDenies = v;
    return true;
  }),
  routerMaxPerTurn: field(
    "JEV_ROUTER_MAX_PER_TURN",
    "CLAUDE_PLUGIN_OPTION_ROUTER_MAX_PER_TURN",
    (cfg, raw) => {
      const v = asNumber(raw, 0);
      if (v === undefined) return false;
      cfg.routerMaxPerTurn = v;
      return true;
    },
  ),
  mutationGate: field("JEV_MUTATION_GATE", "CLAUDE_PLUGIN_OPTION_MUTATION_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.mutationGate = v;
    return true;
  }),
  stopBackstop: field("JEV_STOP_BACKSTOP", "CLAUDE_PLUGIN_OPTION_STOP_BACKSTOP", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.stopBackstop = v;
    return true;
  }),
  bashGate: field("JEV_BASH_GATE", "CLAUDE_PLUGIN_OPTION_BASH_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.bashGate = v;
    return true;
  }),
  dependencyGate: field("JEV_DEPENDENCY_GATE", "CLAUDE_PLUGIN_OPTION_DEPENDENCY_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === undefined) return false;
    cfg.dependencyGate = v;
    return true;
  }),
  subagentSkip: field("JEV_SUBAGENT_SKIP", "CLAUDE_PLUGIN_OPTION_SUBAGENT_SKIP", (cfg, raw) => {
    const v = asList(raw);
    if (v === undefined) return false;
    cfg.subagentSkip = v;
    return true;
  }),
  thresholds: field("JEV_THRESHOLDS", "CLAUDE_PLUGIN_OPTION_THRESHOLDS", (cfg, raw) => {
    const patch = asJson(raw);
    if (!isRecord(patch)) return false;
    cfg.thresholds = mergeNumbers(
      cfg.thresholds as unknown as Record<string, unknown>,
      patch,
    ) as unknown as Thresholds;
    return true;
  }),
};

/* ---------------------------------------------------------------- layers */

function applyRecord(cfg: Config, source: Record<string, unknown>, explicit: Set<string>): void {
  for (const [key, raw] of Object.entries(source)) {
    const f = FIELDS[key];
    if (f === undefined || raw === undefined || raw === null) continue;
    if (f.apply(cfg, raw)) explicit.add(key);
  }
}

function applyEnv(
  cfg: Config,
  env: NodeJS.ProcessEnv,
  explicit: Set<string>,
  pick: (f: Field) => string,
): void {
  for (const [key, f] of Object.entries(FIELDS)) {
    const raw = env[pick(f)];
    if (raw === undefined) continue;
    if (f.apply(cfg, raw)) explicit.add(key);
  }
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Config {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();

  const cfg: Config = {
    ...DEFAULT_CONFIG,
    subagentSkip: [...DEFAULT_CONFIG.subagentSkip],
    thresholds: structuredClone(DEFAULT_CONFIG.thresholds),
  };
  const explicit = new Set<string>();

  // The user file has to be found before it can be read, so its directory comes
  // from the environment only; a config file cannot relocate itself.
  const userFile = readJsonFile(join(resolveStateDir(DEFAULT_CONFIG, env), "config.json"));
  if (userFile) applyRecord(cfg, userFile, explicit);

  const projectFile = readJsonFile(join(cwd, ".jev.json"));
  if (projectFile) applyRecord(cfg, projectFile, explicit);

  applyEnv(cfg, env, explicit, (f) => f.option);
  applyEnv(cfg, env, explicit, (f) => f.env);

  // Strict is the mode that owns these two gates; anywhere else they are inert
  // even when set, so switching to strict is what turns them on.
  if (cfg.enforcement === "strict") {
    if (!explicit.has("mutationGate")) cfg.mutationGate = true;
    if (!explicit.has("stopBackstop")) cfg.stopBackstop = true;
  }

  return cfg;
}

/* ------------------------------------------------------------- state dir */

/** An unexpanded `${user_config.x}` placeholder is not a value. */
function usable(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.length === 0 || /^\s*\$\{/.test(raw)) return undefined;
  return t;
}

/**
 * One fixed location, deliberately NOT `CLAUDE_PLUGIN_DATA`.
 *
 * That variable is set for hooks and the MCP server but not for `jev-doctor` run from a
 * shell, so the two halves of the plugin looked at different directories: the ledger went to
 * the plugin data dir while the CLI reported "0 sessions, hooks not running". Its value also
 * carries the plugin's install id, so moving from `--plugin-dir` to an installed copy
 * silently orphaned the history.
 *
 * `JEV_STATE_DIR` still overrides, which is what the tests use.
 *
 * There is no migration from the old location: `jev-doctor set-key` always ran from a shell,
 * so credentials never went there, and only unreleased development builds wrote ledgers there.
 */
export function resolveStateDir(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  return (
    usable(cfg.stateDir) ??
    usable(env.JEV_STATE_DIR) ??
    // Never os.tmpdir(): every surface must resolve the same path.
    join(homedir(), ".claude", "jev")
  );
}

/* ---------------------------------------------------------------- api key */

export type KeySource = "env" | "plugin_option" | "credentials" | "none";

export interface KeyResolution {
  key?: string;
  source: KeySource;
}

function readCredentialsKey(stateDir: string): string | undefined {
  const parsed = readJsonFile(join(stateDir, "credentials.json"));
  const key = parsed?.["apiKey"];
  return typeof key === "string" ? key : undefined;
}

export function resolveApiKey(
  cfg: Config = DEFAULT_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): KeyResolution {
  const candidates: [string | undefined, KeySource][] = [
    [env["TYPESAFE_API_KEY"], "env"],
    [env["CLAUDE_PLUGIN_OPTION_API_KEY"], "plugin_option"],
    [env["JEV_USERCONFIG_API_KEY"], "plugin_option"],
  ];
  for (const [raw, source] of candidates) {
    const key = usable(raw);
    if (key !== undefined) return { key, source };
  }
  // A single location, which `resolveStateDir` guarantees is the same one for a hook, the
  // server and the CLI. Reading a second, hard-coded path as a fallback would also mean tests
  // could pick up the developer's own key and pass when they should not.
  const fromFile = usable(readCredentialsKey(resolveStateDir(cfg, env)));
  if (fromFile !== undefined) return { key: fromFile, source: "credentials" };
  return { source: "none" };
}

/* ------------------------------------------------------------ interactive */

const NON_INTERACTIVE = /sdk|print|headless|cron/i;

/** stdin is always piped into a hook, so only the entrypoint can tell us this. */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  return !NON_INTERACTIVE.test(env["CLAUDE_CODE_ENTRYPOINT"] ?? "");
}
