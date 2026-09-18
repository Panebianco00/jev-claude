import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, sanitizeSegment } from "../../src/shared/state-store.ts";
import type { CallContext, GateEntry, LedgerEntry, PromptEntry } from "../../src/shared/types.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..");
const TMP = join(repo, "test", ".tmp", "state-store");

/**
 * Child processes exercise the real module, bundled the way the plugin ships it,
 * so the concurrency guarantees are tested against production code rather than a copy.
 */
let bundleUrl = "";

function ledgerEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return { v: 1, ts: 1, kind: "decide", session_id: "s", label: "l", action: "proceed", ...over };
}

function gateEntry(over: Partial<GateEntry> = {}): GateEntry {
  return { v: 1, ts: 1, gate: "plan", outcome: "denied", session_id: "s", ...over };
}

function promptEntry(over: Partial<PromptEntry> = {}): PromptEntry {
  return { v: 1, ts: 1, text: "hello", ...over };
}

function callContext(over: Partial<CallContext> = {}): CallContext {
  return {
    session_id: "s1",
    ts: 100,
    enforcement: "standard",
    authority: "autonomous",
    fail: "open",
    interactive: true,
    ...over,
  };
}

function run(code: string, env: NodeJS.ProcessEnv = {}): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (status) => done({ out: out.trim() || err.trim(), code: status }));
  });
}

