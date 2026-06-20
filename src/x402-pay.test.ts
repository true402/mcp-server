import { describe, it, expect } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  assessRequirement,
  requireSecureUrl,
  parseMaxUsdc,
  signEIP3009Payment,
  type EVMPaymentRequirement,
} from "./x402-pay.js";

const base: EVMPaymentRequirement = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // canonical Base-mainnet USDC
  payTo: "0x1111111111111111111111111111111111111111",
  facilitatorUrl: "",
  maxTimeoutSeconds: 60,
  mimeType: "application/json",
};

describe("assessRequirement — client-side spend ceiling + asset/network pin (wallet-drain guard)", () => {
  it("allows a normal stall price under the ceiling", () => {
    expect(assessRequirement({ ...base, amount: "5000" }, 0.1)).toBeNull(); // $0.005
    expect(assessRequirement({ ...base, amount: "15000" }, 0.1)).toBeNull(); // $0.015 (seo-audit)
  });

  it("REFUSES a wallet-draining amount above MAX_PAYMENT_USDC", () => {
    expect(assessRequirement({ ...base, amount: "5000000" }, 0.1)).toMatch(/exceeds the MAX_PAYMENT_USDC ceiling/); // $5
  });

  it("REFUSES a non-canonical asset (a hostile 402 redirecting the signature to an arbitrary token)", () => {
    expect(assessRequirement({ ...base, asset: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", amount: "1" }, 0.1)).toMatch(
      /not canonical USDC/
    );
  });

  it("REFUSES an unsupported network", () => {
    expect(assessRequirement({ ...base, network: "eip155:137", amount: "1" }, 0.1)).toMatch(/not canonical USDC/);
  });

  it("REFUSES a 402 with no amount", () => {
    const noAmount: EVMPaymentRequirement = { ...base };
    delete noAmount.amount;
    delete noAmount.maxAmountRequired;
    expect(assessRequirement(noAmount, 0.1)).toMatch(/no amount/);
  });

  it("accepts canonical Base-Sepolia USDC too", () => {
    expect(
      assessRequirement(
        { ...base, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "5000" },
        0.1
      )
    ).toBeNull();
  });
});

describe("requireSecureUrl — never sign/send a payment over cleartext", () => {
  it("refuses http:// for a non-local host (the X-PAYMENT header would be interceptable)", () => {
    expect(requireSecureUrl("http://evil.example/api")).toMatch(/cleartext/);
  });

  it("allows https://", () => {
    expect(requireSecureUrl("https://true402.dev/api")).toBeNull();
  });

  it("allows http://localhost + 127.0.0.1 for dev", () => {
    expect(requireSecureUrl("http://localhost:5000")).toBeNull();
    expect(requireSecureUrl("http://127.0.0.1:5000")).toBeNull();
  });
});

describe("parseMaxUsdc — fail-closed ceiling (the only wallet-drain guard must never silently disable)", () => {
  it("uses the 0.10 default when unset and parses a valid number", () => {
    expect(parseMaxUsdc(undefined)).toBe(0.1);
    expect(parseMaxUsdc("0.25")).toBe(0.25);
  });

  it("clamps a non-numeric / negative value to 0 (refuse-all), NEVER NaN/unlimited", () => {
    expect(parseMaxUsdc("0,10")).toBe(0); // European comma-decimal → Number() = NaN
    expect(parseMaxUsdc("abc")).toBe(0);
    expect(parseMaxUsdc("-5")).toBe(0);
    expect(parseMaxUsdc("1e999")).toBe(0); // Infinity
  });

  it("a clamped (0) ceiling refuses even a normal $0.005 payment (fail closed, not open)", () => {
    expect(assessRequirement({ ...base, amount: "5000" }, parseMaxUsdc("0,10"))).toMatch(/exceeds the MAX_PAYMENT_USDC/);
  });
});

describe("signEIP3009Payment — bound + validate the signed window (maxTimeoutSeconds)", () => {
  const key = generatePrivateKey();
  const req = (mts: unknown): EVMPaymentRequirement => ({ ...base, amount: "5000", maxTimeoutSeconds: mts as number });

  it("rejects a non-integer / non-positive maxTimeoutSeconds (no string-concat footgun)", async () => {
    await expect(signEIP3009Payment(key, req("abc"))).rejects.toThrow(/maxTimeoutSeconds/);
    await expect(signEIP3009Payment(key, req(0))).rejects.toThrow(/maxTimeoutSeconds/);
  });

  it("caps the signed validBefore window at 600s for a hostile huge maxTimeoutSeconds", async () => {
    const signed = (await signEIP3009Payment(key, req(999_999_999))) as {
      payload: { authorization: { validBefore: string; validAfter: string } };
    };
    const span = Number(signed.payload.authorization.validBefore) - Number(signed.payload.authorization.validAfter);
    expect(span).toBeLessThanOrEqual(660); // min(timeout,600) ahead + 60s back
  });
});
