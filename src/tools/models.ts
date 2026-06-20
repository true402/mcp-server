import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register the list_models tool.
 * Calls GET /v1/models on the true402 endpoint.
 */
export function registerModelsTool(server: McpServer, baseUrl: string) {
  server.tool(
    "list_models",
    "List available LLM models with pricing from true402",
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
