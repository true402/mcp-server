/**
 * Shared x402 payment helper for the true402 MCP server.
 *
 * Encapsulates the full pay-and-retry flow used by every paid stall:
 *   1. POST the request body (no payment header)
 *   2. If the server replies 402, parse the payment requirements
 *   3. Pick the EVM (scheme: "exact") option, sign an EIP-3009
 *      TransferWithAuthorization with the configured wallet
 *   4. Retry with the base64-encoded `PAYMENT-SIGNATURE` header (x402 v2)
 *   5. Return the parsed JSON (or a structured error)
 *
 * The signer is network-aware: it derives the EIP-712 domain (chainId,
 * verifyingContract, name, version) from the 402 requirement itself. Which
 * networks it will sign for at ALL is pinned: Base mainnet only, unless the
 * operator lists more in X402_ALLOW_NETWORKS (see {@link allowedChainIds}).
 *
 * SECURITY: the wallet private key is never logged, echoed, or returned.
 */

import { type Hex, type Address, encodePacked, keccak256 } from "viem";
import { USER_AGENT, takeUpdateNotice } from "./client.js";
import { privateKeyToAccount } from "viem/accounts";

/**
 * EVM payment requirement from a 402 response (scheme: "exact").
 */
export interface EVMPaymentRequirement {
  scheme: "exact";
  network: string;
  /**
   * Amount in USDC base units. x402 v2 advertises this as `amount`; v1 used
   * `maxAmountRequired`. We read either so the client works against both.
   */
  amount?: string;
  maxAmountRequired?: string;
  asset: string;
  payTo: string;
  facilitatorUrl: string;
  maxTimeoutSeconds: number;
  mimeType: string;
  description?: string;
  resource?: { url: string; method: string };
  /**
   * Optional EIP-712 USDC domain advertised by the server.
   * Base mainnet USDC uses name "USD Coin"; Base Sepolia test USDC uses "USDC".
   */
  extra?: { name?: string; version?: string };
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// CAIP-2 chain id -> EVM numeric chainId.
const CHAIN_IDS: Record<string, number> = {
  "eip155:8453": 8453, // Base mainnet
  "eip155:84532": 84532, // Base Sepolia
  "eip155:1": 1, // Ethereum mainnet
};

// Fallback numeric chainId when the network string is unknown (Base mainnet).
const DEFAULT_CHAIN_ID = 8453;

/**
 * Resolve the numeric chainId for an x402 `network` value. Accepts CAIP-2
 * ("eip155:8453"), a bare numeric id ("8453"), or the friendly names the
 * server config understands ("base-mainnet" / "base-sepolia" / "ethereum").
 */
function resolveChainId(network: string): number {
  if (CHAIN_IDS[network] !== undefined) return CHAIN_IDS[network];
  const colon = network.indexOf(":");
  if (colon !== -1) {
    const n = Number(network.slice(colon + 1));
    if (Number.isFinite(n) && n > 0) return n;
  }
  switch (network) {
    case "base-mainnet":
    case "base":
      return 8453;
    case "base-sepolia":
      return 84532;
    case "ethereum":
    case "mainnet":
      return 1;
    default: {
      const n = Number(network);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHAIN_ID;
    }
  }
}

// Canonical USDC per chain — the ONLY token/chain this client will ever sign a payment for, so a
// hostile or buggy server cannot redirect the wallet's signature to an arbitrary token/chain.
const USDC_BY_CHAIN: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum mainnet
};

/** The only network signed for by default: Base mainnet, where true402 settles. */
const DEFAULT_ALLOWED_CHAIN_ID = 8453;

/**
 * The chains this server will sign a payment for.
 *
 * A 402 is written by the server being paid, and SERVER_URL can point anywhere. Signing for whatever
 * chain the 402 names meant a hostile or misconfigured seller could collect a valid USDC authorization
 * on Ethereum mainnet (or a testnet) from a wallet the operator funded for Base. So: Base mainnet
 * only, unless the operator opts in explicitly —
 *
 *   X402_ALLOW_NETWORKS=eip155:84532,eip155:1   (CAIP-2 ids, comma-separated, ADDED to Base)
 *
 * Only chains with a pinned USDC in USDC_BY_CHAIN can be added; anything else is ignored with a warning.
 */
