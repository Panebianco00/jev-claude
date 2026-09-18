/**
 * Runs every test file from an empty directory.
 *
 * Hooks and the MCP server read `.jev.json` from their working directory (or from the `cwd`
 * in the hook payload). Run from the repo root, a developer's own `.jev.json` — say
 * `{"enforcement":"soft"}` — silently switched the gates off and failed ten tests that had
 * nothing wrong with them. Spawned children inherit this directory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "jev-cwd-")));
