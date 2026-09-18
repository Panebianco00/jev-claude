import { resolveApiKey } from "../shared/config.ts";
import { DISCLOSURE, noKeyWarning, sessionProtocol } from "../shared/protocol.ts";
import { SessionStore } from "../shared/state-store.ts";
import type { HookOutput } from "../shared/types.ts";
import type { HookCtx } from "./main.ts";

/** Claims that outlive a single session live under this pseudo-session. */
const GLOBAL = "_global";

/**
 * Injects the decision protocol and does all of the plugin's housekeeping.
 *
 * Pruning lives here rather than in a SessionEnd hook because plugin SessionEnd hooks share a
 * 1.5 second budget and their configured timeout is ignored, so cleanup there would be
 * cancelled halfway through and state would grow without bound.
 */
export function sessionStart({ input, cfg, store, env }: HookCtx): HookOutput | undefined {
  store.ensureDirs();
  store.markAlive();
  const global = new SessionStore(store.root, GLOBAL);
  global.ensureDirs();
  store.prune({ retainDays: cfg.retainDays, keepSessionId: store.sessionId });

  const out: HookOutput = {};
  const { key } = resolveApiKey(cfg, env);

  if (cfg.enforcement !== "off") {
    out.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext: sessionProtocol(cfg, Boolean(key)),
    };
  }

  const messages: string[] = [];
  if (!key) messages.push(noKeyWarning());
  // Sending code context to a third party is the user's call to make knowingly, so say it
  // once per project rather than never or every session.
  if (cfg.enforcement !== "off" && global.claim("disclosed", input.cwd ?? "global")) {
    messages.push(DISCLOSURE);
  }
  if (messages.length) out.systemMessage = messages.join(" ");

  return out;
}
