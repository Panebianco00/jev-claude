/**
 * Runs the fake TypeSafe server as a standalone process, so end-to-end scripts can point a
 * real Claude Code session at it without needing an API key.
 *
 *   node scripts/build.mjs && npx esbuild test/fake-typesafe/run.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/fake.mjs && node /tmp/fake.mjs
 */
import { startFakeTypeSafe } from "./server.ts";

const fake = await startFakeTypeSafe();
process.stdout.write(`${fake.url}\n`);

const shutdown = (): void => {
  void fake.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
