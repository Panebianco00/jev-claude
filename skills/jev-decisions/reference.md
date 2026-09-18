# Worked examples

Three complete calls, with the request as you would write it and the result as Claude sees it.
The numbers are illustrative; the shapes are exact.

---

## A. A library choice (medium stakes, resolved autonomously)

The user asked for request validation on public API routes. Three alternatives are genuinely
viable, so this is a decision.

```json
{
  "decision": "validation-library",
  "question": "Which approach should validate request bodies on the public API routes described in `user_request`?",
  "stakes": "medium",
  "options": [
    { "id": "zod",
      "description": "Schema library with inferred TypeScript types. Adds a ~13 kB runtime dependency. Schemas are declared once and reused for parsing and for types." },
    { "id": "valibot",
      "description": "Schema library with a similar API and a smaller bundle (~3 kB with tree shaking). Younger ecosystem, fewer integrations with existing tooling." },
    { "id": "hand_written_guards",
      "description": "Extend the existing guard functions in the repository. No new dependency; each route needs its own validation code and its own tests." }
  ],
  "state": {
    "user_request": "add request validation to the public API routes",
    "constraints": "TypeScript strict; no new runtime dependency above 50 kB; must produce typed request objects",
    "codebase_facts": "6 route handlers in src/http/routes; hand-written guards already exist in src/http/guards.ts and cover 2 of the 6; zod is already a dev dependency of the test suite",
    "risk": "the routes are public and already serving production traffic"
  },
  "checks": [
    { "id": "breaks_public_api",
      "question": "Would adding validation to the routes described in `user_request` change the responses that existing clients already depend on?",
      "blocking_answer": "yes" },
    { "id": "guards_already_cover_it",
      "question": "Do the guards described in `codebase_facts` already validate every route mentioned in `user_request`?",
      "blocking_answer": "none" }
  ]
}
```

Result:

```
JEV decide[validation-library] -> zod   conf 0.79 - p 0.81 - margin 0.66 - stakes medium - autonomous
ACTION proceed: act on this choice now; do not ask the user about it
why: confident pick
probabilities: zod 0.81 | valibot 0.12 | hand_written_guards 0.04 | none_of_these 0.03
checks: breaks_public_api -> no (0.06) ok | guards_already_cover_it -> no (0.09) ok
```

Note what made this answerable: the constraint that rules out large dependencies, the fact
that zod is already present, and three descriptions of comparable weight — including the one
the model might not have picked for itself.

---

## B. A destructive command (high stakes, sent back for revision, then to the user)

Never run an irreversible command on a `proceed` you assumed. Use `check` with the
`risky_command` preset.

```json
{
  "label": "drop-legacy-sessions-table",
  "stakes": "high",
  "preset": "risky_command",
  "state": {
    "user_request": "clean up the old session storage now that we migrated to JWTs",
    "command": "psql $DATABASE_URL -c 'DROP TABLE legacy_sessions'",
    "context": "legacy_sessions has 1.2M rows; the JWT migration shipped 3 days ago; no backup of this table exists outside the nightly database dump, which is 19 hours old"
  }
}
```

First result:

```
JEV check[drop-legacy-sessions-table]   stakes high - autonomous
ACTION revise: do not carry out the operation as written: a blocking check fired. Change the operation to clear it, or put the finding to the user; only call again once the operation or the state has actually changed
why: blocking checks: is_destructive, touches_shared_or_production, unrestorable_change
checks: is_destructive -> yes (0.98) BLOCKING | unrestorable_change -> yes (0.94) BLOCKING
        touches_shared_or_production -> yes (0.97) BLOCKING | matches_user_request -> yes (0.88) ok
```

The fix is not to re-ask; it is to change the plan. Take a dump of the table first, then
re-check with the same label and a `context` that says so. The second result comes back
`confirm`, because at high stakes a reversible destructive step still needs the user's word:

```
JEV check[drop-legacy-sessions-table]   stakes high - autonomous
ACTION confirm: get the user's confirmation before acting, with Jev's pick listed first
checks: is_destructive -> yes (0.98) | unrestorable_change -> no (0.33) ok
```

