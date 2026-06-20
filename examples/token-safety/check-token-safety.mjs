// check-token-safety.mjs — add on-chain rug/honeypot checks to ANY agent, pay-per-call over x402.
//
// No account, no API key, no signup. Your agent POSTs a token address, the service replies 402, your
// wallet signs a one-line USDC payment ($0.005 on Base), and you get back a structured safety verdict.
// Gas is sponsored by the facilitator — the payer wallet needs only a little USDC, no ETH.
//
//   import { checkTokenSafety } from './check-token-safety.mjs';
//   const verdict = await checkTokenSafety({ token: '0x…', payerPrivateKey: process.env.PAYER_PRIVATE_KEY });
//   if (verdict.risk === 'critical' || !verdict.honeypot?.sellable) throw new Error('unsafe token');
//
// Verdict shape: { token, meta:{name,symbol,decimals,totalSupply}, liquidity, honeypot:{sellable,
//                  roundTripBps,dex|null}, score:0-100, risk:'low'|'medium'|'high'|'critical', flags:[] }
//
// Deps: viem only.  Run directly:  PAYER_PRIVATE_KEY=0x… node check-token-safety.mjs 0x<token>
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const DEFAULT_BASE_URL = 'https://true402.dev/api';
const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

/**
 * Run the x402 token-safety check. Returns the parsed verdict JSON. Throws on payment/transport error.
 * @param {{ token: string, payerPrivateKey: string, baseUrl?: string, rpcUrl?: string }} opts
 */
export async function checkTokenSafety({ token, payerPrivateKey, baseUrl = DEFAULT_BASE_URL, rpcUrl } = {}) {
  if (!token) throw new Error('token address required');
  if (!payerPrivateKey) throw new Error('payerPrivateKey required (a Base wallet holding a little USDC)');

  const account = privateKeyToAccount(payerPrivateKey.startsWith('0x') ? payerPrivateKey : `0x${payerPrivateKey}`);
  const url = `${baseUrl}/v1/token-safety`;
  const body = JSON.stringify({ token });

  // 1. Unpaid request → 402 with payment requirements.
  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (first.status !== 402) {
    if (first.status === 200) return first.json(); // already free / cached — unlikely but harmless
    throw new Error(`expected HTTP 402, got ${first.status}: ${(await first.text()).slice(0, 200)}`);
  }
  const challenge = await first.json();
  const req = (challenge.accepts ?? challenge?.error?.accepts ?? []).find((a) => a.scheme === 'exact');
  if (!req) throw new Error('no x402 "exact" payment requirement in the 402 response');
  if (req.network !== 'eip155:8453') throw new Error(`unexpected network ${req.network} (expected Base mainnet)`);

  // 2. Sign an EIP-3009 transferWithAuthorization for the exact amount (gasless for the payer).
  const usdc = getAddress(req.asset);
  const value = BigInt(req.amount ?? req.maxAmountRequired);
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl ?? 'https://mainnet.base.org') });
  const held = await pub.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] });
  if (held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(req.payTo),
    value,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 120)),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? 'USD Coin', version: req.extra?.version ?? '2', chainId: base.id, verifyingContract: usdc },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  const xPayment = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
      network: req.network,
      payload: {
        signature,
        authorization: {
          from: authorization.from, to: authorization.to, value: value.toString(),
          validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
        },
      },
    })
  ).toString('base64');

  // 3. Retry with the payment header → the verdict.
  const paid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment }, body });
  const text = await paid.text();
  if (paid.status !== 200) throw new Error(`paid request failed (HTTP ${paid.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.argv[2] || process.env.TOKEN;
  const payerPrivateKey = process.env.PAYER_PRIVATE_KEY;
  checkTokenSafety({ token, payerPrivateKey })
    .then((v) => console.log(JSON.stringify(v, null, 2)))
    .catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