export function allowedChainIds(raw: string | undefined = process.env.X402_ALLOW_NETWORKS): Set<number> {
  const allowed = new Set<number>([DEFAULT_ALLOWED_CHAIN_ID]);
  for (const entry of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^eip155:(\d+)$/.exec(entry);
    const id = m ? Number(m[1]) : NaN;
    if (USDC_BY_CHAIN[id] !== undefined) allowed.add(id);
    else console.error(`true402 MCP: X402_ALLOW_NETWORKS entry '${entry}' is not a supported CAIP-2 network — ignored.`);
  }
  return allowed;
}

/**
 * Pick the payment requirement this client can actually settle.
 *
 * true402 quotes MORE THAN ONE rail and both carry `scheme: "exact"` — EVM and Solana. Selecting on
 * scheme alone returns whatever the server listed first, which works only because the server
 * deliberately keeps EVM at `accepts[0]`. That invariant is maintained in a different codebase from
 * this published client, and a client already installed in the field cannot be hot-fixed if it ever
 * moves — so match on what we can PAY.
 *
 * "Can pay" means a chain with a pinned USDC that is also ALLOWED (Base mainnet, plus whatever
 * X402_ALLOW_NETWORKS adds) — the same rule `assessRequirement` validates against. Amount and asset
 * are still checked afterwards — this only decides WHICH entry gets checked.
 */
export function selectPayableRequirement(
  accepts: Array<Record<string, unknown>> | undefined,
  allowed: Set<number> = allowedChainIds(),
): EVMPaymentRequirement | undefined {
  return (accepts ?? []).find((r) => {
    if (r.scheme !== "exact") return false;
    const chainId = strictChainId(typeof r.network === "string" ? r.network : "");
    return chainId !== undefined && USDC_BY_CHAIN[chainId] !== undefined && allowed.has(chainId);
  }) as EVMPaymentRequirement | undefined;
}

/**
 * Like {@link resolveChainId} but returns undefined instead of guessing.
 *
 * `resolveChainId` falls back to DEFAULT_CHAIN_ID (Base) for ANY unrecognised network string, so it
 * reports "solana" as chain 8453. That is harmless where it is used — `assessRequirement` then
 * compares the asset and refuses, because Solana's base58 USDC is not Base's hex address — but it
 * is useless for CHOOSING a rail: every entry would look payable. Selection needs a resolver that
 * can say "I do not know this network", so an unknown rail is skipped rather than picked and then
 * refused downstream.
 */
function strictChainId(network: string): number | undefined {
  if (CHAIN_IDS[network] !== undefined) return CHAIN_IDS[network];
  const caip = /^eip155:(\d+)$/.exec(network);
  if (caip) return Number(caip[1]);
  switch (network) {
    case "base":
    case "base-mainnet":
      return 8453;
    case "base-sepolia":
      return 84532;
    case "ethereum":
    case "mainnet":
      return 1;
    default:
      return undefined;
  }
}

/**
 * Guard a 402 requirement BEFORE signing: a hostile/buggy server must not make the wallet sign a
 * draining amount or an off-spec asset. Returns a refusal string, or null if the payment is allowed.
 * - amount must be ≤ `maxUsdc` (the client-side spend ceiling, MAX_PAYMENT_USDC).
 * - asset must be the canonical USDC on an ALLOWED chain (no arbitrary token/verifyingContract).
 */
