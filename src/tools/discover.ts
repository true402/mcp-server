import { z } from "zod";
import { USER_AGENT, updateNotice } from "../client.js";
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
export function toZod(prop: JsonSchema): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    base = z.enum(prop.enum.map(String) as [string, ...string[]]);
  } else if (prop.type === "number" || prop.type === "integer") {
    base = z.number();
  } else if (prop.type === "boolean") {
    base = z.boolean();
  } else if (prop.type === "object") {
    // Nested-object params (e.g. quant's `params`) must pass through as objects — coercing them to
    // string made every such tool call fail validation.
    base = z.record(z.unknown());
  } else if (prop.type === "array") {
    base = z.array(z.unknown());
  } else {
    base = z.string();
  }
  return prop.description ? base.describe(prop.description) : base;
}

/** Build a zod raw shape from a request-body JSON Schema's `properties` + `required`. */
export function bodyToShape(schema: JsonSchema | undefined): ZodRawShapeCompat {
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
  /** Optional explicit tool name from the service; wins over the path-derived one. */
  ["x-mcp-tool-name"]?: unknown;
}

/**
 * Render `x-payment-info.price` into a short, agent-facing suffix for the tool description.
 *
 * Auto-discovery means a stall's price is never hand-checked against MAX_PAYMENT_USDC the way the
 * hand-written `examples/` client wrappers are — the caller only finds out a price is too high when
 * `assessRequirement()` refuses it (fails closed, never crashes or overpays — but with zero warning
 * beforehand). This surfaces the price up front, and for `mode: "dynamic"` stalls specifically calls
 * out that the top of the range can exceed a ceiling sized for the FIXED-price catalog (e.g.
 * seo-audit: $0.04–$0.80/page, live 2026-08-15 — a multi-page audit can land well above a $0.25 cap).
 */
export function formatPriceInfo(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const price = (raw as { price?: unknown }).price;
  if (!price || typeof price !== "object") return "";
  const p = price as { mode?: unknown; currency?: unknown; amount?: unknown; min?: unknown; max?: unknown; unit?: unknown };
  const currency = typeof p.currency === "string" ? p.currency : "USD";
  const unit = typeof p.unit === "string" ? `/${p.unit}` : "";
  if (p.mode === "dynamic" && p.min !== undefined && p.max !== undefined) {
    return ` Price: $${p.min}–$${p.max} ${currency}${unit} (DYNAMIC — can exceed a fixed MAX_PAYMENT_USDC ceiling; raise it if a call is refused).`;
  }
  if (p.amount !== undefined) {
    return ` Price: $${p.amount} ${currency} (fixed).`;
  }
  return "";
}

/**
 * Pick a tool name for a stall that is unique across everything registered so far.
 *
 * The name used to be the last path segment alone, which broke the moment the service started
 * serving the same stall on several chains: `/v1/base/token-report`, `/v1/ethereum/token-report` and
 * `/v1/bsc/token-report` all collapsed to `token_report`. The MCP SDK throws on a duplicate name, so
 * that did not merely lose a tool — it crashed the server at startup and took every other tool with
 * it, for anyone whose copy fetched the newer spec.
 *
 * Order matters and is deliberate: the FIRST path to claim a bare name keeps it. The service lists
 * Base before the other chains, so `token_report` stays Base — the name already published in the
 * docs, the SDKs and users' agent configs. Later chains fall back to `<stall>_<chain>`, matching the
 * names the service's own catalog advertises.
 */
function uniqueToolName(rel: string, op: OpenApiOp, taken: Set<string>): string | null {
  const explicit = typeof op["x-mcp-tool-name"] === "string" ? op["x-mcp-tool-name"] : "";
  const segments = rel.replace(/\/+$/, "").split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const prev = segments[segments.length - 2] ?? "";
  const norm = (s: string) => s.replace(/-/g, "_");

  for (const candidate of [explicit, last, prev && last ? `${last}_${prev}` : ""]) {
    if (!candidate) continue;
    const name = norm(candidate);
    if (!taken.has(name)) return name;
  }
  return null; // every candidate taken — skip rather than crash
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
      headers: { accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Boot-time copy of the update notice for the host's log (stderr — stdout is the protocol). The
    // user-visible copy arrives in the first tool result (x402-pay.ts); this one does not consume it.
    const bootNotice = updateNotice(res, baseUrl);
    if (bootNotice) console.error(bootNotice);
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
  const taken = new Set<string>();
  for (const [key, ops] of Object.entries(spec.paths ?? {})) {
    const op = ops.post;
    if (!op || op["x-payment-info"] === undefined) continue; // paid stalls only
    if (key.endsWith("/chat/completions")) continue; // chat is special-cased (hardcoded)

    const rel = basePath && key.startsWith(basePath) ? key.slice(basePath.length) : key;
    const toolName = uniqueToolName(rel, op, taken);
    if (!toolName) continue;

    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    const description =
      (op.description ?? op.summary ?? `Paid x402 stall ${rel}`) +
      " (PAID x402 service — USDC on Base; the MCP server needs a funded wallet to settle.)" +
      formatPriceInfo(op["x-payment-info"]);

    // Guarded per stall: one malformed or conflicting entry in a spec we do not control must never
    // stop the others from registering, and must never abort startup.
    try {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`true402 MCP: skipping stall ${rel} (${msg})`);
      continue;
    }
    taken.add(toolName);
    registered.push(toolName);
  }
  return registered;
}