let root = "";

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  const outfile = join(TMP, "state-store.bundle.mjs");
  await build({
    entryPoints: [join(repo, "src", "shared", "state-store.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  bundleUrl = pathToFileURL(outfile).href;
}, 60_000);

beforeEach(() => {
  root = join(TMP, `root-${process.pid}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("sanitizeSegment", () => {
  it("keeps safe characters and replaces everything else", () => {
    expect(sanitizeSegment("abc-123_XYZ")).toBe("abc-123_XYZ");
    expect(sanitizeSegment("../../etc/passwd")).toBe("------etc-passwd");
    expect(sanitizeSegment("a/b")).toBe("a-b");
  });

  it("falls back to a digest for an empty or dot segment", () => {
    expect(sanitizeSegment("")).toMatch(/^[0-9a-f]{32}$/);
    expect(sanitizeSegment(".")).toBe("-");
    expect(sanitizeSegment("...")).toBe("---");
  });

  it("keeps distinct long ids distinct", () => {
    const a = sanitizeSegment("x".repeat(400) + "a");
    const b = sanitizeSegment("x".repeat(400) + "b");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(120);
  });
});

describe("jsonl round trips", () => {
  it("appends and reads back all three kinds", () => {
    const s = new SessionStore(root, "sess-1");
    s.ensureDirs();
    s.appendLedger(ledgerEntry({ ts: 1, label: "one" }));
    s.appendLedger(ledgerEntry({ ts: 2, label: "two", kind: "check" }));
    s.appendGate(gateEntry({ ts: 3, outcome: "passed" }));
    s.appendPrompt(promptEntry({ ts: 4, text: "do the thing" }));

    expect(s.ledger().map((e) => e.label)).toEqual(["one", "two"]);
    expect(s.ledger()[1]?.kind).toBe("check");
    expect(s.gates().map((g) => g.outcome)).toEqual(["passed"]);
    expect(s.prompts().map((p) => p.text)).toEqual(["do the thing"]);
  });

  it("returns empty arrays when nothing was ever written", () => {
    const s = new SessionStore(root, "missing");
    expect(s.ledger()).toEqual([]);
    expect(s.gates()).toEqual([]);
    expect(s.prompts()).toEqual([]);
    expect(s.prompts(10)).toEqual([]);
  });

  it("skips corrupt lines instead of throwing", () => {
    const s = new SessionStore(root, "sess-2");
    s.ensureDirs();
    s.appendLedger(ledgerEntry({ label: "first" }));
    writeFileSync(join(s.dir, "ledger.jsonl"), `${readFileSync(join(s.dir, "ledger.jsonl"), "utf8")}`);
    // A torn write, a bare scalar and a blank line all have to be tolerated.
    writeFileSync(
      join(s.dir, "ledger.jsonl"),
      [
        JSON.stringify(ledgerEntry({ label: "first" })),
        '{"v":1,"ts":2,"kind":"dec',
        "",
        "   ",
        "42",
        "null",
        JSON.stringify(ledgerEntry({ label: "last" })),
      ].join("\n"),
    );
    expect(s.ledger().map((e) => e.label)).toEqual(["first", "last"]);
  });

  it("filters prompts by timestamp", () => {
    const s = new SessionStore(root, "sess-3");
    s.appendPrompt(promptEntry({ ts: 10, text: "old" }));
    s.appendPrompt(promptEntry({ ts: 20, text: "new" }));
    expect(s.prompts(15).map((p) => p.text)).toEqual(["new"]);
    expect(s.prompts(10).map((p) => p.text)).toEqual(["old", "new"]);
  });

  it("caps an oversized prompt or gate line while keeping it parsable", () => {
    const s = new SessionStore(root, "sess-5");
    s.appendPrompt(promptEntry({ ts: 7, prompt_id: "p1", text: "P".repeat(50_000) }));
    s.appendGate(gateEntry({ ts: 8, why: "W".repeat(50_000), planHash: "abc123" }));

    const promptLines = readFileSync(join(s.dir, "prompts.jsonl"), "utf8").split("\n").filter(Boolean);
    const gateLines = readFileSync(join(s.dir, "gates.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(promptLines).toHaveLength(1);
    expect(gateLines).toHaveLength(1);
    for (const line of [...promptLines, ...gateLines]) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4000);
    }

    const prompt = s.prompts()[0];
    expect(prompt?.prompt_id).toBe("p1");
    expect(prompt?.ts).toBe(7);
    expect(prompt?.text.length).toBeGreaterThan(100);
    expect(s.gates()[0]?.gate).toBe("plan");
    expect(s.gates()[0]?.planHash).toBe("abc123");
  });

  it("enforces the 4000 byte line invariant on append", () => {
    const s = new SessionStore(root, "sess-4");
    s.appendLedger(
      ledgerEntry({
        label: "big",
        option_ids: Array.from({ length: 2000 }, (_, i) => `option-${i}-${"x".repeat(20)}`),
      }),
    );
    const lines = readFileSync(join(s.dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0] ?? "", "utf8")).toBeLessThanOrEqual(4000);
    expect(s.ledger()[0]?.truncated).toBe(true);
  });
});

describe("path traversal", () => {
  it("neutralises a session id that tries to escape the root", () => {
    const s = new SessionStore(root, "../../escape");
    s.ensureDirs();
    s.appendLedger(ledgerEntry());
    expect(s.dir.startsWith(join(root, "sessions"))).toBe(true);
    expect(existsSync(join(root, "..", "escape"))).toBe(false);
    expect(readdirSync(join(root, "sessions"))).toEqual(["------escape"]);
  });

  it("neutralises a traversing claim kind and key", () => {
    const s = new SessionStore(root, "sess");
    expect(s.claim("../../evil", "../../../tmp/pwned")).toBe(true);
    expect(existsSync(join(root, "..", "evil"))).toBe(false);
    const kinds = readdirSync(join(s.dir, "claims"));
    expect(kinds).toEqual(["------evil"]);
    expect(readdirSync(join(s.dir, "claims", "------evil"))).toEqual(["---------tmp-pwned"]);
    // The sanitised key still identifies the same claim on the next call.
    expect(s.claim("../../evil", "../../../tmp/pwned")).toBe(false);
  });
});

describe("claims", () => {
  it("is won once in a single process", () => {
    const s = new SessionStore(root, "sess");
    expect(s.hasClaim("gate", "k")).toBe(false);
    expect(s.claim("gate", "k")).toBe(true);
    expect(s.claim("gate", "k")).toBe(false);
    expect(s.hasClaim("gate", "k")).toBe(true);
    expect(s.claim("gate", "other")).toBe(true);
    expect(s.claim("router", "k")).toBe(true);
  });

  it("is won by exactly one of 8 racing processes", async () => {
    const startAt = Date.now() + 400;
    const code = `
      const { SessionStore } = await import(${JSON.stringify(bundleUrl)});
      const s = new SessionStore(${JSON.stringify(root)}, "race");
      s.ensureDirs();
      while (Date.now() < ${startAt}) {}
      process.stdout.write(s.claim("gate", "plan:abc") ? "WON" : "LOST");
    `;
    const results = await Promise.all(Array.from({ length: 8 }, () => run(code)));
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.filter((r) => r.out === "WON")).toHaveLength(1);
    expect(results.filter((r) => r.out === "LOST")).toHaveLength(7);
  }, 60_000);
});

describe("concurrent appends", () => {
  it("writes 8 x 200 lines with no torn JSON", async () => {
    const startAt = Date.now() + 500;
    const child = (n: number) => `
      const { SessionStore } = await import(${JSON.stringify(bundleUrl)});
      const s = new SessionStore(${JSON.stringify(root)}, "busy");
      s.ensureDirs();
      while (Date.now() < ${startAt}) {}
      for (let i = 0; i < 200; i++) {
        s.appendLedger({
          v: 1, ts: Date.now(), kind: "decide", session_id: "busy",
          label: "w${n}-" + i, action: "proceed",
          option_ids: ["a".repeat(50), "b".repeat(50)],
        });
      }
      process.stdout.write("DONE");
    `;
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => run(child(n))));
    expect(results.map((r) => r.out)).toEqual(Array.from({ length: 8 }, () => "DONE"));

    const s = new SessionStore(root, "busy");
    const raw = readFileSync(join(s.dir, "ledger.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    expect(raw).toHaveLength(1600);
    for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();

    const labels = new Set(s.ledger().map((e) => e.label));
    expect(s.ledger()).toHaveLength(1600);
    expect(labels.size).toBe(1600);
  }, 60_000);
});

describe("liveness", () => {
  it("reports alive only after a heartbeat and within the window", () => {
    const s = new SessionStore(root, "sess");
    expect(s.isAlive()).toBe(false);
    s.markAlive();
    expect(s.isAlive()).toBe(true);

    // A session whose last hook ran 20 hours ago is outside the default window.
    writeFileSync(join(s.dir, "alive"), String(Date.now() - 20 * 60 * 60 * 1000));
    expect(s.isAlive()).toBe(false);
    expect(s.isAlive(24 * 60 * 60 * 1000)).toBe(true);
  });

  it("falls back to the file mtime when the heartbeat is corrupt", () => {
    const s = new SessionStore(root, "sess");
    s.ensureDirs();
    const file = join(s.dir, "alive");
    writeFileSync(file, "not-a-number");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(file, twoHoursAgo, twoHoursAgo);

    expect(() => s.isAlive()).not.toThrow();
    expect(s.isAlive()).toBe(true);
    expect(s.isAlive(60 * 60 * 1000)).toBe(false);
  });
});

describe("ctx and call handoff", () => {
  it("round trips atomically and leaves no temp files", () => {
    const s = new SessionStore(root, "sess");
    const ctx = callContext({ prompt_id: "p1", agent_id: "a1" });
    s.writeCtx("toolu_01", ctx);
    s.writeCall("toolu_01", { tool: "decide", label: "x" });

    expect(s.readCtx("toolu_01")).toEqual(ctx);
    expect(s.readCall("toolu_01")).toEqual({ tool: "decide", label: "x" });
    expect(readdirSync(join(root, "ctx"))).toEqual(["toolu_01.json"]);
    expect(readdirSync(join(root, "calls"))).toEqual(["toolu_01.json"]);
  });

  it("returns undefined for a missing or corrupt handoff file", () => {
    const s = new SessionStore(root, "sess");
    expect(s.readCtx("nope")).toBeUndefined();
    expect(s.readCall("nope")).toBeUndefined();
    s.ensureDirs();
    writeFileSync(join(root, "ctx", "bad.json"), "{not json");
    expect(s.readCtx("bad")).toBeUndefined();
  });

  it("drops both halves and is idempotent", () => {
    const s = new SessionStore(root, "sess");
    s.writeCtx("t1", callContext());
    s.writeCall("t1", { a: 1 });
    s.dropCall("t1");
    expect(s.readCtx("t1")).toBeUndefined();
    expect(s.readCall("t1")).toBeUndefined();
    expect(() => s.dropCall("t1")).not.toThrow();
    expect(() => s.dropCall("never-existed")).not.toThrow();
  });

  it("overwrites an existing record in place", () => {
    const s = new SessionStore(root, "sess");
    s.writeCall("t2", { v: 1 });
    s.writeCall("t2", { v: 2 });
    expect(s.readCall("t2")).toEqual({ v: 2 });
    expect(readdirSync(join(root, "calls"))).toEqual(["t2.json"]);
  });
});

describe("prune", () => {
  // Ages the directory and everything in it: activity is read from the files as well.
  const ageDir = (dir: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), when, when);
    utimesSync(dir, when, when);
  };

  function seed(): SessionStore {
    const current = new SessionStore(root, "current");
    current.ensureDirs();
    current.appendLedger(ledgerEntry({ label: "keep-me" }));
    for (const id of ["old", "fresh"]) {
      const s = new SessionStore(root, id);
      s.ensureDirs();
      s.appendLedger(ledgerEntry({ label: id }));
    }
    ageDir(join(root, "sessions", "old"), 10 * 24 * 60 * 60 * 1000);
    ageDir(join(root, "sessions", "current"), 10 * 24 * 60 * 60 * 1000);
    return current;
  }

  it("removes stale sessions, keeps fresh ones and never touches the running one", () => {
    const current = seed();
    current.prune({ retainDays: 7, keepSessionId: "current" });
    expect(readdirSync(join(root, "sessions")).sort()).toEqual(["current", "fresh"]);
    expect(current.ledger().map((e) => e.label)).toEqual(["keep-me"]);
  });

  it("slides the kept session out of the retention window", () => {
    const current = seed();
    current.prune({ retainDays: 7, keepSessionId: "current" });
    current.prune({ retainDays: 7, keepSessionId: undefined });
    expect(readdirSync(join(root, "sessions")).sort()).toEqual(["current", "fresh"]);
  });

  it("retainDays 0 deletes every idle session but the one running", () => {
    const current = seed();
    ageDir(join(root, "sessions", "fresh"), 2 * 60 * 60 * 1000);
    current.prune({ retainDays: 0, keepSessionId: "current" });
    expect(readdirSync(join(root, "sessions"))).toEqual(["current"]);
  });

  it("never prunes a session that is still being written to, whatever the window", () => {
    // Regression: the directory's own mtime does not move when a file inside is appended
    // to, so a long session looked idle and was deleted by the next session's start.
    const current = seed();
    const busy = join(root, "sessions", "busy");
    const s = new SessionStore(root, "busy");
    s.ensureDirs();
    s.appendLedger(ledgerEntry({ label: "busy" }));
    ageDir(busy, 10 * 24 * 60 * 60 * 1000);
    s.appendLedger(ledgerEntry({ label: "still going" })); // fresh file, stale directory
    current.prune({ retainDays: 1, keepSessionId: "current" });
    current.prune({ retainDays: 0, keepSessionId: "current" });
    expect(readdirSync(join(root, "sessions"))).toContain("busy");
  });

  it("sanitises keepSessionId the same way the store does", () => {
    const s = new SessionStore(root, "../../weird");
    s.ensureDirs();
    s.appendLedger(ledgerEntry());
    s.prune({ retainDays: 0, keepSessionId: "../../weird" });
    expect(readdirSync(join(root, "sessions"))).toEqual(["------weird"]);
  });

  it("removes handoff files older than an hour and keeps recent ones", () => {
    const s = new SessionStore(root, "current");
    s.writeCtx("old", callContext());
    s.writeCall("old", { a: 1 });
    s.writeCtx("recent", callContext());
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(root, "ctx", "old.json"), stale, stale);
    utimesSync(join(root, "calls", "old.json"), stale, stale);

    s.prune({ retainDays: 7, keepSessionId: "current" });
    expect(readdirSync(join(root, "ctx"))).toEqual(["recent.json"]);
    expect(readdirSync(join(root, "calls"))).toEqual([]);
  });

  it("is a no-op on an empty root and never throws", () => {
    const s = new SessionStore(join(root, "never-created"), "sess");
    expect(() => s.prune({ retainDays: 7, keepSessionId: "sess" })).not.toThrow();
    expect(() => s.prune({ retainDays: 0 })).not.toThrow();
  });

  it("honours an injected clock", () => {
    const current = seed();
    // Two days after the fixture was written, a one-day window keeps nothing but `current`.
    current.prune({
      retainDays: 1,
      keepSessionId: "current",
      now: Date.now() + 2 * 24 * 60 * 60 * 1000,
    });
    expect(readdirSync(join(root, "sessions"))).toEqual(["current"]);
  });
});

describe("debugLog", () => {
  it("writes one line per call under the root", () => {
    const s = new SessionStore(root, "sess");
    s.debugLog("hello");
    s.debugLog("multi\nline\nentry");
    const lines = readFileSync(join(root, "log", "hooks.log"), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("multi line entry");
  });

  it("never throws when the root cannot be created", () => {
    // A regular file where the root should be: every mkdir below it fails with ENOTDIR.
    mkdirSync(root, { recursive: true });
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "");

    const s = new SessionStore(blocked, "sess");
    expect(() => s.debugLog("x")).not.toThrow();
    expect(() => s.appendLedger(ledgerEntry())).not.toThrow();
    expect(() => s.ensureDirs()).not.toThrow();
    expect(() => s.writeCtx("t", callContext())).not.toThrow();
    expect(() => s.prune({ retainDays: 1 })).not.toThrow();
    expect(s.ledger()).toEqual([]);
    expect(s.readCtx("t")).toBeUndefined();
    expect(s.claim("k", "v")).toBe(false);
    expect(s.isAlive()).toBe(false);
  });
});
