#!/usr/bin/env node
/**
 * Single entrypoint for every hook; the hook name arrives as argv[2].
 *
 * The contract with Claude Code is unforgiving in one direction and forgiving in the other:
 * malformed output is ignored, but an exception or a hang is a broken session. So every path
 * here ends in exit 0 with either one JSON object or nothing at all. A gate that cannot reach
 * Jev lets the tool call through; enforcement is worth nothing if it can brick the session.
 */
import { loadConfig, resolveStateDir } from "../shared/config.ts";
import { SessionStore } from "../shared/state-store.ts";
import type { Config, HookInput, HookOutput } from "../shared/types.ts";
import { sessionStart } from "./session-start.ts";
import { subagentStart } from "./subagent-start.ts";
import { userPromptSubmit } from "./user-prompt-submit.ts";
import { postJevTool, preJevTool } from "./jev-tool.ts";
import { planEntered, planExited, planGate } from "./plan-gate.ts";
import { bashGate } from "./bash-gate.ts";
import { questionRouter } from "./question-router.ts";
import { mutationGate } from "./mutation-gate.ts";
import { stopBackstop } from "./stop-backstop.ts";

export interface HookCtx {
  input: HookInput;
  cfg: Config;
  store: SessionStore;
  env: NodeJS.ProcessEnv;
}

type Handler = (ctx: HookCtx) => HookOutput | undefined | Promise<HookOutput | undefined>;

const HANDLERS: Record<string, Handler> = {
  "session-start": sessionStart,
  "subagent-start": subagentStart,
  "user-prompt-submit": userPromptSubmit,
  "pre-jev-tool": preJevTool,
  "post-jev-tool": postJevTool,
  "plan-gate": planGate,
  "plan-exited": planExited,
  "plan-entered": planEntered,
  "bash-gate": bashGate,
  "question-router": questionRouter,
  "mutation-gate": mutationGate,
  "stop-backstop": stopBackstop,
};

const MAX_STDIN = 8_000_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let kept = 0;
  // The stream is drained to the end even past the cap: breaking out destroys stdin while
  // the host is still writing, which hands it an EPIPE.
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (kept + buf.length <= MAX_STDIN) {
      chunks.push(buf);
      kept += buf.length;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "";
  const handler = HANDLERS[name];
  if (!handler) return;

  const raw = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return; // not our payload; say nothing
  }

  const env = process.env;
  const cfg = loadConfig({ cwd: input.cwd, env });
  const store = new SessionStore(resolveStateDir(cfg, env), input.session_id ?? "unknown");

  let output: HookOutput | undefined;
  try {
    output = await handler({ input, cfg, store, env });
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (cfg.debug) store.debugLog(`[${name}] ${message}`);
    return; // fail open
  }

  if (output && Object.keys(output).length > 0) {
    process.stdout.write(JSON.stringify(output));
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(0),
);
