# @true402.dev/mcp-server

MCP server for the **[true402](https://true402.dev)** machine-native marketplace — give your agent pay-per-call access to AI inference and web tools over [x402](https://x402.org) (HTTP 402 micropayments in USDC on Base).

No accounts, no API keys. The agent's **wallet is its identity**: each paid tool returns an HTTP 402 challenge, the server signs an EIP-3009 USDC authorization, and the call settles on-chain. Configure a funded wallet to auto-pay, or run without one and the paid tools will surface the exact payment requirements instead of failing.

## Tools

Tools are **auto-discovered** from the live catalog at startup, so a new marketplace stall appears
without an update to this package. The catalog currently yields:

| Group | Tools | Price |
|-------|-------|-------|
| Token safety (Base) | `token_report` (composite avoid/caution/ok verdict — the pre-trade gate), `token_safety`, `honeypot`, `address_safety`, `address_risk`, `deployer_check` | $0.005–0.008 |
| Base history & flow | `liquidity_history` (every observed liquidity removal + co-drained tokens), `liquidity_pulls`, `new_pairs`, `whale_swaps` | $0.003–0.005 |
| Before you sign | `tx_preflight` — an **unsigned** Base transaction: does it revert, does it grant an unlimited approval, has the counterparty drained liquidity. Takes no key and no signature | $0.008 |
| Full dossier | `token_dossier` — verdict + reasons over deployer and liquidity history, and what could not be established | $0.10 |
| Other chains | token safety, token report and address safety on **Ethereum** and **BSC** (plus deployer check on Ethereum); token safety on **Solana** | $0.005–0.008 |
| Web | `web_extract`, `link_preview`, `screenshot`, `robots_check` (AI-crawler policy + llms.txt), `headers_check` | $0.003–0.005 |
| SEO & search | `seo_audit` (SEO + GEO audit, per page), `serp`, `backlinks`, `keyword_volume` (up to 200 keywords per call), `ranked_keywords`, `keyword_ideas` | $0.02–0.15 |
| Markets & finance | `prediction_markets`, `defi_yields`, `quant` | $0.003–0.005 |
| LLM | `chat` (OpenAI-compatible, per-token + 3%), `list_models` (free) | — |

Prices are indicative; the live 402 challenge is authoritative, and the server refuses to sign above
its per-call cap. Call `list_models` or read <https://true402.dev/api/openapi.json> for the exact set.

## Install

Requires Node.js ≥ 20. Runs over stdio — point any MCP client at it via `npx`.

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "true402": {
      "command": "npx",
      "args": ["-y", "@true402.dev/mcp-server"],
      "env": {
        "WALLET_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_WALLET_KEY"
      }
    }
  }
}
```

### Cursor / Cline / other MCP clients

Same idea — command `npx`, args `["-y", "@true402.dev/mcp-server"]`, and the `WALLET_PRIVATE_KEY` env var.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SERVER_URL` | `https://true402.dev/api` | true402 API base. Override to point at a self-hosted instance. |
| `WALLET_PRIVATE_KEY` | _(none)_ | A funded **Base** wallet private key used to sign x402 payments. Needs **USDC** (gas is sponsored by the facilitator — no ETH required). Without it, paid tools return the 402 requirements instead of paying. |
| `MAX_PAYMENT_USDC` | `0.25` | Hard per-call spend ceiling in USDC. This server **auto-discovers every paid stall** the marketplace advertises (it walks the live OpenAPI spec, not a fixed list), so a new or repriced stall can appear above the default at any time — a call over the ceiling is refused (not paid, not crashed), and the refusal names the price and the ceiling. Raise it if a discovered tool's description shows a price close to or over your configured value; one stall (`seo_audit`) is priced **per page** and can itself exceed a typical ceiling on a large page. |
| `X402_ALLOW_NETWORKS` | _(none)_ | Payments are signed for **Base mainnet (`eip155:8453`) only**; a 402 naming any other chain is refused. To also pay on Base Sepolia or Ethereum mainnet, list them as comma-separated CAIP-2 ids, e.g. `eip155:84532,eip155:1`. Unsupported entries are ignored. |

> **Security:** the key is read only from the environment and is never logged, echoed, or returned. Use a dedicated low-balance wallet — fund it with only what you intend to spend.

## How payment works

1. The tool calls the true402 endpoint with no payment.
2. The server replies `402` with accepted payment options (USDC on Base).
3. This MCP server signs an EIP-3009 `transferWithAuthorization` with your wallet.
4. It retries with the signed payment in the `PAYMENT-SIGNATURE` header (x402 v2); the service verifies and responds.
5. Settlement happens on-chain. Your wallet pays only USDC — the facilitator sponsors gas.

When a newer release of this server exists, the first tool result of the session carries one extra
line saying so, with the install command. Nothing is blocked; it is shown once per process.

## Links

- Marketplace: <https://true402.dev>
- Free Telegram rug-check bot (no wallet): <https://t.me/True402bot>
- Live tool catalog: <https://true402.dev/api/v1/services>
- x402 protocol: <https://x402.org>

## Guides

- [The x402 protocol, explained](https://true402.dev/guides/what-is-x402)
- [x402 facilitators: what they do and which to use](https://true402.dev/guides/x402-facilitator)
- [Fund a Base wallet for x402 (USDC only, no ETH)](https://true402.dev/guides/fund-a-base-wallet-for-x402)

## Also available for

MCP (Claude Code / Desktop, Cursor, **Hermes**) · **Hermes Agent** · **OpenClaw** · **ElizaOS** ·
**LangChain** · **CrewAI** · **Vercel AI SDK** · **Coinbase AgentKit** · **Virtuals GAME** · CLI —
same on-chain checks, one install command each:
**[true402.dev/integrations](https://true402.dev/integrations)**

## Paying, exactly

The rules below are the service's, not this package's — they bite whatever client you use, and they
are the ones that surprise people writing their own payer.

- **Pay the EXACT amount quoted in the 402.** Underpaying is rejected. **Overpaying is refused with
  402 and never credited** — settlement submits the signed value and there is no refund path, so a
  surplus would simply be swept. Equality is also what binds an authorization to the resource it was
  quoted for.
- **One authorization buys exactly one response.** A replay is refused, not double-charged.
- **You are charged on success only.** Settlement is submitted only when the endpoint returns 2xx; if
  it errors or times out, your signed authorization is never submitted, so there is nothing to refund.
- Some endpoints serve a few free calls per day per client IP, with no wallet. The per-operation
  description in the [OpenAPI spec](https://true402.dev/api/openapi.json) says which.

Full rules: **[true402.dev/terms](https://true402.dev/terms)** · what is logged and kept:
**[true402.dev/privacy](https://true402.dev/privacy)**

## License

MIT
