#!/usr/bin/env node
/**
 * jev-log and jev-doctor: the transparency surface.
 *
 * A decision layer nobody can inspect is just a slower model, so everything the plugin sent
 * and concluded has to be readable without opening a JSONL file by hand.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUDGETS, loadConfig, resolveApiKey, resolveStateDir } from "../shared/config.ts";
import { judgePlanReview, planRisks } from "../shared/policy.ts";
import { secretKeys } from "./secret.ts";
import { SessionStore, sessionActivity } from "../shared/state-store.ts";
import type { GateEntry, LedgerEntry, Thresholds } from "../shared/types.ts";

const ACTION_MARK: Record<string, string> = {
  proceed: "ok",
  proceed_and_flag: "ok*",
  proceed_unverified: "--",
  revise: "revise",
  confirm: "confirm",
  escalate_to_user: "asked you",
};

function sessionsDir(root: string): string {
  return join(root, "sessions");
}

interface SessionInfo {
  id: string;
  /** Last activity, from the files inside — the directory's own mtime does not move on append. */
  mtime: number;
  /** No decision and no gate event: a `claude -p` probe or a /jev:status session. */
  empty: boolean;
}

function listSessions(root: string): SessionInfo[] {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const id of readdirSync(dir)) {
    if (id.startsWith("_")) continue;
    const path = join(dir, id);
    try {
      const empty = !existsSync(join(path, "ledger.jsonl")) && !existsSync(join(path, "gates.jsonl"));
      out.push({ id, mtime: sessionActivity(path), empty });
    } catch {
      /* a session pruned mid-listing is not an error */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Local wall-clock time: the ledger is read by the person who was at the keyboard. */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The gate's own verdict for a reviewed plan.
 *
 * Printing every number above 0.6 was wrong three ways: coverage is a 0..2 level and always
 * cleared it, `has_verification` and `follows_decision_*` are good when high, and each
 * question has its own threshold. Entries written before `problems` was recorded are
 * re-judged; those also still carry coverage inside the review map.
 */
function reviewDetail(g: GateEntry, thresholds: Thresholds): string {
  if (!g.review) return "";
  const review = { ...g.review };
  let coverage = g.coverage;
  if (coverage === undefined && review["coverage"] !== undefined) {
    coverage = review["coverage"];
    delete review["coverage"];
  }
  const problems = g.problems ?? judgePlanReview(review, coverage, thresholds).problems;
  const risks = planRisks(review, thresholds);
  const parts = [problems.length ? problems.join("; ") : "cleared"];
  if (risks.length) parts.push(`irreversible: ${risks.join(", ")}`);
  if (coverage !== undefined) parts.push(`coverage ${coverage.toFixed(2)}/2`);
  return `: ${parts.join(" | ")}`;
}

function printSession(root: string, id: string, json: boolean, thresholds: Thresholds): void {
  const store = new SessionStore(root, id);
  const ledger = store.ledger();
  const gates = store.gates();
  if (json) {
    process.stdout.write(JSON.stringify({ session: id, ledger, gates }) + "\n");
    return;
  }
  process.stdout.write(`\nsession ${id}  (${ledger.length} decisions, ${gates.length} gate events)\n`);
  for (const e of ledger) {
    const conf = e.confidence !== undefined ? ` conf ${e.confidence.toFixed(2)}` : "";
    const stakes = e.effective_stakes ? ` [${e.effective_stakes}]` : "";
    const choice = e.choice ? ` -> ${e.choice}` : "";
    const mark = ACTION_MARK[e.action] ?? e.action;
    const plan = e.permission_mode === "plan" ? " (plan)" : "";
    const agent = e.agent_id ? ` (${e.agent_type ?? "subagent"})` : "";
    const error = e.error ? ` (${e.error})` : "";
    process.stdout.write(
      `  ${fmtTime(e.ts)} ${e.kind} ${e.label}${choice}${conf}${stakes} ${mark}${error}${plan}${agent}\n`,
    );
    if (e.why) process.stdout.write(`           why: ${e.why}\n`);
    for (const c of e.checks ?? []) {
      process.stdout.write(`           check ${c.id} -> ${c.verdict} (${c.p.toFixed(2)})\n`);
    }
  }
  for (const g of gates) {
    const detail =
      g.outcome === "reviewed" ? reviewDetail(g, thresholds) : g.why ? ` (${g.why})` : "";
    process.stdout.write(`  ${fmtTime(g.ts)} gate:${g.gate} ${g.outcome}${detail}\n`);
  }
}

/** Distribution of confidence against the action taken, to tune thresholds on real data. */
function calibration(root: string): void {
  const buckets = new Map<string, { n: number; actions: Map<string, number> }>();
  let total = 0;
  for (const { id } of listSessions(root)) {
    for (const e of new SessionStore(root, id).ledger()) {
      if (e.confidence === undefined) continue;
      total++;
      const key = (Math.floor(e.confidence * 10) / 10).toFixed(1);
      const b = buckets.get(key) ?? { n: 0, actions: new Map() };
      b.n++;
      b.actions.set(e.action, (b.actions.get(e.action) ?? 0) + 1);
      buckets.set(key, b);
    }
  }
  if (total === 0) {
    process.stdout.write("no decisions with a confidence recorded yet\n");
    return;
  }
  process.stdout.write(`confidence distribution over ${total} decisions\n`);
  for (const key of [...buckets.keys()].sort()) {
    const b = buckets.get(key)!;
    const actions = [...b.actions.entries()].map(([a, n]) => `${a} ${n}`).join(", ");
    process.stdout.write(`  ${key}-${(Number(key) + 0.1).toFixed(1)}  n=${String(b.n).padStart(4)}  ${actions}\n`);
  }
}

function doctor(root: string): void {
  const cfg = loadConfig();
  const { key, source } = resolveApiKey(cfg);
  const sessions = listSessions(root);
  const latest = sessions[0];
  const alive = latest ? new SessionStore(root, latest.id).isAlive() : false;

  process.stdout.write("jev plugin status\n");
  process.stdout.write(`  api key         ${key ? `set (…${key.slice(-4)}) from ${source}` : "MISSING"}\n`);
  process.stdout.write(`  enforcement     ${cfg.enforcement}\n`);
  process.stdout.write(`  authority       ${cfg.authority}\n`);
  process.stdout.write(`  question gate   ${cfg.router}\n`);
  process.stdout.write(`  on failure      fail ${cfg.fail}\n`);
  process.stdout.write(`  confidence axis ${cfg.confAxis}\n`);
  process.stdout.write(`  model           ${cfg.model ?? "jev-latest"}\n`);
  process.stdout.write(`  state dir       ${root}\n`);
  const withActivity = sessions.filter((s) => !s.empty).length;
  process.stdout.write(
    `  sessions        ${withActivity} with decisions (${sessions.length} total)${latest ? `, latest ${latest.id}` : ""}\n`,
  );
  process.stdout.write(`  hooks running   ${alive ? "yes" : "no (safe/bare mode, or hooks disabled)"}\n`);
  process.stdout.write(`  budgets ms      ${Object.entries(BUDGETS).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  if (!key) {
    process.stdout.write(
      "\nNo API key. Either export TYPESAFE_API_KEY (get one at https://console.typesafe.ai/keys)\n" +
        "or run: jev-doctor set-key\n",
    );
  }
}

/** Thrown when the user interrupts the prompt, so the command can exit 130 like a shell. */
class Interrupted extends Error {}

/**
 * Reads a secret from the terminal without echoing it.
 *
 * Deliberately not readline: it has no password mode, and suppressing its echo means
 * overriding an internal that also draws the prompt — which redraws the line and wipes the
 * prompt, leaving what looks like a hung command. Raw mode is more code but it is the whole
 * contract, visible in one place.
 */
async function promptSecret(prompt: string): Promise<string> {
  const input = process.stdin;

  // Piped input (`echo key | jev-doctor set-key`) has nothing to echo and no raw mode. Only the
  // first line is read: a pipe held open by its writer must not hang the command.
  if (!input.isTTY) {
    return await new Promise<string>((resolve) => {
      let buf = "";
      const done = (): void => {
        input.off("data", onData);
        input.off("end", done);
        input.pause();
        resolve(buf.split(/\r?\n/)[0] ?? "");
      };
      const onData = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        if (buf.includes("\n")) done();
      };
      input.on("data", onData);
      input.once("end", done);
    });
  }

  // The prompt goes to stderr so it survives if stdout is redirected to a file.
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  const state = { buf: "", esc: "" };
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (outcome: "done" | "interrupt"): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        if (outcome === "interrupt") reject(new Interrupted());
        else resolve(state.buf);
      };
      const onData = (chunk: string): void => {
        const r = secretKeys(state, chunk);
        if (r !== "more") finish(r);
      };
      const onEnd = (): void => finish("done");
      const onError = (err: Error): void => {
        input.off("data", onData);
        reject(err);
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    });
  } finally {
    // Whatever happened, the terminal is handed back cooked.
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
}

async function setKey(root: string): Promise<void> {
  let answer: string;
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
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "credentials.json");
  writeFileSync(path, JSON.stringify({ apiKey: value }) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  process.stdout.write(`saved to ${path} (mode 600)\n`);
}

const USAGE = `usage:
  jev-log [--session <id> | --all] [--json]   the decision ledger (default: latest session)
  jev-log --calibration                       confidence against action, over every session
  jev-doctor                                  configuration and health
  jev-doctor set-key                          store a TypeSafe API key (input hidden)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "log";
  if (cmd !== "log" && cmd !== "doctor") {
    // Falling through to the ledger made a typo look like a successful command.
    process.stderr.write(`jev: unknown command "${cmd}"\n${USAGE}`);
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

  // Argument errors are reported before "nothing recorded yet", so a typo never reads as an
  // empty ledger.
  const sessionArg = args.indexOf("--session");
  if (sessionArg !== -1) {
    const id = args[sessionArg + 1];
    // Silently falling back to the newest session would show an auditor a ledger they did
    // not ask for, with an exit status saying all was well.
    if (!id || id.startsWith("-")) {
      process.stderr.write("jev-log: --session needs a session id\n");
      process.exitCode = 2;
      return;
    }
    if (!sessions.some((s) => s.id === id)) {
      process.stderr.write(`jev-log: no session ${id} under ${root}\n`);
      process.exitCode = 1;
      return;
    }
    printSession(root, id, json, cfg.thresholds);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write(`no jev sessions recorded under ${root}\n`);
    return;
  }

  if (args.includes("--all")) {
    const shown = sessions.filter((s) => !s.empty);
    for (const s of shown) printSession(root, s.id, json, cfg.thresholds);
    const hidden = sessions.length - shown.length;
    if (hidden > 0 && !json) {
      process.stdout.write(`\n(${hidden} session(s) with no decisions and no gate events not shown)\n`);
    }
    return;
  }
  printSession(root, (sessions[0] as { id: string }).id, json, cfg.thresholds);
}

/**
 * process.exit() discards whatever is still buffered, and a piped stdout buffers at 64 KiB —
 * so a long ledger came out truncated mid-JSON with a success status.
 */
async function flushStdout(): Promise<void> {
  if (process.stdout.writableLength === 0) return;
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
}

void main().then(
  async () => {
    await flushStdout();
    process.exit(process.exitCode ?? 0);
  },
  async (err: unknown) => {
    process.stderr.write(`jev: ${err instanceof Error ? err.message : String(err)}\n`);
    await flushStdout();
    process.exit(1);
  },
);

export type { GateEntry, LedgerEntry };
