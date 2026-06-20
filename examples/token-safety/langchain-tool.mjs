// langchain-tool.mjs — drop-in LangChain tool that lets an agent rug/honeypot-check a Base token
// for $0.005/call over x402. No API key; the agent pays per call from a wallet you control.
//
//   import { tokenSafetyTool } from './langchain-tool.mjs';
//   const tool = tokenSafetyTool({ payerPrivateKey: process.env.PAYER_PRIVATE_KEY });
//   const agent = createReactAgent({ llm, tools: [tool] });
//
// Peer deps (you already have these in a LangChain project): @langchain/core, zod.
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { checkTokenSafety } from './check-token-safety.mjs';

/** Build the LangChain tool. `payerPrivateKey` is a Base wallet holding a little USDC (gas sponsored). */
export function tokenSafetyTool({ payerPrivateKey, baseUrl, rpcUrl } = {}) {
  return new DynamicStructuredTool({
    name: 'check_token_safety',
    description:
      'Structural rug/honeypot pre-check for an ERC-20 token on Base before buying/holding it. ' +
      'Returns a 0-100 safety score, a risk band (low|medium|high|critical), risk flags, liquidity ' +
      'depth, and a buy/sell honeypot simulation (sellable + round-trip bps). Costs $0.005 USDC per ' +
      'call via x402. Use whenever the agent is about to trade or approve an unfamiliar Base token.',
    schema: z.object({
      token: z.string().describe('The ERC-20 token contract address on Base (0x…)'),
    }),
    func: async ({ token }) => {
      const v = await checkTokenSafety({ token, payerPrivateKey, baseUrl, rpcUrl });
      // Return a compact, model-friendly summary (the agent can act on risk/sellable directly).
      return JSON.stringify({
        token: v.token,
        score: v.score,
        risk: v.risk,
        sellable: v.honeypot?.sellable ?? null,
        roundTripBps: v.honeypot?.roundTripBps ?? null,
        flags: v.flags,
        liquidityUsd: v.liquidity,
        symbol: v.meta?.symbol ?? null,
      });
    },
  });
}