---

## C. A fork inside a plan (plan mode)

In plan mode the same call is made, but `confirm` and `escalate_to_user` do not interrupt: they
become an entry in the plan.

```json
{
  "decision": "auth-session-storage",
  "question": "Where should the new admin console keep its session state, given `constraints` and `codebase_facts`?",
  "stakes": "high",
  "options": [
    { "id": "jwt_cookie", "description": "Signed JWT in an httpOnly cookie. No server state; revocation requires a deny list or short expiry." },
    { "id": "server_sessions", "description": "Opaque session id in a cookie with server-side storage. Immediate revocation; adds a shared store the console must reach." },
    { "id": "both", "description": "Short-lived JWT for reads plus a server-side record for revocation. Immediate revocation and fewer lookups; two mechanisms to keep in step." }
  ],
  "state": {
    "user_request": "plan an admin console with login",
    "constraints": "admins must be able to revoke a session immediately; the console runs on one node today",
    "codebase_facts": "no shared cache in the stack; the API already issues JWTs for the public app"
  }
}
```

```
JEV decide[auth-session-storage] -> server_sessions   conf 0.62 - p 0.55 - margin 0.21 - stakes high - autonomous
ACTION confirm: list it under "## Decisions needing confirmation" in the plan; do not call AskUserQuestion
why: moderate confidence (0.62) at high stakes
probabilities: server_sessions 0.55 | both 0.34 | jwt_cookie 0.08 | none_of_these 0.03
```

In the plan:

```markdown
## Decisions (Jev)
- `auth-session-storage` -> server_sessions (0.55, conf 0.62) - needs confirmation
- `admin-route-placement` -> apps/admin (0.88, conf 0.91) - decided

## Decisions needing confirmation
- Session storage: Jev picks server-side sessions (0.55) over a JWT + revocation record (0.34),
  because immediate revocation is a stated requirement and there is no shared cache yet.
```

Then call ExitPlanMode. The gate reviews the plan against the request and checks it is
consistent with each decision above, using the chosen option's description.

---

## D. A decision in the middle of implementing something

Most decisions are not in a plan. They turn up halfway through a task, and they are the ones
that go by unrecorded. Asked to "make the export endpoint stop timing out", you find the
handler builds a 200 MB CSV in memory. Before writing the fix:

```json
{
  "decision": "export-timeout-fix",
  "question": "How should GET /exports/orders.csv stop timing out, given `codebase_facts`?",
  "stakes": "medium",
  "options": [
    { "id": "stream_rows", "description": "Stream rows from a database cursor straight into the response. Same URL and response; memory stays flat." },
    { "id": "background_job", "description": "Generate the file in a background job and email a download link. Changes the endpoint's behaviour for existing callers." },
    { "id": "raise_timeout", "description": "Raise the proxy and handler timeouts to 10 minutes. No code change beyond config; the memory use stays." }
  ],
  "state": {
    "user_request": "make the export endpoint stop timing out",
    "codebase_facts": [
      "src/routes/exports.ts builds the whole CSV in memory before sending it.",
      "The largest export is about 200 MB and 1.1M rows.",
      "The mobile app and two partner integrations call this endpoint and expect the CSV in the response."
    ]
  }
}
```

```
JEV decide[export-timeout-fix] -> stream_rows   conf 0.99 - p 0.99 - margin 0.98 - stakes high(declared medium) - autonomous
ACTION proceed: act on this choice now; do not ask the user about it
why: confident pick
probabilities: stream_rows 0.99 | raise_timeout 0.01 | background_job 0.00 | none_of_these 0.00
```

(Measured on jev-1.13.0. The stakes were raised to high because the options touch an endpoint
partners depend on; at 0.99 the pick clears even the high bar.)

The signal to call was not a planning moment: it was noticing there were three fixes and that
you were about to pick one. The same goes for adding a dependency, placing a new module, or
letting a change grow past the request (`check` with `preset: "scope_check"`).
