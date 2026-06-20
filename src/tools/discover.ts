import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { registerStall } from "./stalls.js";

/**
 * Self-configuring stall discovery.
 *
 * Instead of hard-coding one MCP tool per marketplace stall (which means republishing this
 * package every time true402 adds a service), we ASK THE SERVER: fetch its OpenAPI spec and
 * register an MCP tool for every PAID POST endpoint (the ones carrying `x-payment-info`). The
 * marketplace is already self-describing — path, description, payment marker, and request schema
 * all live in `/openapi.json` — so a new stall surfaces as an MCP tool automatically, no release.
 *
 * `chat` (a $ref body + streaming) stays special-cased in index.ts; only flat POST stalls are
 * discovered here. If the fetch fails we return null so the caller can fall back to the built-in
 * stall list (offline resilience).
 */

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

/** Map one JSON-Schema property to a zod validator (covers the property kinds the stalls use). */
function toZod(prop: JsonSchema): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    base = z.enum(prop.enum.map(String) as [string, ...string[]]);
  } else if (prop.type === "number" || prop.type === "integer") {
    base = z.number();
  } else if (prop.type === "boolean") {
    base = z.boolean();
  } else {
    base = z.string();
  }
  return prop.description ? base.describe(prop.description) : base;
}

/** Build a zod raw shape from a request-body JSON Schema's `properties` + `required`. */
function bodyToShape(schema: JsonSchema | undefined): ZodRawShapeCompat {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema?.required ?? []);
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const v = toZod(prop);
    shape[key] = required.has(key) ? v : v.optional();
  }
  return shape as ZodRawShapeCompat;
}

interface OpenApiOp {
  description?: string;
  summary?: string;
  requestBody?: { content?: { "application/json"?: { schema?: JsonSchema } } };
  ["x-payment-info"]?: unknown;
}

/**
 * Fetch `${baseUrl}/openapi.json` and register an MCP tool for each paid POST stall.
 * Returns the registered tool names, or null if discovery failed (caller should fall back).
 */
export async function registerDiscoveredStalls(
  server: McpServer,
  baseUrl: string,
  walletPrivateKey: string | undefined
): Promise<string[] | null> {
  let spec: { paths?: Record<string, { post?: OpenApiOp }> };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${baseUrl}/openapi.json`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spec = (await res.json()) as typeof spec;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`true402 MCP: stall discovery from ${baseUrl}/openapi.json failed (${msg}); using built-in stall list`);
    return null;
  }

  // OpenAPI path keys carry the base path (e.g. /api/v1/x); strip it so the tool path is relative
  // to baseUrl (which already includes /api), matching how payAndFetch joins baseUrl + path.
  let basePath = "";
  try {
    basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    /* baseUrl is relative — keys are already root-relative */
  }

  const registered: string[] = [];
  for (const [key, ops] of Object.entries(spec.paths ?? {})) {
    const op = ops.post;
    if (!op || op["x-payment-info"] === undefined) continue; // paid stalls only
    if (key.endsWith("/chat/completions")) continue; // chat is special-cased (hardcoded)

    const rel = basePath && key.startsWith(basePath) ? key.slice(basePath.length) : key;
    const toolName = (rel.replace(/\/+$/, "").split("/").pop() ?? "").replace(/-/g, "_");
    if (!toolName) continue;

    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    const description =
      (op.description ?? op.summary ?? `Paid x402 stall ${rel}`) +
      " (PAID x402 service — USDC on Base; the MCP server needs a funded wallet to settle.)";

    registerStall(server, baseUrl, walletPrivateKey, {
      toolName,
      path: rel,
      description,
      inputSchema: bodyToShape(bodySchema),
      // The discovered zod shape already mirrors the body, so pass validated args straight through.
      buildBody: (args: Record<string, unknown>) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined) body[k] = v;
        return body;
      },
    });
    registered.push(toolName);
  }
  return registered;
}
