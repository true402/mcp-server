# Token-Safety check for AI agents — $0.005/call, no API key

Give your agent an on-chain **rug / honeypot pre-check** for any ERC-20 on **Base**, before it buys,
approves, or holds an unfamiliar token. No account, no API key, no signup — your agent pays
**$0.005 USDC per call** over [x402](https://x402.org). Gas is sponsored by the facilitator, so the
paying wallet needs only a little USDC (no ETH).

**Endpoint:** `POST https://true402.dev/api/v1/token-safety`  ·  body `{"token":"0x…"}`

## What you get back

```jsonc
{
  "token": "0x…",
  "meta":  { "name": "…", "symbol": "…", "decimals": 18, "totalSupply": "…" },
  "liquidity": { /* quote-side WETH/USDC depth across Uniswap V3 + Aerodrome, in USD */ },
  "honeypot":  { "sellable": true, "roundTripBps": 120, "dex": "uniswap-v3" },  // null = could not simulate (never assume safe)
  "score": 82,                  // 0–100 structural safety score
  "risk":  "low",               // low | medium | high | critical
  "flags": []                   // e.g. ["owner_can_mint","low_liquidity","not_a_contract"]
}
```

The **honeypot** field is a real buy→sell simulation: `sellable:false` means you could buy in but not
out. `risk:"critical"` or `sellable:false` → don't touch it.

## 30-second integration

```bash
npm i viem
export PAYER_PRIVATE_KEY=0x…          # a Base wallet holding a little USDC ($1 = 200 calls)
node check-token-safety.mjs 0xYourTokenAddress
```

```js
import { checkTokenSafety } from './check-token-safety.mjs';

const v = await checkTokenSafety({ token, payerPrivateKey: process.env.PAYER_PRIVATE_KEY });
if (v.risk === 'critical' || v.honeypot?.sellable === false) {
  // skip the trade
}
```

### LangChain / LangGraph

Drop it straight into an agent ([`langchain-tool.mjs`](./langchain-tool.mjs)):

```js
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tokenSafetyTool } from './langchain-tool.mjs';

const agent = createReactAgent({
  llm,
  tools: [tokenSafetyTool({ payerPrivateKey: process.env.PAYER_PRIVATE_KEY })],
});
// "Before buying TOKEN, check it's safe" → the agent calls check_token_safety and pays $0.005.
```

## How the payment works (x402, ~4 lines)

1. Agent POSTs `{token}` → server replies **HTTP 402** with payment requirements.
2. Agent's wallet signs an **EIP-3009** USDC authorization for the exact amount (off-chain, gasless).
3. Agent retries with an `X-PAYMENT` header → server verifies, settles on Base, returns the verdict.
4. No account is ever created; the wallet **is** the identity.

`check-token-safety.mjs` does all of this in one function (viem-only). Copy it into your project.

## Why pay-per-call

No subscription, no key to leak, no rate-limit tier — an autonomous agent can discover and use this
with zero human onboarding. Reputation is the service's **on-chain settlement history** (public,
unfakeable), not a star rating.

---

*One service in the [true402](https://true402.dev) machine-native marketplace. Browse the rest at
`https://true402.dev/api/v1/services` or the OpenAPI at `https://true402.dev/api/openapi.json`.*
