# Design notes

Why the plugin is shaped the way it is, and which platform facts it stands on. Everything
below was verified against Claude Code 2.1.274 (the docs plus the shipped binary), the
TypeSafe docs, and the installed `@typesafe-ai/sdk@0.6.0` — not assumed.

## Why all three mechanisms

The requirement is "consult Jev every time a decision is taken, including in plan mode".

- A **skill** cannot deliver it. The skills documentation says so directly: if a skill stops
  influencing behaviour, "strengthen the skill's description and instructions … **or use hooks
  to enforce behavior deterministically**."
- An **MCP server** cannot deliver it either. It supplies a capability; nothing compels a call.
- **Hooks** are the only deterministic lever, and they fire in plan mode and inside subagents.
  But a hook cannot *answer* anything: it needs a tool to point at.
- A **plugin** is the only container that ships hooks, an MCP server, a skill and `bin/`
  together, and installs once at user scope.

So: server for capability, hooks for enforcement, skill for craft. The plugin is the box.

## Platform contracts this depends on

| Fact | Consequence for the design |
|---|---|
| Plan mode forces `ask` on any MCP tool whose `annotations.readOnlyHint` is not `true` | both tools declare it; without it the plugin would prompt on every decision while planning, which is when it matters most |
| `ExitPlanMode` changes the session mode inside `call()`, which never runs when `PreToolUse` denies | a refusal cannot strand the session out of plan mode |
| `PreToolUse` matches `ExitPlanMode` and `AskUserQuestion`; `tool_input.plan` is injected from the plan file before hooks see it | the plan gate can read the plan text it is judging, with `planFilePath` as the fallback |
| `permissionDecisionReason` is shown **to Claude** on `deny`, and to the user only on `allow`/`ask`; `systemMessage` is user-only | every deny carries the recovery instruction for Claude *and* a one-line explanation for the human, because a denied call renders as a red error |
| A plugin cannot ship `permissions.allow` (plugin `settings.json` supports only `agent` and `subagentStatusLine`) | self-approval is a `PreToolUse` hook on the plugin's own two tools returning `allow` |
| Claude Code sends `_meta["claudecode/toolUseId"]` on every `tools/call` | the server can join its record to the hook's `tool_use_id`; the ledger does not depend on parsing tool output |
| A result carrying `structuredContent` has its text **replaced**; declaring `outputSchema` makes the client throw when it is missing | neither is used. One text block, with a `jev-record:` JSON line last as the hook's fallback parse |
| `isError: true` routes to `PostToolUseFailure`, not `PostToolUse` | "Jev unavailable" is a **non-error** result. `isError` is reserved for input Claude must fix, or the ledger entry would silently vanish |
| Command hooks have no `env` field; `args` is exec form with no shell | the hook name travels as an argv element; `${…}` placeholders never reach a shell parser |
| Any unresolved `${…}` makes a hook command silently resolve to nothing | the plugin references only `${CLAUDE_PLUGIN_ROOT}`, which always exists |
| Hook timeouts are **seconds**; a timed-out `PreToolUse` hook fails open | every network budget is set ~2s under its hook timeout, in one table (`BUDGETS`) with a test asserting the invariant |
| Plugin `SessionEnd` hooks share a 1.5s budget and their `timeout` is ignored | there is no SessionEnd hook; pruning runs at SessionStart, which has a real timeout |
| `SessionStart` matchers include `fork` | the matcher lists it, or forked sessions would be gated without ever receiving the protocol |
| Hook `cloud` defaults to `"skip"` | every hook sets `"cloud": "device"` so enforcement is not silently inert in cloud sessions |
| Hooks run inside subagents and carry `agent_id`/`agent_type`; subagents inherit MCP tools | gates that only make sense on the main thread check `agent_id` and stand down |

Two matcher details worth keeping: matchers made only of `[A-Za-z0-9_|]` are treated as exact
lists rather than regexes, which is why `mcp__plugin_jev_jev__decide|mcp__plugin_jev_jev__check`
matches only those two tools — a broad regex matcher would also match the plugin's own tools
and make the gates recurse.

## SDK traps

Three, each with a test that would catch a regression:

