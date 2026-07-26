# @true402.dev/mcp-server

MCP server for the **[true402](https://true402.dev)** machine-native marketplace — give your agent pay-per-call access to AI inference and web tools over [x402](https://x402.org) (HTTP 402 micropayments in USDC on Base).

No accounts, no API keys. The agent's **wallet is its identity**: each paid tool returns an HTTP 402 challenge, the server signs an EIP-3009 USDC authorization, and the call settles on-chain. Configure a funded wallet to auto-pay, or run without one and the paid tools will surface the exact payment requirements instead of failing.

## Tools

| Tool | Price | What it does |
|------|-------|--------------|
| `chat` | per-token + 3% | OpenAI-compatible LLM inference across many models |
| `list_models` | free | List available models + pricing |
| `token_safety` | $0.005 | ERC-20 rug/honeypot pre-check on Base → 0–100 score, risk band, flags, liquidity depth + a buy/sell honeypot simulation |
| `seo_audit` | $0.04/page | SEO + GEO (generative-engine-optimization) audit of a page → structured report |
| `web_extract` | $0.005 | Fetch a URL → clean text + markdown + links + metadata |
| `link_preview` | $0.003 | Fetch a URL → Open Graph / unfurl card |
| `robots_check` | $0.003 | A site's AI-crawler policy (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, …) + sitemaps + llms.txt |
| `headers_check` | $0.003 | HTTP security-headers analysis (HSTS, CSP, …) + a 0–100 score |
| `new_pairs` | $0.003 | Newly created Base DEX pairs (Uniswap V3 / Aerodrome) — fresh token launches |
| `liquidity_pulls` | $0.003 | Liquidity-removal / rug alerts on Base pools |
| `whale_swaps` | $0.005 | Large swaps on Base by USD size — whale flow |
| `token_report` | $0.01 | Fuller on-chain token report |

Tools are **auto-discovered** from the live catalog, so new marketplace stalls appear automatically.
Prices are illustrative; the live 402 challenge is authoritative.

## Example: add token-safety to your agent

A copy-paste reference in [`examples/token-safety/`](examples/token-safety/) — a framework-agnostic
x402 client plus a drop-in LangChain tool that rug/honeypot-checks any Base token for $0.005/call.

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

> **Security:** the key is read only from the environment and is never logged, echoed, or returned. Use a dedicated low-balance wallet — fund it with only what you intend to spend.

## How payment works

1. The tool calls the true402 endpoint with no payment.
2. The server replies `402` with accepted payment options (USDC on Base).
3. This MCP server signs an EIP-3009 `transferWithAuthorization` with your wallet.
4. It retries with the signed `X-PAYMENT` header; the service verifies and responds.
5. Settlement happens on-chain. Your wallet pays only USDC — the facilitator sponsors gas.

## Links

- Marketplace: <https://true402.dev>
- Free Telegram rug-check bot (no wallet): <https://t.me/True402bot>
- Live tool catalog: <https://true402.dev/api/v1/services>
- x402 protocol: <https://x402.org>

## License

MIT
