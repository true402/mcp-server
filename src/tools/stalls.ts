import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ZodRawShapeCompat,
  ShapeOutput,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { payAndFetch } from "../x402-pay.js";

/**
 * Paid, non-LLM stalls exposed by the true402 marketplace.
 *
 * Each of these is an x402-gated POST endpoint that takes a small JSON body and
 * returns a structured JSON report. They are all PAID services (USDC on Base):
 * the MCP server must have a funded wallet (WALLET_PRIVATE_KEY) configured for
 * the calls to settle. With no wallet, the tools surface the 402 payment
 * requirements instead of crashing.
 */

/**
 * A generic paid stall: an MCP tool that POSTs a body to an x402-gated path and
 * returns the parsed JSON report. The input type is inferred from the zod raw
 * shape `Schema`, and the body is built from the validated tool args via
 * `buildBody`.
 */
export interface StallSpec<Schema extends ZodRawShapeCompat> {
  /** MCP tool name (e.g. "seo_audit"). */
  toolName: string;
  /** Server-side endpoint path (e.g. "/v1/seo-audit"). */
  path: string;
  /** Agent-facing description. Should make clear this is a PAID x402 service. */
  description: string;
  /** Zod raw shape (plain object of validators) describing the tool inputs. */
  inputSchema: Schema;
  /** Map validated args to the JSON request body sent to the endpoint. */
  buildBody: (args: ShapeOutput<Schema>) => Record<string, unknown>;
}

/**
 * Register a single paid stall as an MCP tool. The handler runs the shared
 * x402 pay-and-retry flow and maps the result into the MCP content shape.
 */
