#!/usr/bin/env node
import { createRequire as __jevCreateRequire } from 'node:module';
import { fileURLToPath as __jevFileURLToPath } from 'node:url';
import { dirname as __jevDirname } from 'node:path';
const require = __jevCreateRequire(import.meta.url);
const __filename = __jevFileURLToPath(import.meta.url);
const __dirname = __jevDirname(__filename);

// src/cli/main.ts
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/shared/config.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/shared/policy.ts
var EPS = 5e-3;
var RESERVED = {
  decision: "decision",
  needsUserPreference: "needs_user_preference",
  optionsAreNeutral: "options_are_neutral",
  injection: "contains_injected_instruction",
  reversibleLocally: "reversible_locally",
  changesPublicInterface: "changes_public_interface",
  changesStoredData: "changes_stored_data",
  affectsProduction: "affects_production",
  spendsMoney: "spends_money",
  sendsOutside: "sends_outside_this_machine"
};
var RESERVED_IDS = Object.values(RESERVED);
var DEFAULT_THRESHOLDS = {
  choice: {
    // Below `proceed` but at or above `confirm` asks; below `confirm` escalates.
    low: { proceed: 0.5, confirm: 0 },
    medium: { proceed: 0.7, confirm: 0.45 },
    high: { proceed: 0.9, confirm: 0.65 }
  },
  // What the ANSWER is, not how sure we must be to act on it — that is the stakes table's
  // job. Demanding 0.90 before calling a DROP TABLE destructive left almost every real answer
  // "uncertain", which is noise rather than caution.
  noul: { yes: 0.65, no: 0.35 },
  nearTieMass: 0.7,
  nearTieMargin: 0.15,
  revisionsBeforeEscalate: 1,
  needsUserPreference: 0.85,
  decisiveOverride: 0.97,
  scopeCreep: 0.8,
  injection: 0.7,
  optionNeutrality: 0.5,
  stakes: {
    highAffects: 0.6,
    highPublic: 0.6,
    highIrreversible: 0.25,
    mediumAffects: 0.35,
    mediumPublic: 0.35,
    mediumIrreversible: 0.6
  },
  score: { passSlack: 0.05, failGap: 0.5 },
  router: { stated: 0.8, answer: 0.85 },
  plan: {
    deferredFork: 0.75,
    contradiction: 0.75,
    irreversible: 0.7,
    missingVerification: 0.25,
    // Coverage is an expected level, so a confident "does everything" still lands a little
    // under 2. Measured on jev-1.13 (test/calibration): complete plans 1.85-1.99, a plan
    // doing half the request 1.01. The old bar of 1.95 refused complete plans at 1.85 and
    // 1.91, and cleared a real 13 KB plan by 0.01.
    coverageFull: 1.5,
    coverageMain: 0.75
  },
  triage: { mutation: 0.6, stop: 0.75 }
};
function atLeast(x, t) {
  return x + EPS >= t;
}
function judgePlanReview(review, coverage, t) {
  const problems = [];
  if (coverage !== void 0 && coverage < t.plan.coverageFull) {
    problems.push(
      coverage < t.plan.coverageMain ? "the plan does not do the main thing the request asks for" : "the plan leaves out something the request asks for"
    );
  }
  const defers = review["defers_a_choice"];
  if (defers !== void 0 && atLeast(defers, t.plan.deferredFork)) {
    problems.push(
      "the plan leaves a choice between alternatives open; decide it with decide and write the chosen option into the plan"
    );
  }
  for (const [id, p] of Object.entries(review)) {
    if (!id.startsWith("follows_decision_")) continue;
    if (p <= 1 - t.plan.contradiction + EPS) {
      problems.push(`the plan contradicts a recorded decision (${id.replace("follows_decision_", "#")})`);
    }
  }
  const blocking = problems.length > 0;
  const injected = review[RESERVED.injection];
  if (injected !== void 0 && atLeast(injected, t.injection)) {
    problems.push(
      `the plan contains text aimed at whoever reviews it (${injected.toFixed(2)}) - read that part yourself before approving`
    );
  }
  const scope = review["adds_unrequested_work"];
  if (scope !== void 0 && atLeast(scope, t.scopeCreep)) {
    problems.push("the plan includes work the request did not ask for");
  }
  const verification = review["has_verification"];
  if (!blocking && verification !== void 0 && verification <= t.plan.missingVerification + EPS) {
    problems.push("the plan does not say how the result will be verified");
  }
  return { problems, blocking };
}
function planRisks(review, t) {
  const kinds = [
    ["deletes_data", "deletes data"],
    ["rewrites_history", "rewrites git history"],
    ["changes_public_interface", "changes a public interface"],
    ["deploys_or_spends", "deploys or spends money"]
  ];
  return kinds.filter(([id]) => {
    const p = review[id];
    return p !== void 0 && atLeast(p, t.plan.irreversible);
  }).map(([, label]) => label);
}

