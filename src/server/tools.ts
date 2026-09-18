/**
 * Tool definitions and the call handler.
 *
 * Two deliberate omissions, both verified against Claude Code 2.1.x:
 *  - no `outputSchema` and no `structuredContent`: a result carrying structured content has
 *    its text replaced by the serialized JSON, and declaring an output schema makes the
 *    client throw when it is missing. The text block IS the interface; its last line carries
 *    a machine-readable record for the PostToolUse hook.
 *  - no `$ref`/`$defs` in the input schemas: nothing documents that they are dereferenced,
 *    so every shape is written out at each use site.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESC_CHECK,
  TOOL_DESC_DECIDE,
  HOOKS_NOT_RUNNING,
} from "../shared/protocol.ts";
import {
  ToolInputError,
  buildCheckRequest,
  buildDecideRequest,
  validateCheckInput,
  validateDecideInput,
} from "../shared/questions.ts";
import { NONE_OF_THESE, RESERVED, evaluate } from "../shared/policy.ts";
import { formatOutcome, formatUnavailable } from "../shared/format.ts";
import { ask } from "../shared/jev-client.ts";
import { BUDGETS, isInteractive, loadConfig, resolveStateDir } from "../shared/config.ts";
import { SessionStore } from "../shared/state-store.ts";
import type {
  CallContext,
  CheckInput,
  Config,
  DecideInput,
  JevFailure,
  Stakes,
} from "../shared/types.ts";

export { SERVER_INSTRUCTIONS };

const CHECK_ITEMS = {
  type: "array",
  maxItems: 8,
  description:
    "Independent yes/no checks answered in the same request, which is nearly free. One condition each.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "question"],
    properties: {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" },
      question: {
        type: "string",
        maxLength: 400,
        description:
          "One yes/no condition, stated literally. Reference state fields by backticked dot path.",
      },
      yes_means: { type: "string", maxLength: 300 },
      no_means: { type: "string", maxLength: 300 },
      blocking_answer: {
        type: "string",
        enum: ["yes", "no", "none"],
        default: "none",
        description: "Which answer means do not proceed as planned. none = informational.",
      },
    },
  },
} as const;

const SCORE_ITEMS = {
  type: "array",
  maxItems: 4,
  description: "Graded judgments along one described dimension each.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "question", "levels"],
    properties: {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" },
      question: { type: "string", maxLength: 400 },
      levels: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        items: { type: "string", maxLength: 300 },
        description:
          "Low to high. Each level describes a concrete situation that stands on its own; never a degree such as 'somewhat severe'.",
      },
      min_level: {
        type: "integer",
        minimum: 0,
        description: "Lowest acceptable level index. Omit for an informational score.",
      },
    },
  },
} as const;

const STAKES_DESC =
  "low: trivially reversible and local (private naming, file placement, step order). medium: reversible with effort (library, module design, test strategy, scope). high: hard to reverse or visible outside this machine (data loss, migrations, history rewrite, public API break, deploy, spending, security). Jev independently rates reversibility and the stricter of the two applies.";

export const TOOLS: Tool[] = [
  {
    name: "decide",
    description: TOOL_DESC_DECIDE,
    annotations: {
      title: "Decide with Jev",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: { "anthropic/alwaysLoad": true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "question", "options", "state", "stakes"],
      properties: {
        decision: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9_-]{1,59}$",
          description:
            "Stable kebab-case label, e.g. validation-library. Reuse the same label when re-consulting after a revise.",
        },
        question: {
          type: "string",
          minLength: 8,
          maxLength: 600,
          description:
            "One direct question whose best answer follows from the state. No embedded recommendation.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          description:
            "The viable alternatives, including the one you like least. none_of_these is added for you.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description"],
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" },
              description: {
                type: "string",
                minLength: 8,
                maxLength: 400,
                description:
                  "What it is and when it fits, factual, comparable in length and specificity to the others. No 'best', 'simple' or 'hacky'.",
              },
            },
          },
        },
        state: {
          type: "object",
          minProperties: 1,
          description:
            "Named verified facts only: user_request (verbatim), constraints, codebase_facts, risk. Reference them from the question by backticked dot path. No secrets, no whole files, no untrusted text.",
        },
        stakes: { type: "string", enum: ["low", "medium", "high"], description: STAKES_DESC },
        checks: CHECK_ITEMS,
        scores: SCORE_ITEMS,
      },
    } as Tool["inputSchema"],
  },
  {
    name: "check",
    description: TOOL_DESC_CHECK,
    annotations: {
      title: "Check with Jev",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: { "anthropic/alwaysLoad": true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label", "state"],
      properties: {
        label: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{1,59}$" },
        state: {
          type: "object",
          minProperties: 1,
          description:
            "Named verified facts. plan_review needs plan and user_request; risky_command needs command and context; scope_check needs user_request and proposed_change.",
        },
        stakes: { type: "string", enum: ["low", "medium", "high"], default: "medium", description: STAKES_DESC },
        preset: {
          type: "string",
          enum: ["plan_review", "risky_command", "scope_check"],
          description: "Merges a standard pack of atomic checks into this call.",
        },
        checks: CHECK_ITEMS,
        scores: SCORE_ITEMS,
      },
    } as Tool["inputSchema"],
  },
];

export type CallResult = CallToolResult;

function errorResult(message: string): CallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The last thing the user actually typed, used as the anti-bias anchor in every request. */
function lastUserRequest(store: SessionStore): string | undefined {
  const prompts = store.prompts();
  return prompts.length ? prompts[prompts.length - 1]?.text : undefined;
}

