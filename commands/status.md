---
name: status
description: Show the Jev plugin's configuration and health - API key source, enforcement level, authority mode, state directory, and whether the enforcement hooks are actually running. Use when Jev seems inactive, a decision came back unverified, or the user asks how the plugin is configured.
user-invocable: true
---

!`jev-doctor`

Reproduce the output above verbatim inside a fenced code block, exactly as it was printed.
Do not rebuild it as a markdown table, do not re-order or rename the rows, and do not
abbreviate any value: it is already aligned, and re-formatting it has produced truncated,
unreadable output.

Then add at most two sentences of your own. If the API key is missing, tell them the two ways
to fix it (export `TYPESAFE_API_KEY`, or run `jev-doctor set-key`) and do not offer to set it
yourself: the key must not pass through a command line or this transcript.

If "hooks running" is no, explain that the plugin's tools still work but nothing is enforced -
this happens in safe mode, in bare mode, or when hooks are disabled.