// src/shared/config.ts
var DEFAULT_CONFIG = {
  enforcement: "standard",
  authority: "autonomous",
  fail: "open",
  confAxis: "confidence",
  model: void 0,
  baseUrl: void 0,
  stateDir: void 0,
  retainDays: 7,
  debug: false,
  timeoutMs: 6e3,
  planReview: true,
  planMaxDenies: 2,
  router: "stated",
  routerMaxPerTurn: 1,
  mutationGate: false,
  stopBackstop: false,
  bashGate: true,
  dependencyGate: true,
  subagentSkip: ["statusline-setup", "output-style-setup", "claude-code-guide"],
  thresholds: DEFAULT_THRESHOLDS
};
var BUDGETS = {
  server: 6e3,
  planGate: 8e3,
  router: 6e3,
  mutationGate: 5e3,
  stopBackstop: 6e3,
  bashGate: 6e3
};
var ENFORCEMENTS = ["off", "soft", "standard", "strict"];
var AUTHORITIES = ["autonomous", "advisory"];
var FAIL_MODES = ["open", "closed"];
var CONF_AXES = ["confidence", "top_probability", "min"];
var ROUTER_MODES = ["stated", "ledger", "off"];
var TRUE_WORDS = /* @__PURE__ */ new Set(["1", "true", "yes"]);
var FALSE_WORDS = /* @__PURE__ */ new Set(["0", "false", "no"]);
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v) {
  if (typeof v !== "string") return void 0;
  const t = v.trim();
  return t.length > 0 ? t : void 0;
}
function asBool(v) {
  if (typeof v === "boolean") return v;
  const s = asString(v)?.toLowerCase();
  if (s === void 0) return void 0;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return void 0;
}
function asNumber(v, min) {
  const n = typeof v === "number" ? v : Number(asString(v) ?? Number.NaN);
  return Number.isFinite(n) && n >= min ? n : void 0;
}
function asEnum(v, allowed) {
  const s = asString(v)?.toLowerCase();
  return allowed.find((a) => a === s);
}
function asList(v) {
  if (Array.isArray(v)) {
    const items2 = v.map(asString).filter((s2) => s2 !== void 0);
    return items2.length > 0 ? items2 : void 0;
  }
  const s = asString(v);
  if (s === void 0) return void 0;
  const items = s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  return items.length > 0 ? items : void 0;
}
function asJson(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return void 0;
  }
}
function mergeNumbers(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const current = out[k];
    if (isRecord(v) && isRecord(current)) out[k] = mergeNumbers(current, v);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}
