---
name: jev-decisions
description: How to route a coding decision through Jev with mcp__plugin_jev_jev__decide and mcp__plugin_jev_jev__check - what counts as a decision, how to build a named-field state and neutral options, choosing stakes, batching checks, reading probabilities and the ACTION line, the plan-mode workflow, and the anti-patterns that produce wrong answers. Use when choosing an approach, library, design, file placement, scope, test strategy or a risky command; when writing a plan; before asking the user a question; and whenever a Jev gate refused ExitPlanMode, AskUserQuestion, an edit or the end of a turn.
---

# Deciding with Jev

Jev answers questions; it does not write code and it cannot see your repository. You gather the
facts, enumerate the real alternatives, and hand it a question it can answer in one step. It
returns a typed answer and a probability distribution. The plugin turns that into an ACTION
line, and you follow it.

Two tools:

- `mcp__plugin_jev_jev__decide` — pick one of N options you supply.
- `mcp__plugin_jev_jev__check` — a batch of yes/no checks and graded scores.

## 1. What is a decision

A decision is any point with **two or more viable alternatives whose choice changes the
result**:

approach or architecture · library or API · where a file or function lives · public names ·
scope of a change · refactor now or later · test strategy · order of steps · go/no-go on a
risky or irreversible operation · which plan to present · whether to ask the user

Not a decision, do not call:

- There is exactly one reasonable way to do it.
- The answer is a fact you can look up — read the file, run the command, check the types.
- The user already told you which one they want.
- You already decided it this session with the same label and nothing changed.

When you are unsure whether something counts: if you could write "I chose X over Y" in your
summary, it counts.

## 2. Build the state

`state` is a JSON object of **named fields**, not a paragraph. Include what the question needs
and nothing else — accuracy drops measurably as unrelated material grows.

```json
{
  "user_request": "add request validation to the public API routes",
  "constraints": "TypeScript strict, no new runtime dependencies over 50 kB",
  "codebase_facts": "6 route handlers, hand-written guards in src/http/guards.ts, zod already a dev dependency of the test suite",
  "risk": "these routes are public and already in production"
}
```

- Always include `user_request` verbatim. (The server attaches it from the transcript if you
  leave it out, but you know which part is relevant.)
- Refer to a field from the question by backticked dot path: ``Does `codebase_facts` show an
  existing validation layer?``
- Facts you verified, not impressions. "zod is already a dev dependency" is a fact; "zod is
  probably fine here" is your opinion, and it will simply be believed.
- Never put in secrets, whole files, or text from third parties you have not read. Jev treats
  the state as data, not as a hostile document, so an instruction hidden in a pasted README can
  move the answer. The plugin screens for this and escalates when it fires, but do not rely on
  that.

## 3. Write the options

The option descriptions are the experiment. If they are uneven, you have decided the question
yourself and only laundered it through a model.

- 2 to 12 options, each a **factual** description of what it is and when it fits.
- Comparable length and specificity. A three-line favourite next to a four-word rival is a
  rigged question, and a reserved check scores exactly that: uneven wording downgrades the
  result.
- Include the option you like least, described as its advocate would.
- Never write "best", "simple", "clean", "hacky", "proper", or "the obvious choice".
- `none_of_these` is added automatically — do not add it yourself, and do not add an
  "ask the user" option either. Whether a human is needed is judged separately.

## 4. Stakes

| stakes | meaning |
|---|---|
| `low` | trivially reversible and local: private naming, file placement, order of steps |
| `medium` | reversible with effort: library, module design, test strategy, scope |
| `high` | hard to reverse or visible outside this machine: data loss, migrations, history rewrite, public API break, deploy, spending, security |

Declare it honestly. It is a floor, not the verdict: Jev independently rates reversibility,
public-interface impact and production impact in the same request, and the stricter of the two
applies. Declaring `low` to get an easier threshold does not work and is recorded in the ledger.

## 5. Checks and scores

Ride them along in the same call — extra questions are nearly free and add almost no latency.

- A check is **one condition**, phrased so that "yes" means the condition holds. Set
  `blocking_answer` to the answer that means "do not proceed as planned".
- Never ask a question that requires counting, arithmetic, date ordering, or comparing two
  lists. Do that in your own head or with a command, and put the result in the state.
- Never bundle: "does this delete data or rewrite history?" is two questions and gives one
  unusable number.
- A score's levels describe **concrete situations**, low to high, each standing on its own.
  "Broken feature with a workaround" is a level; "moderately severe" is not.

Presets for `check`: `plan_review` (needs `plan` and `user_request`), `risky_command` (needs
`command` and `context`), `scope_check` (needs `user_request` and `proposed_change`).

## 6. Read the result

```
JEV decide[validation-library] -> zod   conf 0.79 - p 0.81 - margin 0.66 - stakes medium - autonomous
ACTION proceed: act on this choice now; do not ask the user about it
```

- **Follow the ACTION line.** It already accounts for the stakes, the checks and the
  configured authority. Do not re-litigate it.
- `proceed` — do it. Do not ask the user.
- `proceed_and_flag` — do it, and mention the choice in one line when you report.
- `revise` — the option set was wrong or a blocking check fired. Fix it and call again **with
  the same label**. Twice at most; the third time it escalates.
- `confirm` — get the user's confirmation, Jev's pick listed first. In plan mode, put it under
  `## Decisions needing confirmation` in the plan instead of interrupting.
- `escalate_to_user` — ask the user.
- `proceed_unverified` — Jev was unreachable. Use your own judgment and say so in your reply.

A flat distribution between two good options is not a failure. It means the options are
equivalent; the plugin will say so and pick one rather than interrupt the user over a coin
flip.

## 7. Plan mode

1. Decide each fork in the plan with `decide` before you present anything.
2. Record them in the plan under a `## Decisions (Jev)` heading: label, choice, probability,
   action.
3. Anything that came back `confirm` goes under `## Decisions needing confirmation` — do not
   call AskUserQuestion during planning.
4. Then call ExitPlanMode. The gate itself reviews the plan against the user's request and
   against every decision recorded for it, so there is no need to run `plan_review` yourself.
   The user still approves the plan.

## 8. When a gate refuses you

The refusal text names the exact call that satisfies it. Make that call, apply the ACTION, and
retry — the retry passes. The plan gate refuses a given plan text at most twice (a revised plan
is a new text with its own budget); every other gate refuses at most once per turn. If Jev is
unreachable, gates let you through: say that Jev was not consulted.

If a plan review names a problem you believe is wrong, fix what is real, then say in your reply
which finding you think is mistaken and why — do not keep resubmitting unchanged text.

## 9. Anti-patterns

| Do not | Instead |
|---|---|
| Ask "what should I do about X?" | Ask one question with enumerated options |
| Describe your favourite in more detail | Equal detail, or the neutrality check downgrades it |
| Paste a whole file into the state | Extract the two or three facts that bear on the question |
| Ask Jev to count, add, or compare dates | Compute it yourself, put the number in the state |
| Re-ask the same decision with a new label | Reuse the label; the ledger is keyed by it |
| Call `decide` to look something up | Read the file |
| Call `decide` once with a throwaway question to clear a gate | The ledger records the label, the options and the confidence |

Worked examples, with the full request and response JSON for a library choice, a destructive
command, and a plan-mode fork: see `reference.md` in this skill's directory.