export async function handleCall(
  name: string,
  rawArgs: unknown,
  toolUseId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CallResult> {
  const cfg: Config = loadConfig({ env });
  const root = resolveStateDir(cfg, env);

  // The context file is written by the PreToolUse hook and is the only way the server
  // learns which session and turn it is serving; _meta gives us the join key.
  const probe = new SessionStore(root, "unknown");
  const ctx: CallContext | undefined = toolUseId ? probe.readCtx(toolUseId) : undefined;
  const store = new SessionStore(root, ctx?.session_id ?? env.CLAUDE_CODE_SESSION_ID ?? "unknown");

  const authority = ctx?.authority ?? cfg.authority;
  const fail = ctx?.fail ?? cfg.fail;
  const formatCtx = {
    plan: ctx?.permission_mode === "plan",
    subagent: Boolean(ctx?.agent_id),
    interactive: ctx?.interactive ?? isInteractive(env),
    authority,
  };

  let input: DecideInput | CheckInput;
  let built;
  const kind: "decide" | "check" = name === "decide" ? "decide" : "check";
  const userRequest = lastUserRequest(store);

  try {
    if (kind === "decide") {
      input = validateDecideInput(rawArgs);
      built = buildDecideRequest(input, { userRequest });
    } else {
      input = validateCheckInput(rawArgs);
      built = buildCheckRequest(input, { userRequest });
    }
  } catch (err) {
    if (err instanceof ToolInputError) return errorResult(`jev ${name}: ${err.message}`);
    throw err;
  }

  const label = kind === "decide" ? (input as DecideInput).decision : (input as CheckInput).label;
  const declaredStakes: Stakes =
    kind === "decide" ? (input as DecideInput).stakes : ((input as CheckInput).stakes ?? "medium");

  const result = await ask({
    questions: built.questions,
    state: built.state,
    budgetMs: cfg.timeoutMs || BUDGETS.server,
    cfg,
    env,
  });

  // With no context file the session is unknown, and an unknown session has no heartbeat to
  // find — which says nothing about whether hooks run. Only a known, silent session does.
  const prefix = store.sessionId === "unknown" || store.isAlive() ? "" : `${HOOKS_NOT_RUNNING}\n`;

  if (!result.ok) {
    const { text, record } = formatUnavailable({ kind, label, failure: result, ctx: formatCtx, fail });
    if (toolUseId) store.writeCall(toolUseId, record);
    return { content: [{ type: "text", text: prefix + text }] };
  }

  // A 200 that does not carry the answers we asked for is a failure, not a verdict. Without
  // this it would fall through the policy with no judgments at all and come back "proceed" —
  // telling Claude a destructive command was cleared when nothing was ever evaluated.
  const requested = built.checks.length + built.scores.length;
  const answered =
    built.checks.filter((c) => result.nouls[`check_${c.id}`] !== undefined).length +
    built.scores.filter((s) => result.scores[`score_${s.id}`] !== undefined).length;
  const missingJudgments = requested > 0 && answered === 0;

  if ((kind === "decide" && !result.choices[RESERVED.decision]) || missingJudgments) {
    const failure: JevFailure = {
      ok: false,
      code: "server",
      message: "the response did not contain a usable decision answer",
      userFixable: false,
    };
    const { text, record } = formatUnavailable({ kind, label, failure, ctx: formatCtx, fail });
    if (toolUseId) store.writeCall(toolUseId, record);
    return { content: [{ type: "text", text: prefix + text }] };
  }

  // Only a rejection of the option set counts as a prior revision: a blocking check also
  // yields "revise", and counting those would escalate the first genuine none_of_these.
  const priorRevisions = store
    .ledger()
    .filter((e) => e.label === label && e.kind === "decide" && !e.agent_id && e.choice === NONE_OF_THESE)
    .length;

  const outcome = evaluate({
    result,
    declaredStakes,
    realOptionIds: kind === "decide" ? built.realOptionIds : undefined,
    checks: built.checks,
    scores: built.scores,
    cfg: { ...cfg, authority },
    priorRevisions,
  });

  const { text, record } = formatOutcome({
    kind,
    label,
    outcome,
    ctx: formatCtx,
    ms: result.ms,
    model: result.model,
  });

  // The plan gate later asks whether a plan acts on this decision. An option id alone
  // ("risky_bash_plus_deps") gives Jev nothing to match against the plan's prose, and it
  // answered 0.24 on a plan that did exactly that; the description is what the plan echoes.
  // Both go to the ledger only, never into the text Claude reads: the text already prints the
  // rationale, and the record line there has a fixed size budget.
  if (outcome.action !== "proceed" && outcome.rationale) record.why = outcome.rationale.slice(0, 200);
  if (kind === "decide" && outcome.choice !== undefined) {
    const chosen = (input as DecideInput).options.find((o) => o.id === outcome.choice);
    if (chosen) record.choice_text = chosen.description.slice(0, 300);
  }

  if (toolUseId) {
    store.writeCall(toolUseId, {
      ...record,
      session_id: ctx?.session_id,
      prompt_id: ctx?.prompt_id,
      agent_id: ctx?.agent_id,
      truncated_fields: built.truncated,
    });
  }

  return { content: [{ type: "text", text: prefix + text }] };
}