1. `new TypeSafeClient()` **throws** when no key resolves. The server is `alwaysLoad`, so a
   throw at import would mean the tool does not exist at all on a machine without a key. The
   client is built lazily, inside the call, after key resolution. (`mcp.test.ts`: "starts and
   lists tools with no API key configured".)
2. The SDK's default logger writes `debug`/`info` to **stdout** via `console.debug`, and the
   level is read from `TYPESAFE_LOG_LEVEL` in the inherited environment. On a stdio MCP server
   that corrupts the JSON-RPC stream. The server always passes an explicit stderr-only logger.
3. `timeout` is **per attempt** with no total budget: with the defaults (10s, 2 retries,
   0.5–5s backoff) one call can run ~31s, past the per-server timeout. Every call passes a
   total `AbortSignal` deadline *and* a per-attempt timeout derived from it.
   (`jev-client.test.ts`: "gives up at budgetMs rather than at the SDK's per-attempt timeout".)

## Asking Jev well

The TypeSafe docs are specific about what degrades an answer, and several early design choices
had to be corrected against them:

- **One judgment per question.** The `decide` Choice instruction is the caller's question plus
  a single scoping sentence. An earlier draft bundled three judgments and a global "prefer the
  fewest moving parts" tie-break into the preamble — which also installed a permanent favourite
  while the skill was busy demanding neutral options.
- **No `ask_user` option inside the Choice.** Whether a human is needed is a different kind of
  question from which option is best; as an option it competes for probability mass and
  depresses the top probability the policy then reads. It is its own Noul.
- **Atomic questions only.** "Does the plan delete data or rewrite history?" yields one
  unusable number. The plan review asks one condition per question — coverage as a three-level
  Score, one Noul per irreversible kind — and all the AND/OR/threshold logic lives in
  `policy.ts`, where it can be read and tuned.
- **No arithmetic, counting or date comparison.** Compute it in code, put the result in state.
- **No decision history in state.** An earlier draft attached the last ten decisions to every
  request "for consistency". Unrelated material causes documented context rot, and it would
  have made an early wrong choice anchor every later one — invisibly, since the ledger is also
  the audit trail.
- **State is not trusted.** `codebase_facts` routinely carries text the model did not write —
  vendored code, READMEs, fetched pages — and Jev is documented as not hardened against
  content written to steer it. When the state looks like it carries external text, a screening
  Noul rides along, and a hit escalates before any other answer is read.

## The policy, and why these numbers

`src/shared/policy.ts` holds every threshold. Three choices are worth defending:

**Gate on `confidence`, not on the top probability.** The TypeSafe docs define `confidence` and
every worked example thresholds on it (`< 0.5` route to a human, `> 0.9` for consequential
actions). Those numbers do not transfer to `p1`, which depends on how many options there are.
`p1` and `margin` are recorded and used only to detect a near-tie. `JEV_CONF_AXIS` can switch
axes, and the ledger records both so the thresholds can be tuned on real data
(`jev-log --calibration`) rather than on guesses.

**A near-tie is not uncertainty.** Two equally good libraries produce a flat distribution. The
docs are explicit that low confidence on a Choice often means no option is a clear winner —
which is a fact about the options, not a reason to interrupt. When the top two are both real
options and hold most of the mass, the policy proceeds and says so. Without this rule
"Jev decides" would have degenerated into "Jev asks you about every coin flip".

**Declared stakes are a floor, not the value.** `stakes` selects the entire threshold row, and
it is supplied by the agent the policy exists to constrain — while every gate is simultaneously
telling that agent that calling `decide` is what unblocks it. So three reversibility Nouls ride
along in the same request, the stricter of declared and derived applies, and both are recorded.
The end-to-end runs show it working: a decision declared `low` came back `high(declared low)`.

Aggregation is weakest-link (the worst action across the choice, the checks and the scores),
matching the function-calling cookbook's rule that a call is only as good as its least certain
argument.

## Gate design

Every gate is bounded, because a gate that can trap a session is worse than no gate:

- The plan gate refuses at most twice **per plan text**, keyed by a hash of the plan rather
  than by the planning session. An earlier design keyed it to an epoch that only closed on a
  successful `ExitPlanMode` — but a plan the user *rejects* never closes it, so the counter
  would have stayed exhausted and silently disabled the gate for the rest of the session.
- The question router refuses once per identical question set *and* at most once per turn, so
  rephrasing a refused question cannot loop.
- The mutation gate is one-shot by construction: the claim is taken on the turn's first edit,
  so the retry after a refusal always passes.
- The stop backstop blocks at most once per turn, far under the platform's cap of 8.
- Anything unreachable — no key, offline, 429, timeout — falls through. Fail-closed, if ever
  enabled, is decided inside each gate *after* the refusal counter, never in the wrapper via
  exit 2, which has no ceiling and would brick plan approval on an expired key.

The stop backstop deliberately does **not** require that files were edited. The decisions that
escape every other gate are exactly the ones made in prose: a turn that writes via `sed -i`, or
that picks an approach and asks about it in chat without touching a gated tool.

## Coexisting with what is already installed

The `superpowers` plugin injects a skill on every SessionStart whose brainstorming workflow
carries a hard gate: present a design in chat and stop until the human approves. Read naively
against "do not ask the user for anything Jev can settle", that is a direct contradiction, and
the louder text would win. The protocol therefore carries an explicit precedence paragraph:
that approval still happens — Jev decides *which* design is presented, not *whether* it is
presented. The `typesafe@typesafe-ai` skill is documentation about building with the API and
does not overlap; the names are deliberately distinct.

## Spike log

| # | Question | Result |
|---|---|---|
| S3 | Does a plugin `.mcp.json` with `alwaysLoad` put the tools in context under the expected names? | **Pass.** A `-p` run listed `mcp__plugin_jev_jev__decide` and `…__check` without ToolSearch |
| S4 | Does an exported `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` reach the stdio server? | **Pass.** The server reached the fake endpoint with only the inherited environment |
| S2 | Does a `PreToolUse` `allow` self-approve the plugin's own tool? | **Pass.** The call ran in a `-p` session with no permission rule anywhere |
| S6 | Does `_meta["claudecode/toolUseId"]` arrive, and does `PostToolUse` fire for an MCP tool? | **Pass.** Call record written, ledger entry created, handoff files cleaned up |
| S7 | Do subagents get `SubagentStart` context and the MCP tools? | **Pass.** The subagent reported the injected protocol, called the tool, and relayed an OPEN decision upward; the ledger carries `agent_id` and `agent_type` |
| — | Is the protocol actually followed while planning? | **Pass.** A plan-mode run consulted Jev for the plan's fork unprompted and wrote a `## Decisions (Jev)` section |
| S1 | Does `deny` on `ExitPlanMode` keep the session in plan mode and let Claude retry? | **Not verified end to end.** `ExitPlanMode` does not exist in headless `-p` runs (there is no one to approve a plan), so this needs one interactive session — see the checklist printed by `test/e2e/smoke.sh`. The gate's own behaviour is covered by tests, and the binary shows the mode switch happens inside `call()`, which a deny skips |
| S5 | Does `userConfig` work end to end for the API key? | **Deferred.** No working example exists to copy and the env/credentials paths cover the need; revisit if the enable-time prompt is wanted |

## Defects found in review, and what they changed

An adversarial review of the hand-written integration code found 17 defects. All are fixed,
each with a regression test in `test/integration/regressions.test.ts`. Four changed the design
rather than just the code:

- **"Consulted" now means "Claude asked", not "Jev answered".** The plan gate discarded every
  ledger entry whose action was `proceed_unverified` — which is exactly what a call records
  when Jev is unreachable. With no API key, the documented first-run state, Claude would
  consult as instructed, get "unavailable", be refused again, and burn the whole refusal
  budget on every plan and every revision. The gate now separates *attempts* from *verdicts*:
  an attempt that could not reach Jev satisfies the consultation requirement and reports
  "not verified" to the user.
- **`fail: "closed"` was more permissive than the default.** An unreachable Jev records
  `escalate_to_user` under that setting, and both the plan gate and the router read that as a
  real verdict. Entries carrying an `error` code are now ignored by both.
- **The plan window was the whole session.** "Consulted for this plan" was "any main-thread
  decision since the last approved plan", which before the first approval means since the
  session began — so a decision from an unrelated earlier turn satisfied the gate. The epoch
  is now the later of the last approved plan and the start of the current unbroken run of
  plan-mode prompts, and entries must belong to plan mode or to this turn.
- **A 200 the client could not parse read as `proceed`.** If the decision answer was missing
  or named an option that was never offered, `evaluate` fell through with no judgments and
  returned "act on this choice now". Both cases are now a failure and a `revise` respectively.

The rest were narrower: `jev-doctor set-key` crashed with a stack overflow and never stored a
key (`readline.Interface.write()` feeds data back as input rather than writing output); the
ledger-mode router never recorded a gate entry, so a rephrased question could be refused
indefinitely; `readPlan` would read `/dev/zero` until it exhausted memory; the hook drained
only 2 MB of stdin and then destroyed the stream, handing the host an EPIPE; `priorRevisions`
counted a blocking check as a rejected option set; the once-per-project disclosure repeated
every seven days because pruning deleted the pseudo-session holding its claim; `jev-log
--session` with no value printed a different session and exited 0; and the router refusal
could exceed the reason cap and lose its recovery instructions.

## Calibration against the real model

The thresholds were first set from the documentation and then corrected against measured
answers, because two of them were wrong in ways only real data shows.

**`needs_user_preference` was interrupting the user over settled questions.** Asked where a
new Linux CLI should keep its config file — with the state saying every sibling tool in the
repo reads `$XDG_CONFIG_HOME` — Jev answered `xdg_config_home` with probability 1.00 and
confidence 1.00, while the reserved preference question scored 0.71. At the original 0.70 bar
that escalated to the user: a unanimous, obviously correct answer turned into an interruption.
The threshold moved to 0.85, and more importantly the override now yields to a decisive
distribution: if the facts determine the answer that completely, the two signals contradict
each other and the distribution is the better evidence. A genuinely open question still
escalates — asked how long to retain deleted accounts with no policy and no legal review, Jev
answered `none_of_these` at 0.54 with a preference score of 0.92, which is exactly right.

**The high-stakes Noul band made every answer "uncertain".** Requiring 0.90 before calling
something destructive meant a `DROP TABLE` over 1.2M rows, scored 0.79, was recorded as
uncertain and blocked nothing. That band was conflating two different questions: *what is the
answer* and *how sure must we be to act on it*. There is now one verdict band for every
stakes level — yes at 0.65 or above, no at 0.35 or below (`noul` in `policy.ts`) — and the
stakes table alone governs what to do about an answer. The same command now
comes back `revise`, naming `is_destructive` and `touches_shared_or_production` as the
blocking checks — stop, take a backup, re-check.

**The `risky_command` wording was costing probability.** `is_destructive` originally
asked whether the command "delete[s], overwrite[s] or drop[s] data that is not recoverable
from version control" — two judgments in one, and the recoverability clause is nearly always
false for stored data, so it dragged the whole answer down. Measured on the same `DROP TABLE`
over 1.2M rows:

| question | score |
|---|---|
| compound wording, no criteria | 0.89 |
| compound wording plus the generic criteria the plugin attached | 0.81 |
| "Does the command in `command` destroy stored data?" | **0.98** |

Two fixes came out of it. The question is split, with recoverability asked separately (it
answers 0.07, correctly). And criteria are no longer generated when the caller has nothing to
say about the boundary: the old default restated the question ("the condition holds / does not
hold"), which cost 0.08 on the ambiguous question and nothing on the clear one — pure token
cost at best, and a drag at worst. `is_destructive` now scores 0.98. The compound wording scored 0.81-0.89 in the runs above and
0.79 in an earlier one — 0.79 sat only 0.14 above the 0.65 verdict line, and under the old
stakes-indexed band it was not a "yes" at all.

All of these are covered by regression tests, and `jev-log --calibration` reports the
confidence distribution against the actions taken so the numbers can keep being tuned on real
usage rather than on intuition.

### The calibration harness

Measurements used to be ad-hoc scripts whose only trace was a number in a comment. They are
now fixtures: `test/calibration/fixtures/*.json` holds clear-cut labelled cases — for each
question a case where the answer is plainly yes and one where it is plainly no — and
`npm run calibrate` sends every one through the plugin's own request builders and policy to
the live API. It reports each question's gap (lowest yes minus highest no), whether the
threshold that acts on it sits inside that gap, and writes the raw answers to
`test/calibration/results/<model>.json` so a model upgrade is a diff. `npm run test:live`
asserts the same fixtures as a regression suite; it never runs in `npm test`. The model is
not pinned (the API lists only `jev-latest` and `jev-preview`), so the results file records
which version answered.

The first full run (jev-1.13.0, 37 fixtures) found three things the offline suite could not:

- **Plan review saw a third of every real plan.** The state cap of 4000 characters per field
  applied to the plan too, so a 13 KB plan reached Jev as its first 4000 characters. Coverage
  came back 1.6 ("leaves out something") and every decision settled in the later sections read
  as contradicted (0.11, 0.24). With the plan allowed 24000 characters: coverage 1.99,
  consistency with those decisions 0.94.
- **`has_reversal_path` blocked read-only commands.** "Does the state describe a way to put
  things back?" is no for `git status` — there is nothing to put back — so harmless commands
  came back `revise`. Replaced by `unrestorable_change` (blocks on yes): 0.02-0.11 read-only,
  0.94 for an unbacked `DROP TABLE`, 0.33 after a verified dump.
- **The coverage bar was on the wrong side of real plans.** Coverage is an expected level:
  complete plans score 1.85-1.99, a plan doing half the request 1.01, one missing the main
  thing 0.01. The bar moved from 1.95 to 1.5 (and 0.95 to 0.75 for "misses the main thing").

Answers are not bit-for-bit repeatable: a case sitting near a threshold can land on either
side from one run to the next (`rm -rf dist/` with only "gitignored" as context moved across
0.65 between two runs a minute apart). Fixtures therefore assert only clear-cut cases; a
borderline one is kept for its note, with the clear parts asserted.

The Bash gate gathers a few read-only git facts before asking — whether a delete target is
gitignored or tracked, whether the tree is clean, whether the branch was ever pushed —
because the command and Claude's one-line description were not enough: `git reset --hard
HEAD~3` on never-pushed commits scored unrestorable_change 0.46 from those alone, 0.16 with
the facts.

`follows_decision_*` was also reworded. It named the choice by its option id
(`"risky_bash_plus_deps"`), which gave Jev nothing to find in the plan's prose; the ledger now
keeps the chosen option's description and the question asks whether the plan is *consistent*
with it: 0.97 for a plan that follows it, 0.04 for one that contradicts it.

## Second review round

A second adversarial round over the fixed code confirmed 14 of 19 new findings. Four are worth
recording because they were self-contradictions rather than slips:

- **The plan gate refused plans for obeying the protocol.** A decision that came back
  `confirm` or `escalate_to_user` is one the plan is *told* to leave open under a
  "## Decisions needing confirmation" heading. The review then asked Jev whether the plan
  "acts on the decision already taken", got a low answer because the plan correctly left it
  open, and refused — twice, burning the budget. Worse, `revise`/`none_of_these` entries
  produced questions asserting that the decision taken was literally `none_of_these`. Only
  settled verdicts are asserted back now; unsettled ones still count as consultation.
- **The Noul bands moved the wrong way with stakes.** Indexing the verdict band by stakes
  meant raising the stakes widened the uncertain zone, so `is_destructive` at 0.72 blocked at
  medium stakes and did *not* block at high. The band that decides what an answer **means** is
  now a single one; stakes govern only what is done about it, which is what the code's own
  comment had claimed all along.
- **One transient failure waived the gate for the rest of a planning run.** Any errored entry
  anywhere in the epoch satisfied the unreachable fall-through. It is now scoped to the
  current turn.
- **The stakes questions judged the whole user request.** "Deploy to production, and rename
  the helper while you are there" made the rename inherit the deploy's stakes. They are now
  asked about the artefact under judgment — the options for a `decide`, the `command` or
  `plan` for a `check` — and split one condition per question, since a weak lean on any
  disjunct used to promote the whole call. Measurably better: a config-file-location decision
  that derived `medium` now derives `low`.

Also fixed: the question router trusted a failed call as an "ask the human" verdict (the
fail-closed fix had been applied to the plan gate only); a `check` whose checks came back
unanswered returned `ACTION proceed` with "all checks within band"; `jev-log --json` truncated
at the 64 KiB pipe buffer and exited 0; a blocking safety check told Claude to "fix the option
set and call again" when a `check` has no option set; the plan review asked
`adds_unrequested_work` and never read the answer; and the injection screen was missing from
exactly the hook-driven paths where untrusted text arrives.

One finding was in the tests rather than the plugin, and mattered more than most: every hook
test drove the process with `spawnSync`, which blocks the parent's event loop, so the
in-process fake server could never answer and **every hook network path silently timed out
into fail-open**. Those tests passed for the wrong reason. `runAsync` in
`test/integration/regressions.test.ts` is the fixed harness.

## Why the MCP config is not at the repo root

The plugin's server config lives at `config/mcp.json`, declared through
`"mcpServers": "./config/mcp.json"` in the manifest, rather than at the conventional
`.mcp.json`. A file at the repo root is read **twice**: once as the plugin's server config,
where `${CLAUDE_PLUGIN_ROOT}` expands, and once as a *project-scoped* server config, where it
does not. The second reading spawns `node` with an unexpanded path, the process exits
immediately, and every session in this directory reports:

```
Failed to reconnect to jev: CONNECTION_CLOSED
```

The plugin's own server (`plugin:jev:jev`) was connected and working the whole time; the
failure was a phantom duplicate named `jev`. It reproduces with no `--plugin-dir` at all,
which is what identifies it — a plugin that is not loaded cannot fail to connect.

Anyone developing a plugin whose repo is also a working directory should keep its `.mcp.json`
out of the root for this reason.

## Known limits

"Every decision" is enforceable only where a decision becomes observable: a tool call, a plan
being approved, a question to the user, and — in strict mode — the turn's first edit and its
end. Hooks cannot see the model's reasoning. The gates are bounded so they cannot trap a
session, which also means a determined model can exhaust them; the ledger makes that visible.
Jev only ever sees the state Claude wrote, so a lopsided state yields a lopsided answer — hence
the verbatim user request, the option-neutrality check, and reviewing the plan against the
user's own words rather than the plan's summary of them.
