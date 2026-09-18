import { describe, expect, it } from "vitest";
import { looksExternal, redactDeep, redactText, truncateState } from "../../src/shared/redact.ts";

describe("redactText", () => {
  it("redacts the value of a secret-looking assignment and keeps the name", () => {
    expect(redactText('api_key: "abcd1234efgh5678"')).toBe('api_key: "[REDACTED:secret]"');
    expect(redactText("API-KEY=abcd1234efgh5678")).toBe("API-KEY=[REDACTED:secret]");
    expect(redactText("client_secret = hunter2hunter2")).toBe("client_secret = [REDACTED:secret]");
    expect(redactText("password: hunter2")).toBe("password: [REDACTED:secret]");
    expect(redactText("passwd=hunter2")).toBe("passwd=[REDACTED:secret]");
    expect(redactText("refresh_token: 9f8e7d6c5b4a")).toBe("refresh_token: [REDACTED:secret]");
  });

  it("redacts an Authorization header including the scheme's value", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer [REDACTED:secret]",
    );
  });

  it("redacts sk- keys of 16 chars or more", () => {
    expect(redactText("use sk-ant-api03-AAAAAAAAAAAAAAAAAAAA now")).toBe(
      "use [REDACTED:api_key] now",
    );
    expect(redactText("sk-short")).toBe("sk-short");
  });

  it("redacts GitHub tokens", () => {
    expect(redactText("ghp_0123456789abcdefghijABCDEFGH")).toBe("[REDACTED:github_token]");
    expect(redactText("gho_0123456789abcdefghijABCDEFGH")).toBe("[REDACTED:github_token]");
  });

  it("redacts AWS access key ids", () => {
    expect(redactText("AKIAIOSFODNN7EXAMPLE is the id")).toBe("[REDACTED:aws_key_id] is the id");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
    expect(redactText(`cookie ${jwt} end`)).toBe("cookie [REDACTED:jwt] end");
  });

  it("redacts PEM private key blocks whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAx",
      "QVBCREVGRw==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactText(`before\n${pem}\nafter`)).toBe("before\n[REDACTED:private_key]\nafter");
  });

  it("redacts Slack tokens", () => {
    expect(redactText("xoxb-123456789012-abcdefgHIJKL")).toBe("[REDACTED:slack_token]");
  });

  it("leaves ordinary prose alone", () => {
    const prose =
      "The parser reads one token at a time and the secret sauce is that a password reset " +
      "never logs the user out. A key insight: tokens are cheap. See docs/auth.md.";
    expect(redactText(prose)).toBe(prose);
    expect(redactText("skip-this-file.ts and gh_notes.md")).toBe("skip-this-file.ts and gh_notes.md");
  });
});

describe("redactDeep", () => {
  it("walks objects and arrays without mutating the input", () => {
    const input = {
      note: "token counts are fine",
      env: { AUTH: "authorization=abcd1234efgh5678", nested: [{ k: "ghp_0123456789abcdefghijABCDEFGH" }] },
      keep: [1, true, null],
    };
    const snapshot = structuredClone(input);
    const out = redactDeep(input);

    expect(input).toEqual(snapshot);
    expect(out.note).toBe("token counts are fine");
    expect(out.env.AUTH).toBe("authorization=[REDACTED:secret]");
    expect(out.env.nested[0]?.k).toBe("[REDACTED:github_token]");
    expect(out.keep).toEqual([1, true, null]);
    expect(out).not.toBe(input);
  });

  it("passes non-string primitives through untouched", () => {
    expect(redactDeep(7)).toBe(7);
    expect(redactDeep(null)).toBe(null);
    expect(redactDeep(undefined)).toBe(undefined);
  });
});

