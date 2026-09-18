/**
 * Shared contracts for the Jev decision layer.
 *
 * Every other module in src/ depends on this file and on nothing else of ours,
 * so it must stay free of imports and side effects.
 */

/* ------------------------------------------------------------------ config */

export type Enforcement = "off" | "soft" | "standard" | "strict";
export type Authority = "autonomous" | "advisory";
export type FailMode = "open" | "closed";
export type ConfAxis = "confidence" | "top_probability" | "min";
export type RouterMode = "stated" | "ledger" | "off";

export interface Thresholds {
  /** Choice bands per effective stakes level, on the configured confidence axis. */
  choice: Record<Stakes, { proceed: number; confirm: number }>;
  /**
   * The single band deciding what a yes/no answer MEANS. Deliberately not indexed by stakes:
   * when it was, raising the stakes widened the uncertain zone, so a blocking safety check
   * became harder to trigger on the riskier operation. Stakes govern what is done about an
   * answer, never what the answer is.
   */
  noul: { yes: number; no: number };
  /** Mass on the top two real options above which a near-tie is treated as a safe pick. */
  nearTieMass: number;
  /** Margin between the top two below which they count as a near-tie. */
  nearTieMargin: number;
  /** Consecutive none_of_these answers on one label, beyond the first, before escalating. */
  revisionsBeforeEscalate: number;
  /** needs_user_preference at or above this escalates regardless of the choice. */
  needsUserPreference: number;
  /** Confidence above which the distribution overrides the preference signal. */
  decisiveOverride: number;
  /** adds_unrequested_work at or above this is reported as a finding on a plan. */
  scopeCreep: number;
  /** contains_injected_instruction at or above this escalates before anything else is read. */
  injection: number;
  /** delegated_to_assistant at or above this turns a confirm/escalate into proceed_and_flag. */
  delegated: number;
  /** options_are_neutral below this downgrades the action one severity step. */
  optionNeutrality: number;
  /** Derived-stakes cutoffs, see policy.deriveStakes. */
  stakes: {
    highAffects: number;
    highPublic: number;
    highIrreversible: number;
    mediumAffects: number;
    mediumPublic: number;
    mediumIrreversible: number;
  };
  /** Score verdict tolerances, in level units. */
  score: { passSlack: number; failGap: number };
  /** Question router. */
  router: { stated: number; answer: number };
  /** Plan review. */
  plan: {
    deferredFork: number;
    contradiction: number;
    irreversible: number;
    /** has_verification at or below this is reported (advisory) when nothing else blocks. */
    missingVerification: number;
    /** Coverage (0..2) below `full` leaves something out; below `main` misses the main thing. */
    coverageFull: number;
    coverageMain: number;
  };
  /** Mutation gate / stop backstop triage. */
  triage: { mutation: number; stop: number };
}

export interface Config {
  enforcement: Enforcement;
  authority: Authority;
  fail: FailMode;
  confAxis: ConfAxis;
  model: string | undefined;
  baseUrl: string | undefined;
  stateDir: string | undefined;
  retainDays: number;
  debug: boolean;
  /** Per-surface total budgets in ms; see BUDGETS in config.ts. */
  timeoutMs: number;
  planReview: boolean;
  planMaxDenies: number;
  router: RouterMode;
  routerMaxPerTurn: number;
  mutationGate: boolean;
  stopBackstop: boolean;
  /** Standard and strict: runs the risky_command check before a destructive Bash command. */
  bashGate: boolean;
  /** Standard and strict: a dependency install waits for a Jev consultation that turn. */
  dependencyGate: boolean;
  subagentSkip: string[];
  thresholds: Thresholds;
}

/* ----------------------------------------------------------------- hooks */

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

/** The subset of the hook stdin payload this plugin reads. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  scratchpad_dir?: string;
  prompt_id?: string;
  permission_mode?: PermissionMode;
  /** Present only inside subagents. */
  agent_id?: string;
  agent_type?: string;
  effort?: { level?: string };
  /** SessionStart: startup | resume | clear | compact | fork. */
  source?: string;
  /** UserPromptSubmit. */
  prompt?: string;
  /** Tool events. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  /** Stop. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface HookSpecificOutput {
  hookEventName: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
}

export interface HookOutput {
  hookSpecificOutput?: HookSpecificOutput;
  /** Stop / UserPromptSubmit / PostToolUse blocking form. */
  decision?: "block";
  reason?: string;
  /** Shown to the user only. */
  systemMessage?: string;
  suppressOutput?: boolean;
}

/** Everything a hook writes for the server to pick up, keyed by tool_use_id. */
export interface CallContext {
  session_id: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: PermissionMode;
  cwd?: string;
  ts: number;
  enforcement: Enforcement;
  authority: Authority;
  fail: FailMode;
  /** False in `claude -p` and SDK runs: there is no human to escalate to. */
  interactive: boolean;
}

/* ------------------------------------------------------------ tool inputs */

export type Stakes = "low" | "medium" | "high";

