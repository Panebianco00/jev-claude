import { describe, expect, it } from "vitest";
import { secretKeys } from "../../src/cli/secret.ts";

function type(...chunks: string[]): { result: string; buf: string } {
  const state = { buf: "", esc: "" };
  let result = "more";
  for (const c of chunks) {
    result = secretKeys(state, c);
    if (result !== "more") break;
  }
  return { result, buf: state.buf };
}

describe("secretKeys", () => {
  it("collects printable characters until enter", () => {
    expect(type("sk-abc", "123\r")).toEqual({ result: "done", buf: "sk-abc123" });
  });

  it("handles backspace and DEL", () => {
    expect(type("abcd\x7f\x7f\bx\n")).toEqual({ result: "done", buf: "ax" });
  });

  it("drops whole escape sequences instead of keeping their tails", () => {
    // Regression: only ESC was skipped, so an arrow key added "[A" to the key.
    expect(type("ab\x1b[Ac\x1b[3~d\x1bOPe\r").buf).toBe("abcde");
  });

  it("strips bracketed-paste markers around a pasted key", () => {
    expect(type("\x1b[200~sk-pasted\x1b[201~", "\r")).toEqual({ result: "done", buf: "sk-pasted" });
  });

  it("an escape sequence split across chunks is still consumed whole", () => {
    expect(type("a\x1b", "[", "D", "b\r").buf).toBe("ab");
  });

  it("ctrl-c interrupts, ctrl-d ends input or interrupts when empty", () => {
    expect(type("abc\x03").result).toBe("interrupt");
    expect(type("abc\x04")).toEqual({ result: "done", buf: "abc" });
    expect(type("\x04").result).toBe("interrupt");
  });
});