describe("truncateState", () => {
  const long = (n: number, ch = "x"): string => ch.repeat(n);

  it("leaves a small state untouched and reports nothing", () => {
    const state = { user_request: "add a flag", plan: "edit one file" };
    expect(truncateState(state)).toEqual({ value: state, truncated: [] });
  });

  it("shortens an oversized field with a visible marker instead of slicing silently", () => {
    const { value, truncated } = truncateState({ notes: long(5000) }, { maxField: 100, maxTotal: 1000 });
    const notes = value["notes"];
    expect(typeof notes).toBe("string");
    expect(notes as string).toMatch(/^x{100} …\[truncated, 4900 chars dropped\]$/);
    expect(truncated).toEqual(["notes"]);
  });

  it("keeps user_request and drops the low-priority fields first", () => {
    const state = {
      zeta: long(3000, "z"),
      plan: long(3000, "p"),
      user_request: "ship the parser",
      constraints: "no new deps",
    };
    const { value, truncated } = truncateState(state, { maxField: 4000, maxTotal: 3100 });

    expect(value["user_request"]).toBe("ship the parser");
    expect(value["constraints"]).toBe("no new deps");
    expect(value["plan"]).toBe(long(3000, "p"));
    expect(value["zeta"]).toBeUndefined();
    expect(truncated).toEqual(["zeta"]);
    expect(Object.keys(value)[0]).toBe("user_request");
  });

  it("shortens a low-priority field when the leftover budget is worth using", () => {
    const state = {
      user_request: "ship the parser",
      zeta: long(3000, "z"),
    };
    const { value, truncated } = truncateState(state, { maxField: 4000, maxTotal: 600 });
    expect(value["user_request"]).toBe("ship the parser");
    expect(value["zeta"] as string).toMatch(/^z+ …\[truncated, \d+ chars dropped\]$/);
    expect((value["zeta"] as string).length).toBeLessThan(600);
    expect(truncated).toEqual(["zeta"]);
  });

  it("always fits maxTotal, measured as JSON", () => {
    const state = {
      user_request: long(2000, "u"),
      plan: long(4000, "p"),
      diff: long(6000, "d"),
      log: long(6000, "l"),
    };
    for (const maxTotal of [200, 900, 2500, 6000]) {
      const { value, truncated } = truncateState(state, { maxTotal });
      expect(JSON.stringify(value).length).toBeLessThanOrEqual(maxTotal);
      expect(truncated.length).toBeGreaterThan(0);
    }
  });

  it("drops an oversized nested field rather than slicing it", () => {
    const state = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: long(40) })) };
    const { value, truncated } = truncateState(state, { maxField: 500, maxTotal: 12000 });
    expect(value["rows"]).toBeUndefined();
    expect(truncated).toEqual(["rows"]);
  });

  it("keeps a nested value structured when it fits", () => {
    const state = { facts: { files: 3, langs: ["ts"] } };
    const { value, truncated } = truncateState(state);
    expect(value["facts"]).toEqual({ files: 3, langs: ["ts"] });
    expect(truncated).toEqual([]);
  });

  it("reports every affected key exactly once", () => {
    const state = { user_request: long(5000, "u"), notes: long(5000, "n") };
    const { truncated } = truncateState(state, { maxField: 1000, maxTotal: 1200 });
    expect(truncated).toEqual([...new Set(truncated)]);
    expect(truncated).toContain("notes");
  });
});

describe("looksExternal", () => {
  it("is true for keys that name third-party material", () => {
    expect(looksExternal({ file_contents: "x" })).toBe(true);
    expect(looksExternal({ plan: "one line" })).toBe(true);
    expect(looksExternal({ web_page: "x" })).toBe(true);
    expect(looksExternal({ command_output: "ok" })).toBe(true);
    expect(looksExternal({ candidate_options: "a, b" })).toBe(true);
  });

  it("is true for any long string value", () => {
    expect(looksExternal({ note: "y".repeat(401) })).toBe(true);
    expect(looksExternal({ facts: { detail: "y".repeat(401) } })).toBe(true);
  });

  it("is false for short first-party facts", () => {
    expect(
      looksExternal({
        user_request: "add a --json flag",
        constraints: "no new deps",
        stack: ["node", "typescript"],
      }),
    ).toBe(false);
    expect(looksExternal({})).toBe(false);
    expect(looksExternal({ note: "y".repeat(400) })).toBe(false);
  });
});
