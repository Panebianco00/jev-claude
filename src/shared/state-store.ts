/**
 * The plugin's on-disk state: the ledger, the hook/server handoff files and the
 * one-shot claims the gates use to bound themselves.
 *
 * Nothing in this module throws. Hooks fail open by contract, so a missing, corrupt or
 * unwritable file has to degrade to an empty result — a state-store exception would take
 * out the hook around it and, with it, the session's ability to edit or exit plan mode.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveStateDir } from "./config.ts";
import { shrinkLedgerEntry } from "./ledger.ts";
import type { CallContext, Config, GateEntry, LedgerEntry, PromptEntry } from "./types.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Matches the ledger's own budget: one line, one write, small enough not to tear. */
const MAX_LINE_BYTES = 4000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A session older than this without a heartbeat means hooks are not running at all. */
const ALIVE_MAX_AGE_MS = 12 * HOUR_MS;
/**
 * Activity this recent means another Claude session may still be writing here. Retention,
 * even `retainDays: 0`, never deletes it: pruning happens at *some* session's start, and
 * a concurrently open session is running too.
 */
const LIVE_GRACE_MS = HOUR_MS;
/** Comfortably inside NAME_MAX (255) once the ".json" and ".<pid>.tmp" suffixes are added. */
const SEGMENT_MAX = 120;

/**
 * Make an untrusted id usable as one path segment.
 *
 * Session ids, claim kinds and claim keys all come from the host or from a gate, so the
 * only safe assumption is that they are arbitrary text.
 */
export function sanitizeSegment(s: string): string {
  const src = typeof s === "string" ? s : "";
  const cleaned = src.replace(/[^A-Za-z0-9_-]/g, "-");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return createHash("sha256").update(src).digest("hex").slice(0, 32);
  }
  if (cleaned.length > SEGMENT_MAX) {
    // The digest of the full input keeps two long ids with a shared prefix apart.
    const digest = createHash("sha256").update(src).digest("hex").slice(0, 16);
    return `${cleaned.slice(0, SEGMENT_MAX - digest.length - 1)}-${digest}`;
  }
  return cleaned;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Fields that identify a line; clipping them would make the record unjoinable. */
const IDENTITY_FIELDS = new Set([
  "v",
  "ts",
  "kind",
  "gate",
  "outcome",
  "action",
  "session_id",
  "prompt_id",
  "agent_id",
  "truncated",
]);

/**
 * Serialise one line, capped.
 *
 * The no-interleaving guarantee of an O_APPEND write only holds for small writes, so the
 * cap is enforced here rather than trusted to the caller: a ledger entry arrives already
 * shrunk, but a prompt or a gate review can be arbitrarily long.
 */
function fitLine(entry: unknown): string {
  let line = JSON.stringify(entry) ?? "null";
  if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES || !isPlainObject(entry)) return line;

  const copy: Record<string, unknown> = { ...entry, truncated: true };
  for (let i = 0; i < 64; i++) {
    line = JSON.stringify(copy) ?? "null";
    if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) return line;

    let widest: string | undefined;
    let width = 0;
    for (const [k, v] of Object.entries(copy)) {
      if (IDENTITY_FIELDS.has(k)) continue;
      const n = typeof v === "string" ? v.length : (JSON.stringify(v) ?? "").length;
      if (n > width) {
        width = n;
        widest = k;
      }
    }
    if (widest === undefined) return line;
    const value = copy[widest];
    if (typeof value === "string" && value.length > 1) copy[widest] = value.slice(0, value.length >> 1);
    else delete copy[widest];
  }
  return line;
}

/**
 * When a session directory last saw activity: the newest mtime of the directory and the
 * files directly in it.
 *
 * The directory's own mtime alone is not it. Appending to `ledger.jsonl` or rewriting
 * `alive` changes the file, not the directory, so a session open for days looked idle and
 * was pruned mid-session by whichever session started next.
 */
export function sessionActivity(dir: string): number {
  let newest = statSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* a file removed mid-scan says nothing about activity */
    }
  }
  return newest;
}

export class SessionStore {
  readonly root: string;
  readonly sessionId: string;
  readonly dir: string;