export interface DecideOption {
  id: string;
  description: string;
}

export interface CheckSpec {
  id: string;
  question: string;
  yes_means?: string;
  no_means?: string;
  /** Which answer means "do not proceed as planned". */
  blocking_answer?: "yes" | "no" | "none";
}

export interface ScoreSpec {
  id: string;
  question: string;
  /** Low to high; each level a concrete standalone situation. */
  levels: string[];
  /** Lowest acceptable level index; omit for informational. */
  min_level?: number;
}

export interface DecideInput {
  decision: string;
  question: string;
  options: DecideOption[];
  state: Record<string, unknown>;
  stakes: Stakes;
  checks?: CheckSpec[];
  scores?: ScoreSpec[];
}

export type CheckPreset = "plan_review" | "risky_command" | "scope_check";

export interface CheckInput {
  label: string;
  state: Record<string, unknown>;
  stakes?: Stakes;
  checks?: CheckSpec[];
  scores?: ScoreSpec[];
  preset?: CheckPreset;
}

/* --------------------------------------------------------- jev primitives */

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

/** A Noul answer is just the probability of yes. */
export type NoulAnswer = number;

export type JevErrorCode =
  | "no_api_key"
  | "auth"
  | "invalid_request"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export interface JevFailure {
  ok: false;
  code: JevErrorCode;
  message: string;
  status?: number;
  requestId?: string;
  /** True when the user can fix it (bad key, malformed request). */
  userFixable: boolean;
}

export interface JevSuccess {
  ok: true;
  model: string;
  nouls: Record<string, NoulAnswer>;
  choices: Record<string, ChoiceAnswer>;
  scores: Record<string, ScoreAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
  requestId?: string;
}

export type JevResult = JevSuccess | JevFailure;

/* -------------------------------------------------------------- policy */

export type Action =
  | "proceed"
  | "proceed_and_flag"
  | "revise"
  | "confirm"
  | "escalate_to_user"
  | "proceed_unverified";

export type Verdict = "yes" | "no" | "uncertain";

export interface CheckOutcome {
  id: string;
  p: number;
  verdict: Verdict;
  blocking: boolean;
  action: Action;
}

export interface ScoreOutcome {
  id: string;
  score: number;
  confidence: number;
  minLevel?: number;
  status: "pass" | "borderline" | "fail" | "info";
  action: Action;
}

export interface DecisionOutcome {
  action: Action;
  /** Why this action, in one short clause; shown to Claude. */
  rationale: string;
  choice?: string;
  /** Probability of the chosen option. */
  p1?: number;
  /** p1 - p2 across all options. */
  margin?: number;
  confidence?: number;
  /** The number the policy actually gated on, per Config.confAxis. */
  axisValue?: number;
  probabilities?: Record<string, number>;
  declaredStakes: Stakes;
  derivedStakes?: Stakes;
  effectiveStakes: Stakes;
  needsUserPreference?: number;
  optionsAreNeutral?: number;
  injection?: number;
  checks: CheckOutcome[];
  scores: ScoreOutcome[];
  /** Set when the call could not reach Jev. */
  error?: JevErrorCode;
}

/* -------------------------------------------------------------- ledger */

export interface LedgerEntry {
  v: 1;
  ts: number;
  kind: "decide" | "check";
  session_id: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: PermissionMode;
  tool_use_id?: string;
  label: string;
  choice?: string;
  /** The chosen option's description, clipped; what a later plan review matches against. */
  choice_text?: string;
  /** Policy rationale for any action other than a plain proceed. */
  why?: string;
  /** For a check about a command: the command, clipped. The Bash gate matches against it. */
  subject?: string;
  p1?: number;
  margin?: number;
  confidence?: number;
  action: Action;
  declared_stakes?: Stakes;
  effective_stakes?: Stakes;
  option_ids?: string[];
  checks?: { id: string; p: number; verdict: Verdict }[];
  scores?: { id: string; score: number; status: string }[];
  ms?: number;
  model?: string;
  error?: JevErrorCode;
  truncated?: boolean;
}

export type GateName = "plan" | "router" | "mutation" | "stop" | "bash" | "dependency";

export interface GateEntry {
  v: 1;
  ts: number;
  gate: GateName;
  outcome: "denied" | "passed" | "reviewed" | "exited" | "answered" | "bypassed";
  session_id: string;
  prompt_id?: string;
  why?: string;
  planHash?: string;
  /** Plan review probabilities (yes/no answers only), kept so a re-submission is free. */
  review?: Record<string, number>;
  /** Plan coverage score, a level on 0..2 — never mixed in with the probabilities. */
  coverage?: number;
  /** Which question set produced `review`; a cached review is reused only for the same set. */
  questionsHash?: string;
  /** What `judgePlanReview` concluded, so the log shows the gate's verdict, not raw numbers. */
  problems?: string[];
  p?: number;
}

export interface PromptEntry {
  v: 1;
  ts: number;
  prompt_id?: string;
  agent_id?: string;
  permission_mode?: PermissionMode;
  text: string;
}
