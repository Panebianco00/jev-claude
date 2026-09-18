#!/usr/bin/env node
/**
 * The jev MCP server.
 *
 * It is declared `alwaysLoad`, so Claude Code blocks session startup until it connects:
 * nothing here may touch the network, read a large file, or throw at import time. In
 * particular the TypeSafe client is built lazily per call, because its constructor throws
 * when no API key is configured and that must degrade to an unverified decision, not to a
 * session without the tool.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_INSTRUCTIONS, TOOLS, handleCall } from "./tools.ts";

const VERSION = process.env.JEV_PLUGIN_VERSION ?? "0.1.0";

const server = new Server(
  { name: "jev", version: VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params;
  // Claude Code sends the tool_use_id here; it is how a call is joined to the context the
  // PreToolUse hook wrote and to the ledger entry the PostToolUse hook appends.
  const toolUseId =
    typeof _meta?.["claudecode/toolUseId"] === "string"
      ? (_meta["claudecode/toolUseId"] as string)
      : undefined;

  if (name !== "decide" && name !== "check") {
    return { content: [{ type: "text", text: `jev: unknown tool "${name}"` }], isError: true };
  }

  try {
    return await handleCall(name, args, toolUseId);
  } catch (err) {
    // An unexpected fault must not look like a Jev verdict, but it also must not take the
    // session down: report it as a tool error and let Claude carry on.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jev server error: ${message}\n`);
    return {
      content: [
        {
          type: "text",
          text: `jev ${name} failed internally (${message}). Decide with your own judgment and mention that Jev was not consulted.`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
