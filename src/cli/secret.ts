/**
 * Pure keystroke handling for `promptSecret`, separate so it can be tested without a TTY.
 *
 * Escape sequences are consumed whole. Skipping only the ESC byte kept the rest, so an arrow
 * key typed "[A" into the key and a bracketed paste wrapped it in "[200~" … "[201~": a
 * corrupted key, saved silently, that only surfaced later as an auth failure.
 */
export function secretKeys(state: { buf: string; esc: string }, chunk: string): "done" | "interrupt" | "more" {
  for (const ch of chunk) {
    if (state.esc) {
      state.esc += ch;
      // CSI: ESC [ params final-byte(@..~). SS3 (ESC O x, function keys) is three bytes;
      // any other escape is two.
      const csi = state.esc.startsWith("\x1b[");
      const ss3 = state.esc.startsWith("\x1bO");
      const ended = csi
        ? state.esc.length > 2 && ch >= "@" && ch <= "~"
        : state.esc.length >= (ss3 ? 3 : 2);
      if (ended) state.esc = "";
      continue;
    }
    if (ch === "\x1b") {
      state.esc = ch;
      continue;
    }
    if (ch === "\r" || ch === "\n") return "done";
    if (ch === "\x03") return "interrupt"; // ctrl-c
    if (ch === "\x04") return state.buf ? "done" : "interrupt"; // ctrl-d
    if (ch === "\x7f" || ch === "\b") {
      state.buf = state.buf.slice(0, -1);
      continue;
    }
    if (ch >= " ") state.buf += ch;
  }
  return "more";
}
