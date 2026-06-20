# true402 quickstart — call any tool in one line

Pay-per-call AI + web + on-chain tools for agents over [x402](https://x402.org) (USDC on Base).
**No account, no API key** — your wallet is your identity. Copy [`true402.mjs`](./true402.mjs)
(viem-only) and call any stall:

```bash
npm i viem
export PAYER_PRIVATE_KEY=0x…          # a Base wallet holding a little USDC ($1 ≈ 200 calls; gas sponsored)
node true402.mjs /v1/token-safety '{"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
```

```js
import { call } from './true402.mjs';
const v = await call('/v1/token-safety', { token }, { payerPrivateKey: process.env.PAYER_PRIVATE_KEY });
// no key? call() returns the 402 payment requirements instead of paying — inspect before committing.
```

## The catalog — 12 tools

| Path | $ | Input | Returns |
|------|---|-------|---------|
| `/v1/token-safety` | 0.005 | `{token}` | rug/honeypot score, risk, flags, liquidity, buy/sell sim |
| `/v1/base/address-safety` | 0.005 | `{address}` | EOA/contract profile, balances, EIP-1967 proxy, risk |
| `/v1/base/token-report` | 0.01 | `{token}` | composite ape-in verdict (safety + rug/whale activity) |
| `/v1/base/new-pairs` | 0.003 | `{}` | newly created Base DEX pairs (fresh launches) |
| `/v1/base/liquidity-pulls` | 0.003 | `{}` | liquidity-removal / rug alerts |
| `/v1/base/whale-swaps` | 0.005 | `{}` | large swaps by USD size |
| `/v1/seo-audit` | 0.015 | `{url}` | SEO + GEO audit, 100-pt report |
| `/v1/web-extract` | 0.005 | `{url}` | clean text + markdown + links + metadata |
| `/v1/link-preview` | 0.003 | `{url}` | Open Graph / unfurl card |
| `/v1/robots-check` | 0.003 | `{url}` | AI-crawler policy + sitemaps + llms.txt |
| `/v1/headers-check` | 0.003 | `{url}` | security-headers score |
| `/v1/chat/completions` | per-token | OpenAI-compatible | LLM inference across many models |

Prices are illustrative; the live `402` challenge is authoritative. The full, current catalog +
each tool's JSON schema is always at **`GET https://true402.dev/api/v1/services`** (and the
OpenAPI at `/openapi.json`). New stalls appear there automatically.

## How it works (x402, ~4 lines)

1. POST your input → server replies **402** with payment requirements.
2. `call()` signs an **EIP-3009** USDC authorization (off-chain, gasless for you).
3. It retries with an `X-PAYMENT` header → server verifies, settles on Base, returns the result.
4. No account is ever created. Fund a dedicated low-balance wallet with only what you'll spend.

Prefer MCP? The same catalog auto-loads as tools via `npx -y @true402.dev/mcp-server`
(see the [repo root](../../README.md)).
