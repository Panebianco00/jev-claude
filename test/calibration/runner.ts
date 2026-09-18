/**
 * Runs labelled fixtures through the plugin's real request path against the live API.
 *
 * Shared by `scripts/calibrate.ts` (tuning: how well does each question separate its yes
 * cases from its no cases, and where do the thresholds sit?) and `test/live/` (regression:
 * does every fixture still land where it should?). Nothing here talks to the fake server.
 *
 * A fixture names the raw question ids it has an opinion about, exactly as they appear in
 * the request: `check_is_destructive` for a caller check, `defers_a_choice` for plan review,
 * `stated_0` for the router. Only clear-cut cases belong here; a fixture a careful human
 * would hesitate on measures the fixture, not the model.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../src/shared/jev-client.ts";
import { evaluate, judgePlanReview, RESERVED } from "../../src/shared/policy.ts";
import {
  PLAN_IDS,
  ROUTER_CHOICE_ID,
  buildCheckRequest,
  buildDecideRequest,
  buildPlanReviewRequest,
  buildRouterRequest,
  buildTriageRequest,
  routerOptionKeys,
  validateCheckInput,
  validateDecideInput,
  type BuiltRequest,
} from "../../src/shared/questions.ts";
import type { Action, Config, Thresholds } from "../../src/shared/types.ts";

export type FixtureKind = "decide" | "check" | "plan" | "router" | "triage";

export interface Fixture {
  name: string;
  kind: FixtureKind;
  /** Why this case exists: what it pins down, and where the numbers came from. */
  note?: string;
  /** The tool input (decide/check), or the builder arguments (plan/router/triage). */
  input: Record<string, unknown>;
  /** The user's words, for decide/check; plan/router/triage carry it in `input`. */
  user_request?: string;
  expect: {
    yes?: string[];
    no?: string[];
    /** Choice question id -> expected option id (router: the option label). */
    choice?: Record<string, string>;
    /** The policy's action (decide/check), or "blocked"/"cleared" for a plan. */
    action?: string | string[];
    coverage?: [number, number];
  };
}

export interface Observation {
  fixture: Fixture;
  ok: boolean;
  error?: string;
  model?: string;
  nouls: Record<string, number>;
  choices: Record<string, { choice: string; confidence: number }>;
  coverage?: number;
  action?: string;
  problems?: string[];
  failures: string[];
}

const HERE = import.meta.dirname;

export function loadFixtures(dir = join(HERE, "fixtures")): Fixture[] {
  const out: Fixture[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const list = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture[];
    for (const f of list) out.push({ ...f, name: `${file.replace(/\.json$/, "")}/${f.name}` });
  }
  return out;
}

function build(f: Fixture): BuiltRequest {
  const i = f.input;
  switch (f.kind) {
    case "decide":
      return buildDecideRequest(validateDecideInput(i), { userRequest: f.user_request });
    case "check":
      return buildCheckRequest(validateCheckInput(i), { userRequest: f.user_request });
    case "plan":
      return buildPlanReviewRequest(i as Parameters<typeof buildPlanReviewRequest>[0]);
    case "router":
      return buildRouterRequest(i as Parameters<typeof buildRouterRequest>[0]);
    case "triage":
      return buildTriageRequest(i as Parameters<typeof buildTriageRequest>[0]);
  }
}

/** Router fixtures name the expected answer by label; the wire uses derived keys. */
function expectedChoice(f: Fixture, id: string, want: string): string {
  if (f.kind !== "router") return want;
  const q = (f.input["questions"] as { options: { label: string }[] }[])[Number(id.split("_").pop())];
  if (!q) return want;
  const labels = q.options.map((o) => o.label);
  const at = labels.indexOf(want);
  return at === -1 ? want : (routerOptionKeys(labels)[at] ?? want);
}

export async function runFixture(f: Fixture, cfg: Config): Promise<Observation> {
  const obs: Observation = { fixture: f, ok: false, nouls: {}, choices: {}, failures: [] };
  let built: BuiltRequest;
  try {
    built = build(f);
  } catch (err) {
    obs.error = `fixture does not build: ${err instanceof Error ? err.message : String(err)}`;
    obs.failures.push(obs.error);
    return obs;
  }

  const result = await ask({ questions: built.questions as never, state: built.state, budgetMs: 30_000, maxRetries: 2, cfg });
  if (!result.ok) {
    obs.error = `${result.code}: ${result.message}`;
    obs.failures.push(obs.error);
    return obs;
  }
  obs.ok = true;
  obs.model = result.model;
  obs.nouls = result.nouls;
  for (const [id, c] of Object.entries(result.choices)) obs.choices[id] = { choice: c.choice, confidence: c.confidence };

  if (f.kind === "decide" || f.kind === "check") {
    const input = f.input as { stakes?: "low" | "medium" | "high" };
    obs.action = evaluate({
      result,
      declaredStakes: input.stakes ?? "medium",
      realOptionIds: f.kind === "decide" ? built.realOptionIds : undefined,
      checks: built.checks,
      scores: built.scores,
      cfg,
    }).action;
  } else if (f.kind === "plan") {
    obs.coverage = result.scores[PLAN_IDS.coverage]?.score;
    const j = judgePlanReview(result.nouls, obs.coverage, cfg.thresholds);
    obs.problems = j.problems;
    obs.action = j.blocking ? "blocked" : "cleared";
  }

  // Grading is against 0.5, the model's own "more likely than not", not the gate thresholds:
  // a fixture asserts what the answer IS. Whether the threshold sits in the right place is
  // what `separation()` reports.
  const e = f.expect;
  for (const id of e.yes ?? []) {
    const p = obs.nouls[id];
    if (p === undefined) obs.failures.push(`${id}: not asked`);
    else if (p < 0.5) obs.failures.push(`${id}: expected yes, got ${p.toFixed(2)}`);
  }
  for (const id of e.no ?? []) {
    const p = obs.nouls[id];
    if (p === undefined) obs.failures.push(`${id}: not asked`);
    else if (p >= 0.5) obs.failures.push(`${id}: expected no, got ${p.toFixed(2)}`);
  }
  for (const [id, want] of Object.entries(e.choice ?? {})) {
    const got = obs.choices[id]?.choice;
    const key = expectedChoice(f, id, want);
    if (got !== key) obs.failures.push(`${id}: expected ${key}, got ${got ?? "nothing"}`);
  }
  if (e.action !== undefined) {
    const allowed = Array.isArray(e.action) ? e.action : [e.action];
    if (!obs.action || !allowed.includes(obs.action)) {
      obs.failures.push(`action: expected ${allowed.join("|")}, got ${obs.action ?? "nothing"}${obs.problems?.length ? ` (${obs.problems.join("; ")})` : ""}`);
    }
  }
  if (e.coverage && obs.coverage !== undefined) {
    const [lo, hi] = e.coverage;
    if (obs.coverage < lo || obs.coverage > hi) {
      obs.failures.push(`coverage: expected ${lo}..${hi}, got ${obs.coverage.toFixed(2)}`);
    }
  }
  return obs;
}

