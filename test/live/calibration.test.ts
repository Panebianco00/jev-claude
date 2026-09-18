/**
 * Live regression suite: every calibration fixture must still land where it is expected to.
 * Runs only with JEV_LIVE=1 and an API key; never part of `npm test`.
 *
 *   JEV_LIVE=1 npx vitest run test/live
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveApiKey } from "../../src/shared/config.ts";
import { loadFixtures, runFixture } from "../calibration/runner.ts";

const live = process.env.JEV_LIVE === "1";
const cfg = loadConfig({ cwd: tmpdir() });

describe.skipIf(!live)("live calibration fixtures", () => {
  it("has an API key", () => {
    expect(resolveApiKey(cfg).key, "set TYPESAFE_API_KEY or run jev-doctor set-key").toBeDefined();
  });

  for (const f of loadFixtures()) {
    it(f.name, async () => {
      const obs = await runFixture(f, cfg);
      expect(obs.failures, f.note ?? "").toEqual([]);
    });
  }
});
