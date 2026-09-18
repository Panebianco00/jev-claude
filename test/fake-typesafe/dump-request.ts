/**
 * Prints the exact request body the plugin puts on the wire for one tool call, by pointing
 * the real MCP server at the fake endpoint and dumping what it received.
 *
 *   npx esbuild test/fake-typesafe/dump-request.ts --bundle --platform=node --format=esm \
 *     --target=node20 --outfile=.dump.mjs && node .dump.mjs '<tool>' '<json args>'
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeTypeSafe } from "./server.ts";

const tool = process.argv[2] ?? "decide";
const args = JSON.parse(process.argv[3] ?? "{}") as Record<string, unknown>;

const fake = await startFakeTypeSafe();
// Resolved from the working directory, not from import.meta: this file is run as a bundle
// that lives somewhere else entirely.
const root = resolve(process.env.JEV_REPO ?? process.cwd());

const client = new Client({ name: "dump", version: "0" }, { capabilities: {} });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "server.mjs")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JEV_STATE_DIR: mkdtempSync(join(tmpdir(), "jev-dump-")),
      TYPESAFE_BASE_URL: fake.url,
      TYPESAFE_API_KEY: "dump-key",
    },
  }),
);

await client.callTool({ name: tool, arguments: args });
await client.close();

process.stdout.write(JSON.stringify(fake.requests[0], null, 2) + "\n");
await fake.close();