function field(env, option, apply) {
  return { env, option, apply };
}
var FIELDS = {
  enforcement: field("JEV_ENFORCEMENT", "CLAUDE_PLUGIN_OPTION_ENFORCEMENT", (cfg, raw) => {
    const v = asEnum(raw, ENFORCEMENTS);
    if (v === void 0) return false;
    cfg.enforcement = v;
    return true;
  }),
  authority: field("JEV_AUTHORITY", "CLAUDE_PLUGIN_OPTION_AUTHORITY", (cfg, raw) => {
    const v = asEnum(raw, AUTHORITIES);
    if (v === void 0) return false;
    cfg.authority = v;
    return true;
  }),
  fail: field("JEV_FAIL", "CLAUDE_PLUGIN_OPTION_FAIL", (cfg, raw) => {
    const v = asEnum(raw, FAIL_MODES);
    if (v === void 0) return false;
    cfg.fail = v;
    return true;
  }),
  confAxis: field("JEV_CONF_AXIS", "CLAUDE_PLUGIN_OPTION_CONF_AXIS", (cfg, raw) => {
    const v = asEnum(raw, CONF_AXES);
    if (v === void 0) return false;
    cfg.confAxis = v;
    return true;
  }),
  router: field("JEV_ROUTER", "CLAUDE_PLUGIN_OPTION_ROUTER", (cfg, raw) => {
    const v = asEnum(raw, ROUTER_MODES);
    if (v === void 0) return false;
    cfg.router = v;
    return true;
  }),
  model: field("TYPESAFE_DEFAULT_MODEL", "CLAUDE_PLUGIN_OPTION_MODEL", (cfg, raw) => {
    const v = asString(raw);
    if (v === void 0) return false;
    cfg.model = v;
    return true;
  }),
  baseUrl: field("TYPESAFE_BASE_URL", "CLAUDE_PLUGIN_OPTION_BASE_URL", (cfg, raw) => {
    const v = asString(raw);
    if (v === void 0) return false;
    cfg.baseUrl = v;
    return true;
  }),
  stateDir: field("JEV_STATE_DIR", "CLAUDE_PLUGIN_OPTION_STATE_DIR", (cfg, raw) => {
    const v = usable(asString(raw));
    if (v === void 0) return false;
    cfg.stateDir = v;
    return true;
  }),
  retainDays: field("JEV_RETAIN_DAYS", "CLAUDE_PLUGIN_OPTION_RETAIN_DAYS", (cfg, raw) => {
    const v = asNumber(raw, 0);
    if (v === void 0) return false;
    cfg.retainDays = v;
    return true;
  }),
  debug: field("JEV_DEBUG", "CLAUDE_PLUGIN_OPTION_DEBUG", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.debug = v;
    return true;
  }),
  timeoutMs: field("JEV_TIMEOUT_MS", "CLAUDE_PLUGIN_OPTION_TIMEOUT_MS", (cfg, raw) => {
    const v = asNumber(raw, 1);
    if (v === void 0) return false;
    cfg.timeoutMs = v;
    return true;
  }),
  planReview: field("JEV_PLAN_REVIEW", "CLAUDE_PLUGIN_OPTION_PLAN_REVIEW", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.planReview = v;
    return true;
  }),
  planMaxDenies: field("JEV_PLAN_MAX_DENIES", "CLAUDE_PLUGIN_OPTION_PLAN_MAX_DENIES", (cfg, raw) => {
    const v = asNumber(raw, 0);
    if (v === void 0) return false;
    cfg.planMaxDenies = v;
    return true;
  }),
  routerMaxPerTurn: field(
    "JEV_ROUTER_MAX_PER_TURN",
    "CLAUDE_PLUGIN_OPTION_ROUTER_MAX_PER_TURN",
    (cfg, raw) => {
      const v = asNumber(raw, 0);
      if (v === void 0) return false;
      cfg.routerMaxPerTurn = v;
      return true;
    }
  ),
  mutationGate: field("JEV_MUTATION_GATE", "CLAUDE_PLUGIN_OPTION_MUTATION_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.mutationGate = v;
    return true;
  }),
  stopBackstop: field("JEV_STOP_BACKSTOP", "CLAUDE_PLUGIN_OPTION_STOP_BACKSTOP", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.stopBackstop = v;
    return true;
  }),
  bashGate: field("JEV_BASH_GATE", "CLAUDE_PLUGIN_OPTION_BASH_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.bashGate = v;
    return true;
  }),
  dependencyGate: field("JEV_DEPENDENCY_GATE", "CLAUDE_PLUGIN_OPTION_DEPENDENCY_GATE", (cfg, raw) => {
    const v = asBool(raw);
    if (v === void 0) return false;
    cfg.dependencyGate = v;
    return true;
  }),
  subagentSkip: field("JEV_SUBAGENT_SKIP", "CLAUDE_PLUGIN_OPTION_SUBAGENT_SKIP", (cfg, raw) => {
    const v = asList(raw);
    if (v === void 0) return false;
    cfg.subagentSkip = v;
    return true;
  }),
  thresholds: field("JEV_THRESHOLDS", "CLAUDE_PLUGIN_OPTION_THRESHOLDS", (cfg, raw) => {
    const patch = asJson(raw);
    if (!isRecord(patch)) return false;
    cfg.thresholds = mergeNumbers(
      cfg.thresholds,
      patch
    );
    return true;
  })
};
function applyRecord(cfg, source, explicit) {
  for (const [key, raw] of Object.entries(source)) {
    const f = FIELDS[key];
    if (f === void 0 || raw === void 0 || raw === null) continue;
    if (f.apply(cfg, raw)) explicit.add(key);
  }
}
function applyEnv(cfg, env, explicit, pick) {
  for (const [key, f] of Object.entries(FIELDS)) {
    const raw = env[pick(f)];
    if (raw === void 0) continue;
    if (f.apply(cfg, raw)) explicit.add(key);
  }
}
function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function loadConfig(opts) {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const cfg = {
    ...DEFAULT_CONFIG,
    subagentSkip: [...DEFAULT_CONFIG.subagentSkip],
    thresholds: structuredClone(DEFAULT_CONFIG.thresholds)
  };
  const explicit = /* @__PURE__ */ new Set();
  const userFile = readJsonFile(join(resolveStateDir(DEFAULT_CONFIG, env), "config.json"));
  if (userFile) applyRecord(cfg, userFile, explicit);
  const projectFile = readJsonFile(join(cwd, ".jev.json"));
  if (projectFile) applyRecord(cfg, projectFile, explicit);
  applyEnv(cfg, env, explicit, (f) => f.option);
  applyEnv(cfg, env, explicit, (f) => f.env);
  if (cfg.enforcement === "strict") {
    if (!explicit.has("mutationGate")) cfg.mutationGate = true;
    if (!explicit.has("stopBackstop")) cfg.stopBackstop = true;
  }
  return cfg;
}
function usable(raw) {
  if (raw === void 0) return void 0;
  const t = raw.trim();
  if (t.length === 0 || /^\s*\$\{/.test(raw)) return void 0;
  return t;
}
function resolveStateDir(cfg, env = process.env) {
  return usable(cfg.stateDir) ?? usable(env.JEV_STATE_DIR) ?? // Never os.tmpdir(): every surface must resolve the same path.
  join(homedir(), ".claude", "jev");
}
function readCredentialsKey(stateDir) {
  const parsed = readJsonFile(join(stateDir, "credentials.json"));
  const key = parsed?.["apiKey"];
  return typeof key === "string" ? key : void 0;
}
function resolveApiKey(cfg = DEFAULT_CONFIG, env = process.env) {
  const candidates = [
    [env["TYPESAFE_API_KEY"], "env"],
    [env["CLAUDE_PLUGIN_OPTION_API_KEY"], "plugin_option"],
    [env["JEV_USERCONFIG_API_KEY"], "plugin_option"]
  ];
  for (const [raw, source] of candidates) {
    const key = usable(raw);
    if (key !== void 0) return { key, source };
  }
  const fromFile = usable(readCredentialsKey(resolveStateDir(cfg, env)));
  if (fromFile !== void 0) return { key: fromFile, source: "credentials" };
  return { source: "none" };
}

// src/cli/secret.ts
function secretKeys(state, chunk) {
  for (const ch of chunk) {
    if (state.esc) {
      state.esc += ch;
      const csi = state.esc.startsWith("\x1B[");
      const ss3 = state.esc.startsWith("\x1BO");
      const ended = csi ? state.esc.length > 2 && ch >= "@" && ch <= "~" : state.esc.length >= (ss3 ? 3 : 2);
      if (ended) state.esc = "";
      continue;
    }
    if (ch === "\x1B") {
      state.esc = ch;
      continue;
    }
    if (ch === "\r" || ch === "\n") return "done";
    if (ch === "") return "interrupt";
    if (ch === "") return state.buf ? "done" : "interrupt";
    if (ch === "\x7F" || ch === "\b") {
      state.buf = state.buf.slice(0, -1);
      continue;
    }
    if (ch >= " ") state.buf += ch;
  }
  return "more";
}

// src/shared/state-store.ts
import { Buffer as Buffer2 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { dirname, join as join2, resolve, sep } from "node:path";

// src/shared/ledger.ts
import { Buffer } from "node:buffer";
var MAX_LINE_BYTES = 4e3;
function byteLength(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
function clip(s, maxChars) {
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}
function shrinkLedgerEntry(entry, maxBytes = MAX_LINE_BYTES) {
  if (byteLength(entry) <= maxBytes) return entry;
  const e = { ...entry, truncated: true };
  const stages = [
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
    }
  ];
  for (const stage of stages) {
    stage(e);
    if (byteLength(e) <= maxBytes) return e;
  }
  const skeleton = {
    v: 1,
    ts: e.ts,
    kind: e.kind,
    session_id: clip(e.session_id, 64),
    label: e.label,
    action: e.action,
    truncated: true
  };
  for (let n = 200; n >= 0 && byteLength(skeleton) > maxBytes; n = Math.floor(n / 2) - 1) {
    skeleton.label = clip(skeleton.label, Math.max(0, n));
  }
  return skeleton;
}

// src/shared/state-store.ts
var DIR_MODE = 448;
var FILE_MODE = 384;
var MAX_LINE_BYTES2 = 4e3;
var HOUR_MS = 60 * 60 * 1e3;
var DAY_MS = 24 * HOUR_MS;
var ALIVE_MAX_AGE_MS = 12 * HOUR_MS;
var LIVE_GRACE_MS = HOUR_MS;
var SEGMENT_MAX = 120;
function sanitizeSegment(s) {
  const src = typeof s === "string" ? s : "";
  const cleaned = src.replace(/[^A-Za-z0-9_-]/g, "-");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return createHash("sha256").update(src).digest("hex").slice(0, 32);
  }
  if (cleaned.length > SEGMENT_MAX) {
    const digest = createHash("sha256").update(src).digest("hex").slice(0, 16);
    return `${cleaned.slice(0, SEGMENT_MAX - digest.length - 1)}-${digest}`;
  }
  return cleaned;
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
var IDENTITY_FIELDS = /* @__PURE__ */ new Set([
  "v",
  "ts",
  "kind",
  "gate",
  "outcome",
  "action",
  "session_id",
  "prompt_id",
  "agent_id",
  "truncated"
]);
function fitLine(entry) {
  let line = JSON.stringify(entry) ?? "null";
  if (Buffer2.byteLength(line, "utf8") <= MAX_LINE_BYTES2 || !isPlainObject(entry)) return line;
  const copy = { ...entry, truncated: true };
  for (let i = 0; i < 64; i++) {
    line = JSON.stringify(copy) ?? "null";
    if (Buffer2.byteLength(line, "utf8") <= MAX_LINE_BYTES2) return line;
    let widest;
    let width = 0;
    for (const [k, v] of Object.entries(copy)) {
      if (IDENTITY_FIELDS.has(k)) continue;
      const n = typeof v === "string" ? v.length : (JSON.stringify(v) ?? "").length;
      if (n > width) {
        width = n;
        widest = k;
      }
    }
    if (widest === void 0) return line;
    const value = copy[widest];
    if (typeof value === "string" && value.length > 1) copy[widest] = value.slice(0, value.length >> 1);
    else delete copy[widest];
  }
  return line;
}
function sessionActivity(dir) {
  let newest = statSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try {
      const m = statSync(join2(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
    }
  }
  return newest;
}
var SessionStore = class _SessionStore {
  root;
  sessionId;
  dir;
  constructor(root, sessionId) {
    this.root = resolve(root);
    this.sessionId = sanitizeSegment(sessionId);
    this.dir = join2(this.root, "sessions", this.sessionId);
  }
  static from(cfg, sessionId, env) {
    return new _SessionStore(resolveStateDir(cfg, env), sessionId);
  }
  /* --------------------------------------------------------------- paths */
  /** Defence in depth behind sanitizeSegment: a path that escapes the root is never used. */
  inside(p) {
    const abs = resolve(p);
    return abs === this.root || abs.startsWith(this.root + sep);
  }
  mkdir(dir) {
    if (!this.inside(dir)) return false;
    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      return true;
    } catch {
      return false;
    }
  }
  ensureDirs() {
    this.mkdir(this.dir);
    this.mkdir(join2(this.root, "ctx"));
    this.mkdir(join2(this.root, "calls"));
  }
  /* --------------------------------------------------------------- jsonl */
  appendJsonl(name, entry) {
    if (!this.mkdir(this.dir)) return;
    try {
      appendFileSync(join2(this.dir, name), `${fitLine(entry)}
`, { encoding: "utf8", mode: FILE_MODE });
    } catch {
    }
  }
  readJsonl(name) {
    const file = join2(this.dir, name);
    if (!this.inside(file)) return [];
    let raw;
    try {
      raw = readFileSync2(file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed)) out.push(parsed);
      } catch {
      }
    }
    return out;
  }
  appendLedger(entry) {
    this.appendJsonl("ledger.jsonl", shrinkLedgerEntry(entry));
  }
  ledger() {
    return this.readJsonl("ledger.jsonl");
  }
  appendGate(entry) {
    this.appendJsonl("gates.jsonl", entry);
  }
  gates() {
    return this.readJsonl("gates.jsonl");
  }
  appendPrompt(entry) {
    this.appendJsonl("prompts.jsonl", entry);
  }
  prompts(sinceTs) {
    const all = this.readJsonl("prompts.jsonl");
    if (sinceTs === void 0) return all;
    return all.filter((p) => typeof p.ts === "number" && p.ts >= sinceTs);
  }
  /* --------------------------------------------------------------- claims */
  claimPath(kind, key) {
    return join2(this.dir, "claims", sanitizeSegment(kind), sanitizeSegment(key));
  }
  /**
   * Take a one-shot decision. True only for the winner, including across processes:
   * O_CREAT|O_EXCL is the arbiter, so two hooks racing on the same gate cannot both act.
   */
  claim(kind, key) {
    const file = this.claimPath(kind, key);
    if (!this.mkdir(dirname(file))) return false;
    try {
      closeSync(openSync(file, "wx", FILE_MODE));
      return true;
    } catch {
      return false;
    }
  }
  hasClaim(kind, key) {
    const file = this.claimPath(kind, key);
    if (!this.inside(file)) return false;
    try {
      return existsSync(file);
    } catch {
      return false;
    }
  }
  /* -------------------------------------------------------------- liveness */
  markAlive() {
    const file = join2(this.dir, "alive");
    if (!this.mkdir(this.dir)) return;
    try {
      writeFileSync(file, String(Date.now()), { encoding: "utf8", mode: FILE_MODE });
    } catch {
    }
  }
  /**
   * Whether a hook has run in this session recently. The server uses it to tell the
   * difference between "enforced" and safe/bare mode, where hooks never run at all.
   */
  isAlive(maxAgeMs = ALIVE_MAX_AGE_MS) {
    const file = join2(this.dir, "alive");
    if (!this.inside(file)) return false;
    try {
      const ts = Number.parseInt(readFileSync2(file, "utf8").trim(), 10);
      const stamp = Number.isFinite(ts) ? ts : statSync(file).mtimeMs;
      return Date.now() - stamp <= maxAgeMs;
    } catch {
      return false;
    }
  }
  /* ----------------------------------------------------- hook/server files */
  handoffPath(bucket, toolUseId) {
    return join2(this.root, bucket, `${sanitizeSegment(toolUseId)}.json`);
  }
  writeJsonAtomic(file, value) {
    if (!this.mkdir(dirname(file))) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: FILE_MODE });
      renameSync(tmp, file);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
      }
    }
  }
  readJson(file) {
    if (!this.inside(file)) return void 0;
    try {
      const parsed = JSON.parse(readFileSync2(file, "utf8"));
      return parsed;
    } catch {
      return void 0;
    }
  }
  writeCtx(toolUseId, ctx) {
    this.writeJsonAtomic(this.handoffPath("ctx", toolUseId), ctx);
  }
  readCtx(toolUseId) {
    const parsed = this.readJson(this.handoffPath("ctx", toolUseId));
    return isPlainObject(parsed) ? parsed : void 0;
  }
  writeCall(toolUseId, record) {
    this.writeJsonAtomic(this.handoffPath("calls", toolUseId), record);
  }
  readCall(toolUseId) {
    return this.readJson(this.handoffPath("calls", toolUseId));
  }
  /** Both halves of the handoff are done with once the ledger line is written. */
  dropCall(toolUseId) {
    for (const bucket of ["ctx", "calls"]) {
      const file = this.handoffPath(bucket, toolUseId);
      if (!this.inside(file)) continue;
      try {
        unlinkSync(file);
      } catch {
      }
    }
  }
  /* --------------------------------------------------------------- pruning */
  sweepHandoff(bucket, cutoff) {
    const dir = join2(this.root, bucket);
    if (!this.inside(dir)) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join2(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
      }
    }
  }
  /**
   * Age out old state. Called from SessionStart, where the one thing that must survive
   * is the session being resumed: pruning it would silently drop the ledger a long
   * session is still appending to.
   */
  prune(opts) {
    const now = opts.now ?? Date.now();
    this.sweepHandoff("ctx", now - HOUR_MS);
    this.sweepHandoff("calls", now - HOUR_MS);
    const sessions = join2(this.root, "sessions");
    if (!this.inside(sessions)) return;
    let names;
    try {
      names = readdirSync(sessions);
    } catch {
      return;
    }
    const keep = opts.keepSessionId === void 0 ? void 0 : sanitizeSegment(opts.keepSessionId);
    const cutoff = now - Math.max(0, opts.retainDays) * DAY_MS;
    for (const name of names) {
      const dir = join2(sessions, name);
      if (!this.inside(dir)) continue;
      try {
        if (name.startsWith("_")) continue;
        if (name === keep) {
          const stamp = new Date(now);
          utimesSync(dir, stamp, stamp);
          continue;
        }
        const active = sessionActivity(dir);
        if (active >= now - LIVE_GRACE_MS) continue;
        if (opts.retainDays > 0 && active >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
  /* ----------------------------------------------------------------- debug */
  debugLog(line) {
    const dir = join2(this.root, "log");
    if (!this.mkdir(dir)) return;
    try {
      const flat = line.replace(/[\r\n]+/g, " ");
      const capped = Buffer2.byteLength(flat, "utf8") > 4e3 ? `${flat.slice(0, 2e3)}\u2026` : flat;
      appendFileSync(join2(dir, "hooks.log"), `${(/* @__PURE__ */ new Date()).toISOString()} [${process.pid}] ${capped}
`, {
        encoding: "utf8",
        mode: FILE_MODE
      });
    } catch {
    }
  }
};

// src/cli/main.ts
var ACTION_MARK = {
  proceed: "ok",
  proceed_and_flag: "ok*",
  proceed_unverified: "--",
  revise: "revise",
  confirm: "confirm",
  escalate_to_user: "asked you"
};
function sessionsDir(root) {
  return join3(root, "sessions");
}
function listSessions(root) {
  const dir = sessionsDir(root);
  if (!existsSync2(dir)) return [];
  const out = [];
  for (const id of readdirSync2(dir)) {
    if (id.startsWith("_")) continue;
    const path = join3(dir, id);
    try {
      const empty = !existsSync2(join3(path, "ledger.jsonl")) && !existsSync2(join3(path, "gates.jsonl"));
      out.push({ id, mtime: sessionActivity(path), empty });
    } catch {
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function reviewDetail(g, thresholds) {
  if (!g.review) return "";
  const review = { ...g.review };
  let coverage = g.coverage;
  if (coverage === void 0 && review["coverage"] !== void 0) {
    coverage = review["coverage"];
    delete review["coverage"];
  }
  const problems = g.problems ?? judgePlanReview(review, coverage, thresholds).problems;
  const risks = planRisks(review, thresholds);
  const parts = [problems.length ? problems.join("; ") : "cleared"];
  if (risks.length) parts.push(`irreversible: ${risks.join(", ")}`);
  if (coverage !== void 0) parts.push(`coverage ${coverage.toFixed(2)}/2`);
  return `: ${parts.join(" | ")}`;
}
function printSession(root, id, json, thresholds) {
  const store = new SessionStore(root, id);
  const ledger = store.ledger();
  const gates = store.gates();
  if (json) {
    process.stdout.write(JSON.stringify({ session: id, ledger, gates }) + "\n");
    return;
  }
  process.stdout.write(`
session ${id}  (${ledger.length} decisions, ${gates.length} gate events)
`);
  for (const e of ledger) {
    const conf = e.confidence !== void 0 ? ` conf ${e.confidence.toFixed(2)}` : "";
    const stakes = e.effective_stakes ? ` [${e.effective_stakes}]` : "";
    const choice = e.choice ? ` -> ${e.choice}` : "";
    const mark = ACTION_MARK[e.action] ?? e.action;
    const plan = e.permission_mode === "plan" ? " (plan)" : "";
    const agent = e.agent_id ? ` (${e.agent_type ?? "subagent"})` : "";
    const error = e.error ? ` (${e.error})` : "";
    process.stdout.write(
      `  ${fmtTime(e.ts)} ${e.kind} ${e.label}${choice}${conf}${stakes} ${mark}${error}${plan}${agent}
`
    );
    if (e.why) process.stdout.write(`           why: ${e.why}
`);
    for (const c of e.checks ?? []) {
      process.stdout.write(`           check ${c.id} -> ${c.verdict} (${c.p.toFixed(2)})
`);
    }
  }
  for (const g of gates) {
    const detail = g.outcome === "reviewed" ? reviewDetail(g, thresholds) : g.why ? ` (${g.why})` : "";
    process.stdout.write(`  ${fmtTime(g.ts)} gate:${g.gate} ${g.outcome}${detail}
`);
  }
}
function calibration(root) {
  const buckets = /* @__PURE__ */ new Map();
  let total = 0;
  for (const { id } of listSessions(root)) {
    for (const e of new SessionStore(root, id).ledger()) {
      if (e.confidence === void 0) continue;
      total++;
      const key = (Math.floor(e.confidence * 10) / 10).toFixed(1);
      const b = buckets.get(key) ?? { n: 0, actions: /* @__PURE__ */ new Map() };
      b.n++;
      b.actions.set(e.action, (b.actions.get(e.action) ?? 0) + 1);
      buckets.set(key, b);
    }
  }
  if (total === 0) {
    process.stdout.write("no decisions with a confidence recorded yet\n");
    return;
  }
  process.stdout.write(`confidence distribution over ${total} decisions
`);
  for (const key of [...buckets.keys()].sort()) {
    const b = buckets.get(key);
    const actions = [...b.actions.entries()].map(([a, n]) => `${a} ${n}`).join(", ");
    process.stdout.write(`  ${key}-${(Number(key) + 0.1).toFixed(1)}  n=${String(b.n).padStart(4)}  ${actions}
`);
  }
}
function doctor(root) {
  const cfg = loadConfig();
  const { key, source } = resolveApiKey(cfg);
  const sessions = listSessions(root);
  const latest = sessions[0];
  const alive = latest ? new SessionStore(root, latest.id).isAlive() : false;
  process.stdout.write("jev plugin status\n");
  process.stdout.write(`  api key         ${key ? `set (\u2026${key.slice(-4)}) from ${source}` : "MISSING"}
`);
  process.stdout.write(`  enforcement     ${cfg.enforcement}
`);
  process.stdout.write(`  authority       ${cfg.authority}
`);
  process.stdout.write(`  question gate   ${cfg.router}
`);
  process.stdout.write(`  on failure      fail ${cfg.fail}
`);
  process.stdout.write(`  confidence axis ${cfg.confAxis}
`);
  process.stdout.write(`  model           ${cfg.model ?? "jev-latest"}
`);
  process.stdout.write(`  state dir       ${root}
`);
  const withActivity = sessions.filter((s) => !s.empty).length;
  process.stdout.write(
    `  sessions        ${withActivity} with decisions (${sessions.length} total)${latest ? `, latest ${latest.id}` : ""}
`
  );
  process.stdout.write(`  hooks running   ${alive ? "yes" : "no (safe/bare mode, or hooks disabled)"}
`);
  process.stdout.write(`  budgets ms      ${Object.entries(BUDGETS).map(([k, v]) => `${k} ${v}`).join(", ")}
`);
  if (!key) {
    process.stdout.write(
      "\nNo API key. Either export TYPESAFE_API_KEY (get one at https://console.typesafe.ai/keys)\nor run: jev-doctor set-key\n"
    );
  }
}
var Interrupted = class extends Error {
};
async function promptSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    return await new Promise((resolve2) => {
      let buf = "";
      const done = () => {
        input.off("data", onData);
        input.off("end", done);
        input.pause();
        resolve2(buf.split(/\r?\n/)[0] ?? "");
      };
      const onData = (chunk) => {
        buf += chunk.toString();
        if (buf.includes("\n")) done();
      };
      input.on("data", onData);
      input.once("end", done);
    });
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  const state = { buf: "", esc: "" };
  try {
    return await new Promise((resolve2, reject) => {
      const finish = (outcome) => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        if (outcome === "interrupt") reject(new Interrupted());
        else resolve2(state.buf);
      };
      const onData = (chunk) => {
        const r = secretKeys(state, chunk);
        if (r !== "more") finish(r);
      };
      const onEnd = () => finish("done");
      const onError = (err) => {
        input.off("data", onData);
        reject(err);
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
}
async function setKey(root) {
  let answer;
  try {
    answer = await promptSecret("TypeSafe API key (input hidden): ");
  } catch (err) {
    if (!(err instanceof Interrupted)) throw err;
    process.stderr.write("interrupted; no change\n");
    process.exitCode = 130;
    return;
  }
  const value = answer.trim();
  if (!value) {
    process.stdout.write("nothing entered; no change\n");
    return;
  }
  mkdirSync2(root, { recursive: true, mode: 448 });
  const path = join3(root, "credentials.json");
  writeFileSync2(path, JSON.stringify({ apiKey: value }) + "\n", { mode: 384 });
  chmodSync(path, 384);
  process.stdout.write(`saved to ${path} (mode 600)
`);
}
var USAGE = `usage:
  jev-log [--session <id> | --all] [--json]   the decision ledger (default: latest session)
  jev-log --calibration                       confidence against action, over every session
  jev-doctor                                  configuration and health
  jev-doctor set-key                          store a TypeSafe API key (input hidden)
`;
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "log";
  if (cmd !== "log" && cmd !== "doctor") {
    process.stderr.write(`jev: unknown command "${cmd}"
${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const cfg = loadConfig();
  const root = resolveStateDir(cfg);
  const json = args.includes("--json");
  if (cmd === "doctor") {
    if (args[1] === "set-key") await setKey(root);
    else doctor(root);
    return;
  }
  if (args.includes("--calibration")) {
    calibration(root);
    return;
  }
  const sessions = listSessions(root);
  const sessionArg = args.indexOf("--session");
  if (sessionArg !== -1) {
    const id = args[sessionArg + 1];
    if (!id || id.startsWith("-")) {
      process.stderr.write("jev-log: --session needs a session id\n");
      process.exitCode = 2;
      return;
    }
    if (!sessions.some((s) => s.id === id)) {
      process.stderr.write(`jev-log: no session ${id} under ${root}
`);
      process.exitCode = 1;
      return;
    }
    printSession(root, id, json, cfg.thresholds);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write(`no jev sessions recorded under ${root}
`);
    return;
  }
  if (args.includes("--all")) {
    const shown = sessions.filter((s) => !s.empty);
    for (const s of shown) printSession(root, s.id, json, cfg.thresholds);
    const hidden = sessions.length - shown.length;
    if (hidden > 0 && !json) {
      process.stdout.write(`
(${hidden} session(s) with no decisions and no gate events not shown)
`);
    }
    return;
  }
  printSession(root, sessions[0].id, json, cfg.thresholds);
}
async function flushStdout() {
  if (process.stdout.writableLength === 0) return;
  await new Promise((resolve2) => process.stdout.write("", () => resolve2()));
}
void main().then(
  async () => {
    await flushStdout();
    process.exit(process.exitCode ?? 0);
  },
  async (err) => {
    process.stderr.write(`jev: ${err instanceof Error ? err.message : String(err)}
`);
    await flushStdout();
    process.exit(1);
  }
);
