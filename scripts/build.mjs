#!/usr/bin/env node
// Bundles the three entrypoints into dist/*.mjs.
// dist/ is committed so that installing the plugin never runs an install step.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Bundled ESM may pull in CJS dependencies that expect require/__dirname.
const banner = {
  js: [
    "import { createRequire as __jevCreateRequire } from 'node:module';",
    "import { fileURLToPath as __jevFileURLToPath } from 'node:url';",
    "import { dirname as __jevDirname } from 'node:path';",
    "const require = __jevCreateRequire(import.meta.url);",
    "const __filename = __jevFileURLToPath(import.meta.url);",
    "const __dirname = __jevDirname(__filename);",
  ].join("\n"),
};

const entries = [
  { in: "src/server/index.ts", out: "dist/server.mjs" },
  { in: "src/hooks/main.ts", out: "dist/hook.mjs" },
  { in: "src/cli/main.ts", out: "dist/cli.mjs" },
];

// Bundles are overwritten in place rather than wiped first: a live Claude Code session holds
// dist/server.mjs open, and deleting the directory makes any reconnect in the rebuild window
// fail with CONNECTION_CLOSED.
mkdirSync(resolve(root, "dist"), { recursive: true });

const watch = process.argv.includes("--watch");

for (const entry of entries) {
  await build({
    entryPoints: [resolve(root, entry.in)],
    outfile: resolve(root, entry.out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner,
    logLevel: "info",
    minify: false,
    sourcemap: false,
  });
  if (watch) continue;
}

console.log("built", entries.map((e) => e.out).join(", "));
