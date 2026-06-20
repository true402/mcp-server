import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { payAndFetch } from "../x402-pay.js";

/**
 * Register the chat tool.
 * Calls POST /v1/chat/completions on the true402 endpoint.
 * Handles the x402 payment flow (402 -> sign -> retry with X-Payment header)
 * via the shared {@link payAndFetch} helper.
 */
export function registerChatTool(
  server: McpServer,
  baseUrl: string,
  walletPrivateKey: string | undefined
) {
  server.tool(
    "chat",
    "Send a chat completion request to an LLM via true402 (PAID x402 service, USDC on Base). Requires a funded wallet (WALLET_PRIVATE_KEY) on the MCP server.",
    {
      model: z.string().describe("Model ID (e.g. gpt-4o, claude-3-5-sonnet)"),
      messages: z
        .array(
          z.object({
            role: z.string().describe("Message role: system, user, or assistant"),
            content: z.string().describe("Message content"),
          })
        )
        .describe("Chat messages"),
      max_tokens: z
        .number()
        .optional()
        .describe("Maximum tokens to generate"),
    },
    async ({ model, messages, max_tokens }) => {
      const body: Record<string, unknown> = { model, messages };
      if (max_tokens !== undefined) {
        body.max_tokens = max_tokens;
      }

      const result = await payAndFetch(
        baseUrl,
        "/v1/chat/completions",
        body,
        walletPrivateKey
      );

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    }
  );
}