export function assessRequirement(
  req: EVMPaymentRequirement,
  maxUsdc: number,
  allowed: Set<number> = allowedChainIds(),
): string | null {
  const raw = req.amount ?? req.maxAmountRequired;
  if (raw === undefined) return "the 402 has no amount; refusing to sign.";
  // Digits only, and positive: `BigInt` would also take "0x10", " 12 " or "" (= 0n), and "-5".
  if (!/^\d+$/.test(String(raw))) return "the 402 amount is unparseable; refusing to sign.";
  if (BigInt(raw) <= 0n) return "the 402 amount is not positive; refusing to sign.";
  const amountUsdc = Number(BigInt(raw)) / 1e6; // USDC has 6 decimals
  if (!Number.isFinite(amountUsdc)) return "the 402 amount is invalid; refusing to sign.";
  // `maxUsdc` is a finite, non-negative invariant (see parseMaxUsdc) — the comparison ALWAYS runs, so
  // a misconfigured ceiling can never silently disable the cap (maxUsdc=0 refuses everything).
  if (amountUsdc > maxUsdc) {
    return `refusing to auto-pay $${amountUsdc} USDC — it exceeds the MAX_PAYMENT_USDC ceiling of $${maxUsdc}. Raise MAX_PAYMENT_USDC if this is intended.`;
  }
  // The STRICT resolver: the lenient one maps any unknown network to Base and would let it through.
  const chainId = strictChainId(typeof req.network === "string" ? req.network : "");
  if (chainId === undefined || !allowed.has(chainId)) {
    return `refusing to pay: the 402's network "${String(req.network)}" is not allowed (Base mainnet only; add others with X402_ALLOW_NETWORKS).`;
  }
  const usdc = USDC_BY_CHAIN[chainId];
  if (!usdc || (req.asset ?? "").toLowerCase() !== usdc.toLowerCase()) {
    return "refusing to pay: the 402's asset/network is not canonical USDC on a supported Base network.";
  }
  return null;
}

/**
 * Default MAX_PAYMENT_USDC ceiling when the env var is unset.
 *
 * This server AUTO-DISCOVERS every paid stall the marketplace advertises (`tools/discover.ts` walks
 * the live `/openapi.json`), so the ceiling has to clear the whole live catalog, not just the
 * hand-picked fallback list. The previous default (0.10) was silently BELOW the catalog's own top
 * fixed price (`keyword-volume`, $0.15) — measured live 2026-08-15 — so a caller running with
 * defaults could never complete that call: `assessRequirement()` refused it every time, and the
 * README never mentioned the var, so the only way to discover the fix was to read the refusal text.
 * 0.25 matches the cap the sibling `examples/` client packages carry (raised the same day, commit
 * `7dab12a`) and clears every fixed-price stall with real headroom (min margin $0.10, on
 * keyword-volume). It does NOT cover the top of `seo-audit`'s own dynamic per-page range (up to
 * $0.80) — that is inherent to a per-page price scaling with input size, not a stale constant, and
 * `assessRequirement` still refuses (fails closed, never crashes or overpays) a quote that lands
 * above whatever ceiling is configured.
 */
const DEFAULT_MAX_USDC = 0.25;

/**
 * Parse the MAX_PAYMENT_USDC ceiling FAIL-CLOSED: unset → the DEFAULT_MAX_USDC default; a
 * non-numeric or negative value (e.g. the European comma-decimal "0,10" → NaN) clamps to 0 = refuse
 * ALL auto-pay, never disables the only wallet-drain guard.
 */
export function parseMaxUsdc(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_USDC;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  console.error(
    `true402 MCP: MAX_PAYMENT_USDC='${raw}' is not a valid number — refusing ALL auto-pay. Set a numeric value like 0.25.`
  );
  return 0;
}

/** Refuse to send a signed payment over cleartext (the PAYMENT-SIGNATURE header would be interceptable).
 *  Returns a refusal string, or null if the URL is https (or localhost for dev). */
export function requireSecureUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `invalid SERVER_URL: ${url}`;
  }
  // WHATWG URL keeps the brackets on an IPv6 hostname, so loopback is "[::1]", not "::1".
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !local) {
    return `refusing to send a signed payment over cleartext (${u.protocol}//${u.hostname}); use an https SERVER_URL (or localhost for dev).`;
  }
  return null;
}

/**
 * Redirects are never followed. fetch re-sends a 307/308 with the same method, body AND headers —
 * PAYMENT-SIGNATURE included — to wherever `Location` points, https to http included, so following
 * one would hand a signed, claimable authorization to a host nobody vetted. Both requests use
 * `redirect: "manual"`; this turns any 3xx into a refusal string (null = not a redirect).
 */
export function redirectRefusal(res: Response, url: string): string | null {
  if (String(res.type) === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return `${url} answered HTTP ${res.status}: server redirected; refusing to send a payment elsewhere.`;
  }
  return null;
}

