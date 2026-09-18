#!/usr/bin/env bash
# End-to-end smoke test against a real Claude Code session and a fake TypeSafe endpoint.
#
# It costs real model tokens, so it is not part of `npm test`. Run it after changing the
# manifests, the hook registrations, the MCP wiring or the protocol text - the parts unit
# tests cannot reach.
#
#   test/e2e/smoke.sh
#
# With a real key, export TYPESAFE_API_KEY and JEV_E2E_REAL=1 to skip the fake server.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$(mktemp -d)"
FAKE_PID=""
FAILURES=0

cleanup() {
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
  rm -rf "$STATE_DIR" "$ROOT/.e2e-fake.mjs"
}
trap cleanup EXIT

check() { # check <name> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n       expected to find: %s\n' "$1" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}

cd "$ROOT"
echo "building"
node scripts/build.mjs >/dev/null || exit 1
claude plugin validate . --strict || exit 1

if [ "${JEV_E2E_REAL:-0}" != "1" ]; then
  npx esbuild test/fake-typesafe/run.ts --bundle --platform=node --format=esm \
    --target=node20 --outfile="$ROOT/.e2e-fake.mjs" --log-level=error || exit 1
  node "$ROOT/.e2e-fake.mjs" > "$STATE_DIR/url" 2>/dev/null &
  FAKE_PID=$!
  sleep 2
  export TYPESAFE_BASE_URL="$(cat "$STATE_DIR/url")"
  export TYPESAFE_API_KEY=fake-key
  echo "fake TypeSafe at $TYPESAFE_BASE_URL"
fi
export JEV_STATE_DIR="$STATE_DIR"

run() { # run <prompt> [extra claude args...]
  local prompt="$1"; shift
  timeout 420 claude --plugin-dir "$ROOT" "$@" -p "$prompt" --output-format json 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("result") or "")'
}

echo
echo "S3: both tools load without tool search"
OUT="$(run 'List the tool names you have that start with mcp__plugin_jev. Do not call them. Names only.')"
check "decide is present" "$OUT" "mcp__plugin_jev_jev__decide"
check "check is present" "$OUT" "mcp__plugin_jev_jev__check"

echo
echo "S2/S4/S6: a decision runs, self-approves, and reaches the ledger"
OUT="$(run 'Call mcp__plugin_jev_jev__decide with decision "log-format", question "Which log format should this CLI use?", stakes "low", options [{"id":"json_lines","description":"One JSON object per line; machine readable, needs a viewer to read by eye."},{"id":"plain_text","description":"Human readable lines; easy to scan, harder to parse later."}], state {"user_request":"pick a log format","codebase_facts":"the CLI already prints a human-readable table"}. Print the tool result verbatim and nothing else.')"
check "result block returned" "$OUT" "JEV decide[log-format]"
check "action line present" "$OUT" "ACTION "
check "machine-readable record" "$OUT" "jev-record: "
# The wording for a run with no human only appears when a decision escalates, and a
# well-posed decision should not. That axis is covered by test/unit/format.test.ts.
check "a real verdict, not an outage" "$OUT" "conf "

LEDGER="$(node "$ROOT/dist/cli.mjs" log --json 2>/dev/null)"
check "ledger has the decision" "$LEDGER" '"label":"log-format"'
if [ -n "$(ls -A "$STATE_DIR/calls" 2>/dev/null)" ]; then
  echo "  FAIL handoff files were not cleaned up"; FAILURES=$((FAILURES + 1))
else
  echo "  ok   handoff files cleaned up"
fi

echo
echo "S7: subagents get the protocol and can call the tools"
OUT="$(run 'Use the Agent tool with subagent_type "general-purpose" for this task: "Call mcp__plugin_jev_jev__decide with decision \"scratch-dir\", question \"Which directory should a scratch file go in?\", stakes \"low\", options [{\"id\":\"tmp\",\"description\":\"The system temp directory, cleaned by the OS.\"},{\"id\":\"cwd\",\"description\":\"The working directory, visible to the user.\"}], state {\"user_request\":\"pick a scratch location\"}. Report the ACTION line verbatim." Then report what it said.')"
check "subagent called the tool" "$OUT" "ACTION "
LEDGER="$(node "$ROOT/dist/cli.mjs" log --all --json 2>/dev/null)"
check "ledger attributes it to a subagent" "$LEDGER" '"agent_type":"general-purpose"'

echo
echo "plan mode: the protocol is followed while planning"
# ExitPlanMode does not exist in a headless run (there is no one to approve a plan), so the
# model summarises in prose instead of writing a plan file. The ledger is therefore the
# assertion that means something here; the '## Decisions (Jev)' heading is only checked in
# the interactive checklist below.
OUT="$(run 'Plan a tiny Node CLI that counts words in a file. Keep the plan to 6 lines.' --permission-mode plan)"
check "the plan reports the Jev consultation" "$OUT" "Jev"
LEDGER="$(node "$ROOT/dist/cli.mjs" log --all --json 2>/dev/null)"
check "ledger marks the plan-mode decision" "$LEDGER" '"permission_mode":"plan"'

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "e2e: all checks passed"
else
  echo "e2e: $FAILURES check(s) failed"
fi

cat <<'MANUAL'

Still to check by hand, in an interactive session (these cannot run headlessly):
  1. claude --plugin-dir . , enter plan mode, ask for a plan, and let Claude call
     ExitPlanMode without consulting Jev. Expect: a refusal naming the call that fixes it,
     the session still in plan mode, and the plan approved after Claude consults and retries.
  2. The plan contains a '## Decisions (Jev)' section listing each fork.
  3. /hooks lists the jev hooks with source "jev", and /jev:log shows the session's ledger.
MANUAL
exit "$FAILURES"
