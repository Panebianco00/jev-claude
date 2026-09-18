---
name: log
description: Show the Jev decision ledger for this session - every decision consulted, the options, probabilities, confidence and the action taken. Use when the user asks what Jev decided, why a gate fired, or what was sent to TypeSafe.
user-invocable: true
---

Run the decision log and show the user the result verbatim.

!`jev-log $ARGUMENTS`

Reproduce the output above verbatim inside a fenced code block, exactly as it was printed.
Do not rebuild it as a markdown table and do not abbreviate any value — the columns are
already aligned, and re-formatting truncates them.

Then add at most two sentences of interpretation: which decisions were escalated to the user
and which were taken autonomously. Do not re-run the command with different arguments unless
the user asks.

Useful arguments: `--all` (every session), `--session <id>`, `--json`, `--calibration`
(confidence distribution against the actions taken, for tuning thresholds on real data).
