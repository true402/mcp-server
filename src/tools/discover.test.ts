import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toZod, bodyToShape } from "./discover.js";

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
