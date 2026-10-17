import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toZod, bodyToShape, registerDiscoveredStalls, formatPriceInfo } from "./discover.js";

describe("toZod — OpenAPI body property → zod validator", () => {
  it("keeps enums as string enums", () => {
    const v = toZod({ type: "string", enum: ["a", "b"] });
    expect(v.safeParse("a").success).toBe(true);
    expect(v.safeParse("c").success).toBe(false);
  });

  it("maps number/integer/boolean/string to their primitives", () => {
    expect(toZod({ type: "number" }).safeParse(1.5).success).toBe(true);
    expect(toZod({ type: "integer" }).safeParse(3).success).toBe(true);
    expect(toZod({ type: "boolean" }).safeParse(true).success).toBe(true);
    expect(toZod({ type: "string" }).safeParse("x").success).toBe(true);
  });

  it("accepts a plain object for type:object (quant's nested params — must NOT demand a string)", () => {
    const v = toZod({ type: "object", description: "nested params" });
    expect(v.safeParse({ p: 0.55, b: 1.5 }).success).toBe(true);
    expect(v.safeParse("not-an-object").success).toBe(false);
  });

  it("accepts an array for type:array", () => {
    const v = toZod({ type: "array" });
    expect(v.safeParse([1, 2, 3]).success).toBe(true);
    expect(v.safeParse("nope").success).toBe(false);
  });
});

describe("bodyToShape — required vs optional", () => {
  it("marks non-required properties optional and passes objects through", () => {
    const shape = bodyToShape({
      type: "object",
      properties: {
        function: { type: "string", enum: ["kelly"] },
        params: { type: "object" },
        limit: { type: "number" },
      },
      required: ["function", "params"],
    });
    const schema = z.object(shape);
    expect(
      schema.safeParse({ function: "kelly", params: { p: 0.55, b: 1.5 } }).success
    ).toBe(true);
    expect(schema.safeParse({ function: "kelly" }).success).toBe(false);
  });
});

describe("formatPriceInfo — surfaces the live price in the discovered tool description", () => {
  // A fixed-price stall gets a plain "$X (fixed)" suffix.
  it("renders a fixed price", () => {
    expect(formatPriceInfo({ price: { mode: "fixed", currency: "USD", amount: "0.15" } })).toContain("$0.15 USD (fixed)");
  });

  // seo-audit's own live shape (min 0.04, max 0.80, unit "page") — this is the case that had NO
  // signal in the tool description before this fix, so a caller could not tell, before calling, that
  // the price could land above a fixed MAX_PAYMENT_USDC ceiling.
  it("renders a dynamic price range with an explicit ceiling warning", () => {
    const text = formatPriceInfo({ price: { mode: "dynamic", currency: "USD", min: "0.04", max: "0.8", unit: "page" } });
    expect(text).toContain("$0.04–$0.8 USD/page");
    expect(text).toMatch(/exceed a fixed MAX_PAYMENT_USDC ceiling/);
  });

  it("renders nothing for a missing/malformed price block, never throws", () => {
    expect(formatPriceInfo(undefined)).toBe("");
    expect(formatPriceInfo({})).toBe("");
    expect(formatPriceInfo({ price: {} })).toBe("");
  });
});

describe("registerDiscoveredStalls — per-chain paths must not collide", () => {
  /**
   * The service serves the same stall on several chains at /v1/{chain}/{stall}. Tool names were
   * derived from the LAST path segment alone, so /v1/base/token-report, /v1/ethereum/token-report
   * and /v1/bsc/token-report all produced "token_report". The MCP SDK THROWS on a duplicate tool
   * name, and the registration loop was unguarded — so the second chain path would crash the whole
   * server at startup, taking every already-working tool down with it.
   */
  const specWith = (paths: string[]) => ({
    paths: Object.fromEntries(
      paths.map((p) => [
        p,
        {
          post: {
            summary: "s",
            description: "d",
            "x-payment-info": { price: {} },
            requestBody: {
              content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } },
            },
          },
        },
      ])
    ),
  });

  const fakeServer = () => {
    const names: string[] = [];
    return {
      names,
      // Mirrors McpServer.tool(): a duplicate name throws.
      tool(name: string) {
        if (names.includes(name)) throw new Error(`Tool ${name} is already registered`);
        names.push(name);
      },
    };
  };

  const run = async (paths: string[]) => {
    const server = fakeServer();
    const spec = specWith(paths);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(spec) })) as unknown as typeof fetch;
    try {
      const out = await registerDiscoveredStalls(server as never, "https://x.test/api", undefined);
      return { registered: out, names: server.names };
    } finally {
      globalThis.fetch = origFetch;
    }
  };

  it("does not throw when the same stall exists on several chains", async () => {
    await expect(
      run(["/v1/base/token-report", "/v1/ethereum/token-report", "/v1/bsc/token-report"])
    ).resolves.toBeTruthy();
  });

  it("registers every chain under a DISTINCT name, leaving Base's established name untouched", async () => {
    const { names } = await run([
      "/v1/base/token-report",
      "/v1/ethereum/token-report",
      "/v1/bsc/token-report",
    ]);
    // Base keeps "token_report" — it is the name already published in SDKs, docs and agent configs.
    expect(names).toContain("token_report");
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(3);
  });

  it("still registers the remaining stalls if one registration fails", async () => {
    const { names } = await run(["/v1/seo-audit", "/v1/base/token-report", "/v1/ethereum/token-report"]);
    expect(names).toContain("seo_audit");
    expect(names).toContain("token_report");
  });
});

describe("registerDiscoveredStalls — dynamic-price stalls carry a headroom warning in their description", () => {
  it("wires x-payment-info through to the registered tool's description", async () => {
    const descriptions: Record<string, string> = {};
    const server = {
      tool(name: string, description: string) {
        descriptions[name] = description;
      },
    };
    const spec = {
      paths: {
        "/v1/seo-audit": {
          post: {
            summary: "SEO/GEO audit",
            description: "Audit a page.",
            "x-payment-info": { price: { mode: "dynamic", currency: "USD", min: "0.04", max: "0.8", unit: "page" } },
            requestBody: {
              content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } },
            },
          },
        },
      },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(spec) })) as unknown as typeof fetch;
    try {
      await registerDiscoveredStalls(server as never, "https://x.test/api", undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(descriptions.seo_audit).toContain("$0.04–$0.8 USD/page");
    expect(descriptions.seo_audit).toMatch(/exceed a fixed MAX_PAYMENT_USDC ceiling/);
  });
});