// Request deadlines. Without one a stalled endpoint parks the tool call on undici's ~5-minute default.
// The PAID leg is far more generous: the server settles on 2xx, so abandoning a merely SLOW paid
// response would mean the buyer paid and got nothing (token-report legitimately takes tens of seconds).
const PROBE_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 120_000;

/**
 * Sign an EIP-3009 TransferWithAuthorization and return the x402 payment
 * payload. The EIP-712 domain is derived from the requirement (network +
 * asset + advertised domain name/version) so signatures are valid on the
 * exact chain the 402 demands.
 */
export async function signEIP3009Payment(
  privateKey: string,
  requirement: EVMPaymentRequirement
): Promise<object> {
  // viem's privateKeyToAccount requires a 0x-prefixed hex string. Accept a key
  // with or without the prefix (env files commonly store it bare).
  const key = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(key);

  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 60); // valid 60s in the past (clock skew tolerance)
  // Validate + bound the signed window: maxTimeoutSeconds arrives via JSON and may be a string
  // (`now + "999"` would string-concat); a hostile 402 must not keep the authorization broadcastable
  // far into the future. Coerce, reject garbage, cap at 10 minutes.
  const timeout = Number(requirement.maxTimeoutSeconds);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("Payment requirement has an invalid maxTimeoutSeconds");
  }
  const validBefore = BigInt(now + Math.min(timeout, 600));

  // Generate a random nonce (bytes32)
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const nonce = keccak256(
    encodePacked(
      ["bytes32", "uint256"],
      [
        ("0x" +
          Array.from(randomBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")) as Hex,
        BigInt(now),
      ]
    )
  );

  // v2 advertises `amount`; v1 used `maxAmountRequired` — accept either, like a1-pay/pay.mjs.
  const rawAmount = requirement.amount ?? requirement.maxAmountRequired;
  if (rawAmount === undefined) {
    throw new Error("Payment requirement is missing an amount");
  }
  const value = BigInt(rawAmount);

  const message = {
    from: account.address as Address,
    to: requirement.payTo as Address,
    value,
    validAfter,
    validBefore,
    nonce: nonce as Hex,
  };

  // Build the EIP-712 domain from the requirement so we sign for the right
  // chain + USDC contract. Prefer the domain name/version the server
  // advertises in `extra`; fall back to network-derived defaults.
  const chainId = resolveChainId(requirement.network);
  const domainName =
    requirement.extra?.name ?? (chainId === 84532 ? "USDC" : "USD Coin");
  const domainVersion = requirement.extra?.version ?? "2";

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract: requirement.asset as Address,
  };

  // Sign EIP-712 typed data
  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  // Build x402 payment payload
  return {
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}

/**
 * Discriminated result of {@link payAndFetch}.
 *
 * - `ok: true`  -> `data` holds the parsed JSON returned by the endpoint.
 * - `ok: false` -> `message` is a human/agent-readable explanation and
 *   `paymentRequired` is true when the failure was a 402 we could not satisfy
 *   (so the caller can surface the requirements clearly).
 */
export type PayAndFetchResult = (
  | { ok: true; data: unknown }
  | { ok: false; message: string; paymentRequired?: boolean }
) & {
  /** Set once per process when a newer release exists (client.ts); tools append it to their result. */
  updateNotice?: string;
};

/**
 * Perform the full x402 flow against `${baseUrl}${path}` with the given JSON
 * `body`. Returns the parsed JSON on success, or a structured error.
 *
 * If no wallet key is configured and the endpoint demands payment, this does
 * NOT crash — it returns `{ ok: false, paymentRequired: true, message }` with
 * the raw requirements embedded so an agent knows it must fund a wallet.
 */
export async function payAndFetch(
  baseUrl: string,
  path: string,
  body: unknown,
  walletPrivateKey: string | undefined
): Promise<PayAndFetchResult> {
  let notice: string | null = null;
  const note = (res: Response): void => {
    notice ??= takeUpdateNotice(res, baseUrl);
  };
  const result = await payAndFetchInner(baseUrl, path, body, walletPrivateKey, note);
  return notice ? { ...result, updateNotice: notice } : result;
}

async function payAndFetchInner(
  baseUrl: string,
  path: string,
  body: unknown,
  walletPrivateKey: string | undefined,
  note: (res: Response) => void
): Promise<PayAndFetchResult> {
  const url = `${baseUrl}${path}`;

  // Step 0: never sign/send a payment over cleartext (PAYMENT-SIGNATURE would be interceptable).
  const insecure = requireSecureUrl(url);
  if (insecure) return { ok: false, message: insecure };

  // Step 1: first request, no payment header.
  let firstResponse: Response;
  try {
    firstResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    note(firstResponse);
  } catch (err) {
    return {
      ok: false,
      message: `Network error reaching ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const firstRedirect = redirectRefusal(firstResponse, url);
  if (firstRedirect) return { ok: false, message: firstRedirect };

  // Step 2: non-402 short-circuit (success OR a non-payment error).
  if (firstResponse.status !== 402) {
    const data = await safeJson(firstResponse);
    if (!firstResponse.ok) {
      return {
        ok: false,
        message: `Request failed: ${firstResponse.status} ${stringify(data)}`,
      };
    }
    return { ok: true, data };
  }

  // Step 3: 402 Payment Required. Parse the requirements first so we can
  // surface them no matter what.
  const paymentData = (await safeJson(firstResponse)) as {
    x402Version?: number;
    accepts?: Array<Record<string, unknown>>;
  };

  if (!walletPrivateKey) {
    return {
      ok: false,
      paymentRequired: true,
      message: [
        "Payment required (HTTP 402). No wallet private key configured.",
        "This is a PAID x402 service (USDC on Base). Set WALLET_PRIVATE_KEY",
        "on the MCP server to a funded wallet to enable automatic payment.",
        "",
        "Payment requirements:",
        stringify(paymentData),
      ].join("\n"),
    };
  }

  // Find a payment option we can actually settle — NOT merely the first `scheme: "exact"` entry,
  // which is also what the Solana rail carries.
  const evmRequirement = selectPayableRequirement(paymentData.accepts);

  if (!evmRequirement) {
    // Lightning (BOLT11) payment is a TODO — not implemented here.
    return {
      ok: false,
      paymentRequired: true,
      message: [
        "Payment required (HTTP 402) but no payable option found.",
        "Only USDC on Base mainnet is signed for by default (other EVM chains need",
        "X402_ALLOW_NETWORKS); Lightning (BOLT11) is not implemented in this client.",
        "",
        "Available payment options:",
        stringify(paymentData.accepts),
      ].join("\n"),
    };
  }

  // Spend ceiling + asset/network pin: a hostile server must not make our wallet sign a draining
  // amount or a payment to an arbitrary token/chain. Refuse BEFORE signing.
  const maxUsdc = parseMaxUsdc(process.env.MAX_PAYMENT_USDC);
  const refusal = assessRequirement(evmRequirement, maxUsdc);
  if (refusal) {
    return { ok: false, paymentRequired: true, message: refusal };
  }

  // Step 4: sign the EIP-3009 authorization and base64-encode the payload.
  let xPaymentHeader: string;
  try {
    const signedPayload = await signEIP3009Payment(
      walletPrivateKey,
      evmRequirement
    );
    xPaymentHeader = Buffer.from(JSON.stringify(signedPayload)).toString(
      "base64"
    );
  } catch (err) {
    // Never include the key material in the error.
    return {
      ok: false,
      message: `Failed to sign payment: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Step 5: retry with the PAYMENT-SIGNATURE header (x402 v2).
  let retryResponse: Response;
  try {
    retryResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "PAYMENT-SIGNATURE": xPaymentHeader,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
    });
    note(retryResponse);
  } catch (err) {
    return {
      ok: false,
      message: `Network error on paid retry to ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const paidRedirect = redirectRefusal(retryResponse, url);
  if (paidRedirect) return { ok: false, message: paidRedirect };

  const retryData = await safeJson(retryResponse);
  if (!retryResponse.ok) {
    return {
      ok: false,
      message: `Payment sent but request failed: ${
        retryResponse.status
      } ${stringify(retryData)}`,
    };
  }

  return { ok: true, data: retryData };
}

/** Parse a response body as JSON, falling back to text wrapped in an object. */
async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
