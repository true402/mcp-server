import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register the list_models tool.
 * Calls GET /v1/models on the true402 endpoint.
 */
export function registerModelsTool(server: McpServer, baseUrl: string) {
  server.tool(
    "list_models",
    "List every LLM model available through true402's pay-per-call inference, with live per-token pricing (3% over provider cost, min $0.0001/request). Returns each model's id, provider, and input/output token prices across OpenAI, Anthropic, Google, Groq, Mistral and Together — so an agent can pick a model and know the exact cost before paying via x402 (USDC on Base, no account or API key).",
    {},
    async () => {
      const response = await fetch(`${baseUrl}/v1/models`);

      if (!response.ok) {
        const text = await response.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching models: ${response.status} ${text}`,
            },
          ],
          isError: true,
        };
      }

      const data = await response.json();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}
