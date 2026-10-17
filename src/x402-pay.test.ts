import { describe, it, expect } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  allowedChainIds,
  assessRequirement,
  requireSecureUrl,
  parseMaxUsdc,
  selectPayableRequirement,
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
    expect(assessRequirement({ ...base, network: "eip155:137", amount: "1" }, 0.1)).toMatch(/not allowed/);
  });

  it("REFUSES a 402 with no amount", () => {
    const noAmount: EVMPaymentRequirement = { ...base };
    delete noAmount.amount;
    delete noAmount.maxAmountRequired;
    expect(assessRequirement(noAmount, 0.1)).toMatch(/no amount/);
  });

  it("REFUSES Base Sepolia and Ethereum mainnet by default — only Base mainnet is signed for", () => {
    const sepolia = { ...base, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "5000" };
    const mainnet = { ...base, network: "eip155:1", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "5000" };
    expect(assessRequirement(sepolia, 0.1, allowedChainIds(undefined))).toMatch(/not allowed/);
    expect(assessRequirement(mainnet, 0.1, allowedChainIds(undefined))).toMatch(/not allowed/);
  });

  it("accepts canonical Base-Sepolia USDC when X402_ALLOW_NETWORKS opts in", () => {
    expect(
      assessRequirement(
        { ...base, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "5000" },
        0.1,
        allowedChainIds("eip155:84532")
      )
    ).toBeNull();
  });

  it("REFUSES a zero, negative, hex, blank or decimal amount (digits only, > 0)", () => {
    for (const amount of ["0", "-5", "0x10", " 12", "", "1.5", "1e6"]) {
      expect(assessRequirement({ ...base, amount }, 0.1), JSON.stringify(amount)).toMatch(/refusing to sign/);
    }
  });
});

describe("requireSecureUrl — never sign/send a payment over cleartext", () => {
  it("refuses http:// for a non-local host (the X-PAYMENT header would be interceptable)", () => {
    expect(requireSecureUrl("http://evil.example/api")).toMatch(/cleartext/);
  });

  it("allows https://", () => {
    expect(requireSecureUrl("https://true402.dev/api")).toBeNull();
  });

  it("allows http://localhost + 127.0.0.1 + [::1] for dev", () => {
    expect(requireSecureUrl("http://localhost:5000")).toBeNull();
    expect(requireSecureUrl("http://127.0.0.1:5000")).toBeNull();
    expect(requireSecureUrl("http://[::1]:5000")).toBeNull();
  });

  it("is not fooled by userinfo that LOOKS like localhost", () => {
    expect(requireSecureUrl("http://localhost:x@evil.example/api")).toMatch(/cleartext/);
    expect(requireSecureUrl("http://127.0.0.1@evil.example/api")).toMatch(/cleartext/);
  });
});

describe("parseMaxUsdc — fail-closed ceiling (the only wallet-drain guard must never silently disable)", () => {
  it("uses the 0.25 default when unset and parses a valid number", () => {
    expect(parseMaxUsdc(undefined)).toBe(0.25);
    expect(parseMaxUsdc("0.10")).toBe(0.1);
  });

  // Regression guard for the CRITICAL bug this fixed: the default silently sat BELOW the live
  // catalog's top fixed price (keyword-volume, $0.15, measured 2026-08-15) because this server
  // auto-discovers every paid stall from /openapi.json rather than exposing a hand-picked list — so
  // "raise the sibling examples/ packages' cap" does not automatically cover this package's default.
  // This does not hit the network; it pins the default against the highest price this fix was
  // written against, so a future default change that reintroduces the gap fails loud, in CI, instead
  // of silently refusing a live tool again.
  it("the default clears the highest known live FIXED stall price with real headroom (not zero, not negative)", () => {
    const HIGHEST_KNOWN_LIVE_FIXED_PRICE_USD = 0.15; // keyword-volume, https://true402.dev/api/openapi.json
    expect(parseMaxUsdc(undefined)).toBeGreaterThan(HIGHEST_KNOWN_LIVE_FIXED_PRICE_USD);
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

// ─────────────────────────────────────────────────────────────────────────────
// Picking the payment rail out of `accepts[]`.
//
// true402 quotes two rails and BOTH carry `scheme: "exact"` — EVM and Solana. Selecting on scheme
// alone therefore picks whatever the server happened to list first; it works only because the server
// deliberately keeps EVM at accepts[0]. That invariant lives in a different codebase from this
// published client, and a client already installed in the field cannot be hot-fixed if it ever
// moves. Select on what we can actually PAY instead — which must stay every EVM chain this client
// supports (Base, Base Sepolia, Ethereum), not just Base.
// ─────────────────────────────────────────────────────────────────────────────
describe("selectPayableRequirement — pick the rail we can pay, not the one listed first", () => {
  const solana = { scheme: "exact", network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9xQ..." };

  it("picks the EVM entry even when a Solana 'exact' entry is listed FIRST", () => {
    const picked = selectPayableRequirement([solana, base] as never[]);
    expect(picked?.network).toBe("eip155:8453");
  });

  it("still picks the EVM entry when it is listed first (no behaviour change today)", () => {
    const picked = selectPayableRequirement([base, solana] as never[]);
    expect(picked?.network).toBe("eip155:8453");
  });

  it("selects only Base mainnet by default — Ethereum and Base Sepolia are skipped", () => {
    for (const network of ["eip155:1", "eip155:84532", "ethereum", "base-sepolia"]) {
      expect(selectPayableRequirement([solana, { ...base, network }] as never[], allowedChainIds(undefined)), network).toBeUndefined();
    }
  });

  it("X402_ALLOW_NETWORKS adds Ethereum / Base Sepolia, and ignores unsupported entries", () => {
    const allowed = allowedChainIds("eip155:1, eip155:84532, eip155:137, solana");
    expect([...allowed].sort((a, b) => a - b)).toEqual([1, 8453, 84532]);
    for (const network of ["eip155:1", "eip155:84532", "ethereum", "base-sepolia"]) {
      const picked = selectPayableRequirement([solana, { ...base, network }] as never[], allowed);
      expect(picked?.network, `${network} must be selectable once allowed`).toBe(network);
    }
  });

  it("returns undefined when no entry is on a chain this client can pay", () => {
    expect(selectPayableRequirement([solana] as never[])).toBeUndefined();
    expect(selectPayableRequirement([] as never[])).toBeUndefined();
  });

  it("ignores non-exact schemes (Lightning/BOLT11 is not implemented here)", () => {
    expect(selectPayableRequirement([{ scheme: "bolt11", network: "lightning" }] as never[])).toBeUndefined();
  });
});