  constructor(root: string, sessionId: string) {
    this.root = resolve(root);
    this.sessionId = sanitizeSegment(sessionId);
    this.dir = join(this.root, "sessions", this.sessionId);
  }

  static from(cfg: Config, sessionId: string, env?: NodeJS.ProcessEnv): SessionStore {
    return new SessionStore(resolveStateDir(cfg, env), sessionId);
  }

  /* --------------------------------------------------------------- paths */

  /** Defence in depth behind sanitizeSegment: a path that escapes the root is never used. */
  private inside(p: string): boolean {
    const abs = resolve(p);
    return abs === this.root || abs.startsWith(this.root + sep);
  }

  private mkdir(dir: string): boolean {
    if (!this.inside(dir)) return false;
    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      return true;
    } catch {
      return false;
    }
  }

  ensureDirs(): void {
    this.mkdir(this.dir);
    this.mkdir(join(this.root, "ctx"));
    this.mkdir(join(this.root, "calls"));
  }

  /* --------------------------------------------------------------- jsonl */

  private appendJsonl(name: string, entry: unknown): void {
    if (!this.mkdir(this.dir)) return;
    try {
      // One O_APPEND write per line: concurrent hooks and servers must not interleave.
      appendFileSync(join(this.dir, name), `${fitLine(entry)}\n`, { encoding: "utf8", mode: FILE_MODE });
    } catch {
      // A full disk or a read-only state dir must not break the surrounding hook.
    }
  }

  private readJsonl<T>(name: string): T[] {
    const file = join(this.dir, name);
    if (!this.inside(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) out.push(parsed as T);
      } catch {
        // A torn or hand-edited line is skipped; the rest of the ledger is still evidence.
      }
    }
    return out;
  }

  appendLedger(entry: LedgerEntry): void {
    this.appendJsonl("ledger.jsonl", shrinkLedgerEntry(entry));
  }

  ledger(): LedgerEntry[] {
    return this.readJsonl<LedgerEntry>("ledger.jsonl");
  }

  appendGate(entry: GateEntry): void {
    this.appendJsonl("gates.jsonl", entry);
  }

  gates(): GateEntry[] {
    return this.readJsonl<GateEntry>("gates.jsonl");
  }

  appendPrompt(entry: PromptEntry): void {
    this.appendJsonl("prompts.jsonl", entry);
  }

  prompts(sinceTs?: number): PromptEntry[] {
    const all = this.readJsonl<PromptEntry>("prompts.jsonl");
    if (sinceTs === undefined) return all;
    return all.filter((p) => typeof p.ts === "number" && p.ts >= sinceTs);
  }

  /* --------------------------------------------------------------- claims */

  private claimPath(kind: string, key: string): string {
    return join(this.dir, "claims", sanitizeSegment(kind), sanitizeSegment(key));
  }

  /**
   * Take a one-shot decision. True only for the winner, including across processes:
   * O_CREAT|O_EXCL is the arbiter, so two hooks racing on the same gate cannot both act.
   */
  claim(kind: string, key: string): boolean {
    const file = this.claimPath(kind, key);
    if (!this.mkdir(dirname(file))) return false;
    try {
      closeSync(openSync(file, "wx", FILE_MODE));
      return true;
    } catch {
      // EEXIST means someone else won; anything else means we cannot tell, so we stand down.
      return false;
    }
  }

  hasClaim(kind: string, key: string): boolean {
    const file = this.claimPath(kind, key);
    if (!this.inside(file)) return false;
    try {
      return existsSync(file);
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------------- liveness */

  markAlive(): void {
    const file = join(this.dir, "alive");
    if (!this.mkdir(this.dir)) return;
    try {
      writeFileSync(file, String(Date.now()), { encoding: "utf8", mode: FILE_MODE });
    } catch {
      /* liveness is advisory */
    }
  }

  /**
   * Whether a hook has run in this session recently. The server uses it to tell the
   * difference between "enforced" and safe/bare mode, where hooks never run at all.
   */
  isAlive(maxAgeMs: number = ALIVE_MAX_AGE_MS): boolean {
    const file = join(this.dir, "alive");
    if (!this.inside(file)) return false;
    try {
      const ts = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      const stamp = Number.isFinite(ts) ? ts : statSync(file).mtimeMs;
      return Date.now() - stamp <= maxAgeMs;
    } catch {
      return false;
    }
  }

  /* ----------------------------------------------------- hook/server files */

  private handoffPath(bucket: "ctx" | "calls", toolUseId: string): string {
    return join(this.root, bucket, `${sanitizeSegment(toolUseId)}.json`);
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    if (!this.mkdir(dirname(file))) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: FILE_MODE });
      // Rename so a reader never observes a half-written file.
      renameSync(tmp, file);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing left to clean up */
      }
    }
  }

  private readJson(file: string): unknown | undefined {
    if (!this.inside(file)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return parsed;
    } catch {
      return undefined;
    }
  }

  writeCtx(toolUseId: string, ctx: CallContext): void {
    this.writeJsonAtomic(this.handoffPath("ctx", toolUseId), ctx);
  }

  readCtx(toolUseId: string): CallContext | undefined {
    const parsed = this.readJson(this.handoffPath("ctx", toolUseId));
    return isPlainObject(parsed) ? (parsed as unknown as CallContext) : undefined;
  }

  writeCall(toolUseId: string, record: unknown): void {
    this.writeJsonAtomic(this.handoffPath("calls", toolUseId), record);
  }

  readCall(toolUseId: string): unknown | undefined {
    return this.readJson(this.handoffPath("calls", toolUseId));
  }

  /** Both halves of the handoff are done with once the ledger line is written. */
  dropCall(toolUseId: string): void {
    for (const bucket of ["ctx", "calls"] as const) {
      const file = this.handoffPath(bucket, toolUseId);
      if (!this.inside(file)) continue;
      try {
        unlinkSync(file);
      } catch {
        // ENOENT is the normal case: the other half may never have been written.
      }
    }
  }

  /* --------------------------------------------------------------- pruning */

  private sweepHandoff(bucket: "ctx" | "calls", cutoff: number): void {
    const dir = join(this.root, bucket);
    if (!this.inside(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        /* another process may have removed it first */
      }
    }
  }

  /**
   * Age out old state. Called from SessionStart, where the one thing that must survive
   * is the session being resumed: pruning it would silently drop the ledger a long
   * session is still appending to.
   */
  prune(opts: { retainDays: number; keepSessionId?: string; now?: number }): void {
    const now = opts.now ?? Date.now();
    this.sweepHandoff("ctx", now - HOUR_MS);
    this.sweepHandoff("calls", now - HOUR_MS);

    const sessions = join(this.root, "sessions");
    if (!this.inside(sessions)) return;
    let names: string[];
    try {
      names = readdirSync(sessions);
    } catch {
      return;
    }

    const keep = opts.keepSessionId === undefined ? undefined : sanitizeSegment(opts.keepSessionId);
    const cutoff = now - Math.max(0, opts.retainDays) * DAY_MS;

    for (const name of names) {
      const dir = join(sessions, name);
      if (!this.inside(dir)) continue;
      try {
        // Pseudo-sessions hold state that is deliberately not per-session, such as the
        // once-per-project disclosure claim; ageing them out would repeat the notice.
        if (name.startsWith("_")) continue;
        if (name === keep) {
          // Slide the kept session out of the window so a long session is never a candidate.
          const stamp = new Date(now);
          utimesSync(dir, stamp, stamp);
          continue;
        }
        const active = sessionActivity(dir);
        if (active >= now - LIVE_GRACE_MS) continue;
        if (opts.retainDays > 0 && active >= cutoff) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a locked or vanished directory is left alone */
      }
    }
  }

  /* ----------------------------------------------------------------- debug */

  debugLog(line: string): void {
    const dir = join(this.root, "log");
    if (!this.mkdir(dir)) return;
    try {
      const flat = line.replace(/[\r\n]+/g, " ");
      const capped = Buffer.byteLength(flat, "utf8") > 4000 ? `${flat.slice(0, 2000)}…` : flat;
      appendFileSync(join(dir, "hooks.log"), `${new Date().toISOString()} [${process.pid}] ${capped}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
      });
    } catch {
      /* logging must never be load-bearing */
    }
  }
}