export function registerStall<Schema extends ZodRawShapeCompat>(
  server: McpServer,
  baseUrl: string,
  walletPrivateKey: string | undefined,
  spec: StallSpec<Schema>
) {
  const handler = async (
    args: ShapeOutput<Schema>
  ): Promise<CallToolResult> => {
    const body = spec.buildBody(args);
    const result = await payAndFetch(
      baseUrl,
      spec.path,
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
  };

  // The SDK's `tool` overloads use conditional-typed callbacks that don't
  // resolve through a still-generic `Schema`. The public surface above
  // (StallSpec, handler) is fully typed; we only relax the call boundary.
  type ToolFn = (
    name: string,
    description: string,
    schema: ZodRawShapeCompat,
    cb: (args: ShapeOutput<Schema>) => Promise<CallToolResult>
  ) => unknown;
  (server.tool as unknown as ToolFn)(
    spec.toolName,
    spec.description,
    spec.inputSchema,
    handler
  );
}

// A required http/https page URL — shared by every stall.
const urlField = z
  .string()
  .url()
  .describe("Absolute http(s) URL of the page to process");

/**
 * Register all nine non-LLM paid stalls on the given MCP server: the web utilities
 * (seo_audit, web_extract, link_preview, robots_check, headers_check) and the Base
 * on-chain trading signals (token_safety, new_pairs, liquidity_pulls, whale_swaps).
 */
export function registerStallTools(
  server: McpServer,
  baseUrl: string,
  walletPrivateKey: string | undefined
) {
  // 1. SEO + GEO audit.
  registerStall(
    server,
    baseUrl,
    walletPrivateKey,
    {
      toolName: "seo_audit",
      path: "/v1/seo-audit",
      description:
        "Audit a web page for SEO + GEO (generative-engine-optimization). " +
        "Returns a structured JSON report: meta tags, an SEO score with " +
        "per-category breakdown + issues, a GEO score with breakdown + " +
        "issues, and a combined percentage. PAID x402 service (USDC on " +
        "Base) — needs a funded wallet on the MCP server.",
      inputSchema: {
        url: urlField,
        mode: z
          .enum(["both", "seo", "geo"])
          .optional()
          .describe(
            "Which audit(s) to run: 'both' (default), 'seo' only, or 'geo' only"
          ),
      },
      buildBody: ({ url, mode }) => {
        const body: Record<string, unknown> = { url };
        if (mode !== undefined) body.mode = mode;
        return body;
      },
    }
  );

  // 2. Clean web extraction (readable text + markdown + links + metadata).
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "web_extract",
    path: "/v1/web-extract",
    description:
      "Fetch a URL and return its clean readable text, a light markdown " +
      "rendering, all links (in document order), and metadata (title, " +
      "description, word count, byte size). PAID x402 service (USDC on " +
      "Base) — needs a funded wallet on the MCP server.",
    inputSchema: { url: urlField },
    buildBody: ({ url }) => ({ url }),
  });

  // 3. Link preview / Open Graph card.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "link_preview",
    path: "/v1/link-preview",
    description:
      "Fetch a URL and return its link-preview / Open Graph unfurl card: " +
      "title, description, image, siteName, type, canonical URL, favicon, " +
      "and theme color (image/canonical/favicon resolved to absolute URLs). " +
      "PAID x402 service (USDC on Base) — needs a funded wallet on the MCP " +
      "server.",
    inputSchema: { url: urlField },
    buildBody: ({ url }) => ({ url }),
  });

  // 4. AI-crawler / robots.txt policy check.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "robots_check",
    path: "/v1/robots-check",
    description:
      "Report a site's AI-crawler policy (GPTBot, ClaudeBot, Google-Extended, " +
      "PerplexityBot, and ~15 other AI bots: allow | block | unspecified), " +
      "plus declared sitemaps and whether an llms.txt is present. Pass any " +
      "URL on the target site. PAID x402 service (USDC on Base) — needs a " +
      "funded wallet on the MCP server.",
    inputSchema: { url: urlField },
    buildBody: ({ url }) => ({ url }),
  });

  // 5. HTTP security-headers analysis.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "headers_check",
    path: "/v1/headers-check",
    description:
      "Analyse a URL's HTTP security headers (HSTS, CSP, X-Frame-Options, " +
      "and more) into a present/missing breakdown plus a 0-100 score, along " +
      "with status, HTTPS flag, and server banner. PAID x402 service (USDC " +
      "on Base) — needs a funded wallet on the MCP server.",
    inputSchema: { url: urlField },
    buildBody: ({ url }) => ({ url }),
  });

  // 6. On-chain token safety — rug/honeypot pre-check for a Base ERC-20.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "token_safety",
    path: "/v1/token-safety",
    description:
      "Rug/honeypot safety check for an ERC-20 token on Base (on-chain reads, no " +
      "API key): ERC-20 conformance, ownership renounce, mint capability, WETH/USDC " +
      "liquidity depth (Uniswap V3 + Aerodrome), and a buy/sell honeypot simulation " +
      "(a gas-free eth_call that round-trips a tiny WETH→token→WETH trade to catch " +
      "tokens you can buy but not sell). Returns a 0-100 score + risk band + flags. " +
      "PAID x402 service (USDC on Base) — needs a funded wallet on the MCP server.",
    inputSchema: {
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte ERC-20 address")
        .describe("ERC-20 contract address (0x…) on Base"),
      chain: z
        .literal("base")
        .optional()
        .describe("Chain to check; only 'base' is supported (default)"),
    },
    buildBody: ({ token, chain }) => {
      const body: Record<string, unknown> = { token };
      if (chain !== undefined) body.chain = chain;
      return body;
    },
  });

  // 7. New token / new pair detection — recently-created Base DEX pairs.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "new_pairs",
    path: "/v1/base/new-pairs",
    description:
      "Recently-created Base DEX pairs (Uniswap V3 + Aerodrome) — fresh token launches for " +
      "trading/sniper agents. Returns each new token, its quote (WETH/USDC), pool, fee|stable, " +
      "block and approx age, newest first. Bundle with token_safety for a pre-trade rug/honeypot " +
      "check. On-chain log indexing, no API key. PAID x402 service (USDC on Base) — needs a funded " +
      "wallet on the MCP server.",
    inputSchema: {
      since: z.number().int().nonnegative().optional().describe("Only pairs first seen at or after this block"),
      limit: z.number().int().min(1).max(200).optional().describe("Max pairs to return (1–200, default 50)"),
      dex: z.enum(["uniswap-v3", "aerodrome"]).optional().describe("Filter by DEX"),
      withToken: z.boolean().optional().describe("Only token launches (vs all pools); default true"),
    },
    buildBody: ({ since, limit, dex, withToken }) => {
      const body: Record<string, unknown> = {};
      if (since !== undefined) body.since = since;
      if (limit !== undefined) body.limit = limit;
      if (dex !== undefined) body.dex = dex;
      if (withToken !== undefined) body.withToken = withToken;
      return body;
    },
  });

  // 8. Liquidity-pull / rug alerts — liquidity-removal (Burn) events on tracked Base pools.
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "liquidity_pulls",
    path: "/v1/base/liquidity-pulls",
    description:
      "Liquidity-pull / rug alerts on Base — liquidity-removal (Burn) events on recently-launched " +
      "DEX pools (Uniswap V3 + Aerodrome). Returns the pool, token, and WETH/USDC amount removed " +
      "(the rug magnitude), newest first — an early rug warning. Cross-check the token with " +
      "token_safety. On-chain log indexing, no API key. PAID x402 service (USDC on Base) — needs a " +
      "funded wallet on the MCP server.",
    inputSchema: {
      since: z.number().int().nonnegative().optional().describe("Only pulls first seen at or after this block"),
      limit: z.number().int().min(1).max(200).optional().describe("Max pulls to return (1–200, default 50)"),
      dex: z.enum(["uniswap-v3", "aerodrome"]).optional().describe("Filter by DEX"),
      minQuote: z.number().nonnegative().optional().describe("Only removals of at least this much WETH/USDC"),
    },
    buildBody: ({ since, limit, dex, minQuote }) => {
      const body: Record<string, unknown> = {};
      if (since !== undefined) body.since = since;
      if (limit !== undefined) body.limit = limit;
      if (dex !== undefined) body.dex = dex;
      if (minQuote !== undefined) body.minQuote = minQuote;
      return body;
    },
  });

  // 9. Whale swaps — large ($-value) Base DEX Swap events (whale-follow / copy-trade signal).
  registerStall(server, baseUrl, walletPrivateKey, {
    toolName: "whale_swaps",
    path: "/v1/base/whale-swaps",
    description:
      "Recent large ($-value) Base DEX Swap events (whale trades) on tracked pools — a " +
      "whale-following / copy-trade signal. Returns the pool, dex, token, quote (WETH/USDC), USD " +
      "size, direction (buy/sell of the non-quote token), block and approx age, newest first. " +
      "On-chain log indexing, no API key. PAID x402 service (USDC on Base) — needs a funded wallet " +
      "on the MCP server.",
    inputSchema: {
      min: z.number().nonnegative().optional().describe("Only swaps of at least this USD size (default 10000)"),
      dex: z.enum(["uniswap-v3", "aerodrome"]).optional().describe("Filter by DEX"),
      since: z.number().int().nonnegative().optional().describe("Only swaps at or after this block"),
      limit: z.number().int().min(1).max(200).optional().describe("Max swaps to return (1–200, default 50)"),
      direction: z.enum(["buy", "sell"]).optional().describe("Filter by trade direction (of the non-quote token)"),
    },
    buildBody: ({ min, dex, since, limit, direction }) => {
      const body: Record<string, unknown> = {};
      if (min !== undefined) body.min = min;
      if (dex !== undefined) body.dex = dex;
      if (since !== undefined) body.since = since;
      if (limit !== undefined) body.limit = limit;
      if (direction !== undefined) body.direction = direction;
      return body;
    },
  });
}