/* ---------------------------------------------------------- separation */

/**
 * The threshold that acts on each question, and on which side of it "yes" lies. A question
 * the policy reads as "block when LOW" (follows_decision, has_verification) has `high: false`.
 */
export function governingThreshold(id: string, t: Thresholds): { value: number; path: string } | undefined {
  if (id.startsWith("follows_decision_")) return { value: 1 - t.plan.contradiction, path: "1 - plan.contradiction" };
  if (id.startsWith("stated_")) return { value: t.router.stated, path: "router.stated" };
  if (id.startsWith("check_")) return { value: t.noul.yes, path: "noul.yes" };
  const table: Record<string, [number, string]> = {
    [RESERVED.injection]: [t.injection, "injection"],
    [RESERVED.needsUserPreference]: [t.needsUserPreference, "needsUserPreference"],
    [RESERVED.optionsAreNeutral]: [t.optionNeutrality, "optionNeutrality"],
    [RESERVED.reversibleLocally]: [t.stakes.mediumIrreversible, "stakes.mediumIrreversible"],
    [RESERVED.changesPublicInterface]: [t.stakes.mediumPublic, "stakes.mediumPublic"],
    [RESERVED.changesStoredData]: [t.stakes.mediumPublic, "stakes.mediumPublic"],
    [RESERVED.affectsProduction]: [t.stakes.mediumAffects, "stakes.mediumAffects"],
    [RESERVED.spendsMoney]: [t.stakes.mediumAffects, "stakes.mediumAffects"],
    [RESERVED.sendsOutside]: [t.stakes.mediumAffects, "stakes.mediumAffects"],
    defers_a_choice: [t.plan.deferredFork, "plan.deferredFork"],
    adds_unrequested_work: [t.scopeCreep, "scopeCreep"],
    has_verification: [t.plan.missingVerification, "plan.missingVerification"],
    deletes_data: [t.plan.irreversible, "plan.irreversible"],
    rewrites_history: [t.plan.irreversible, "plan.irreversible"],
    deploys_or_spends: [t.plan.irreversible, "plan.irreversible"],
    requires_choosing_an_approach: [t.triage.mutation, "triage.mutation"],
    message_describes_a_choice: [t.triage.stop, "triage.stop"],
  };
  const hit = table[id];
  return hit ? { value: hit[0], path: hit[1] } : undefined;
}

export interface Separation {
  id: string;
  yes: number[];
  no: number[];
  /** Lowest yes minus highest no; positive means a threshold can separate them. */
  gap: number | undefined;
  threshold?: { value: number; path: string };
  /** Whether the current threshold sits strictly between the highest no and the lowest yes. */
  thresholdSeparates?: boolean;
}

/** Per-question spread across every fixture that asserted it. Question ids are grouped by prefix-free name. */
export function separation(observations: Observation[], t: Thresholds): Separation[] {
  const by = new Map<string, { yes: number[]; no: number[] }>();
  const norm = (id: string): string => (id.startsWith("follows_decision_") ? "follows_decision_*" : id.startsWith("stated_") ? "stated_*" : id);
  for (const o of observations) {
    if (!o.ok) continue;
    for (const [side, ids] of [["yes", o.fixture.expect.yes ?? []], ["no", o.fixture.expect.no ?? []]] as const) {
      for (const id of ids) {
        const p = o.nouls[id];
        if (p === undefined) continue;
        const k = norm(id);
        const entry = by.get(k) ?? { yes: [], no: [] };
        entry[side].push(p);
        by.set(k, entry);
      }
    }
  }
  return [...by.entries()]
    .map(([id, { yes, no }]) => {
      const gap = yes.length && no.length ? Math.min(...yes) - Math.max(...no) : undefined;
      const threshold = governingThreshold(id.replace("*", "0"), t);
      const s: Separation = { id, yes, no, gap };
      if (threshold) {
        s.threshold = threshold;
        const okYes = yes.every((p) => p >= threshold.value);
        const okNo = no.every((p) => p < threshold.value);
        s.thresholdSeparates = okYes && okNo;
      }
      return s;
    })
    .sort((a, b) => (a.gap ?? 9) - (b.gap ?? 9));
}

export type { Action };
