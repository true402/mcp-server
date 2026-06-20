#!/usr/bin/env node

/**
 * true402 MCP Server
 *
 * Exposes the true402 machine-native marketplace as MCP tools for Claude and other
 * MCP-compatible clients: LLM inference plus the paid web stalls (SEO/GEO audit, web
 * extract, link preview, robots/AI-crawler check, security-headers check). Each paid
 * tool is x402-gated (USDC on Base); set WALLET_PRIVATE_KEY to auto-pay. Uses stdio.
 *
 * Environment variables:
 *   SERVER_URL          - true402 API base (default: https://true402.dev/api)
 *   WALLET_PRIVATE_KEY  - funded Base wallet key for x402 payment signing (optional;
 *                         without it, paid tools surface the 402 requirements instead)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerModelsTool } from "./tools/models.js";
import { registerChatTool } from "./tools/chat.js";
import { registerStallTools } from "./tools/stalls.js";
import { registerDiscoveredStalls } from "./tools/discover.js";

const SERVER_URL = process.env.SERVER_URL ?? "https://true402.dev/api";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

const server = new McpServer({
  name: "true402",
  version: "0.7.0",
});

// Start server with stdio transport
async function main() {
  // Always-present built-in tools (LLM router — chat uses a $ref body + streaming, so it stays
  // hand-written rather than discovered).
  registerModelsTool(server, SERVER_URL);
  registerChatTool(server, SERVER_URL, WALLET_PRIVATE_KEY);

  // Paid stalls: ASK THE SERVER. Fetch its OpenAPI spec and register an MCP tool for every paid
  // POST endpoint (x-payment-info), so a new marketplace stall surfaces automatically with no MCP
  // release. Falls back to the built-in stall list only if the server is unreachable at startup.
  const discovered = await registerDiscoveredStalls(server, SERVER_URL, WALLET_PRIVATE_KEY);
  if (discovered) {
    console.error(
      `true402 MCP: discovered ${discovered.length} paid stalls from ${SERVER_URL} (${discovered.join(", ")})`
    );
  } else {
    registerStallTools(server, SERVER_URL, WALLET_PRIVATE_KEY);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
