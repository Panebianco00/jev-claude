#!/usr/bin/env node
/**
 * npm run calibrate [-- --only <substring>] [--json]
 *
 * Sends every fixture in test/calibration/fixtures through the plugin's real request path to
 * the live TypeSafe API, then reports:
 *   - fixtures whose answers landed on the wrong side (the regression view), and
 *   - per question, the spread between its yes cases and its no cases, and whether the
 *     threshold that acts on it sits inside that gap (the tuning view).
 * Results go to test/calibration/results/<model>.json so a model upgrade can be diffed.
 *
 * Needs a key (TYPESAFE_API_KEY or `jev-doctor set-key`); roughly $0.0001 per fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveApiKey } from "../src/shared/config.ts";
import { loadFixtures, runFixture, separation, type Observation } from "../test/calibration/runner.ts";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const asJson = args.includes("--json");

// A project .jev.json must not change what is being measured: load from an empty directory.
const cfg = loadConfig({ cwd: tmpdir() });
if (!resolveApiKey(cfg).key) {
  process.stderr.write("calibrate: no TypeSafe API key (export TYPESAFE_API_KEY or run jev-doctor set-key)\n");
  process.exit(2);
}

const fixtures = loadFixtures().filter((f) => !only || f.name.includes(only));
const observations: Observation[] = [];
// Small batches: fast enough, and polite to the rate limiter.
for (let i = 0; i < fixtures.length; i += 4) {
  observations.push(...(await Promise.all(fixtures.slice(i, i + 4).map((f) => runFixture(f, cfg)))));
}

const seps = separation(observations, cfg.thresholds);
const model = observations.find((o) => o.model)?.model ?? "unknown";
const failed = observations.filter((o) => o.failures.length);

const f2 = (n: number): string => n.toFixed(2);
if (asJson) {
  process.stdout.write(JSON.stringify({ model, failed: failed.length, seps }, null, 2) + "\n");
} else {
  process.stdout.write(`model ${model}: ${observations.length - failed.length}/${observations.length} fixtures as expected\n\n`);
  for (const o of failed) {
    process.stdout.write(`FAIL ${o.fixture.name}\n${o.failures.map((f) => `     ${f}`).join("\n")}\n`);
  }
  process.stdout.write(`\nper question (gap = lowest yes - highest no; threshold must sit inside it)\n`);
  for (const s of seps) {
    const yes = s.yes.length ? `yes ${s.yes.map(f2).join(" ")}` : "";
    const no = s.no.length ? `no ${s.no.map(f2).join(" ")}` : "";
    const gap = s.gap === undefined ? "  n/a" : (s.gap >= 0 ? " " : "") + f2(s.gap);
    const th = s.threshold ? `${s.threshold.path}=${f2(s.threshold.value)} ${s.thresholdSeparates ? "ok" : "MISPLACED"}` : "";
    process.stdout.write(`  ${s.id.padEnd(40)} gap ${gap}  ${th.padEnd(38)} ${yes}${yes && no ? " | " : ""}${no}\n`);
  }
}

// A filtered run is a probe, not a baseline: writing it would replace the model's full
// results file with a subset.
if (only) {
  process.exitCode = failed.length ? 1 : 0;
  process.exit();
}
const dir = join(import.meta.dirname, "..", "test", "calibration", "results");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${model}.json`);
writeFileSync(
  out,
  JSON.stringify(
    {
      model,
      date: new Date().toISOString().slice(0, 10),
      fixtures: observations.map((o) => ({
        name: o.fixture.name,
        ok: o.failures.length === 0,
        failures: o.failures,
        nouls: o.nouls,
        choices: o.choices,
        coverage: o.coverage,
        action: o.action,
      })),
      separation: seps,
    },
    null,
    2,
  ) + "\n",
);
if (!asJson) process.stdout.write(`\nwrote ${out}\n`);
process.exitCode = failed.length ? 1 : 0;
