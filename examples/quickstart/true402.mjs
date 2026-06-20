// true402.mjs — call ANY true402 stall in one line, pay-per-call over x402. No account, no API key.
//
//   import { call } from './true402.mjs';
//   const safety = await call('/v1/token-safety', { token: '0x…' }, { payerPrivateKey: process.env.PAYER_PRIVATE_KEY });
//   const extract = await call('/v1/web-extract', { url: 'https://example.com' }, { payerPrivateKey });
//
// The payer wallet needs only USDC on Base (gas is sponsored by the facilitator — no ETH). Without a
// key, you get the 402 payment requirements back instead of paying. Deps: viem only.
//
// Discover every tool + its price live:  GET https://true402.dev/api/v1/services
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const DEFAULT_BASE = 'https://true402.dev/api';
const BAL_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];

/**
 * Call any true402 stall, paying the x402 challenge automatically.
 * @param {string} path        e.g. '/v1/token-safety', '/v1/base/address-safety', '/v1/web-extract'
 * @param {object} body        the stall's JSON input (see /v1/services for each schema)
 * @param {{ payerPrivateKey?: string, baseUrl?: string, rpcUrl?: string, maxUsd?: number }} [opts]
 * @returns {Promise<any>}     the stall's JSON result (or the 402 requirements if no key is given)
 */
export async function call(path, body, opts = {}) {
  const { payerPrivateKey, baseUrl = DEFAULT_BASE, rpcUrl, maxUsd = 0.1 } = opts;
  const url = `${baseUrl}${path}`;
  const payload = JSON.stringify(body ?? {});

  const r1 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  if (r1.status === 200) return r1.json();
  if (r1.status !== 402) throw new Error(`unexpected HTTP ${r1.status}: ${(await r1.text()).slice(0, 200)}`);

  const challenge = await r1.json();
  const req = (challenge.accepts ?? challenge?.error?.accepts ?? []).find((a) => a.scheme === 'exact');
  if (!payerPrivateKey) return challenge; // no wallet → hand back the payment requirements
  if (!req) throw new Error('no x402 "exact" requirement in the 402 response');
  if (req.network !== 'eip155:8453') throw new Error(`unexpected network ${req.network} (expected Base mainnet)`);

  const usdc = getAddress(req.asset);
  const value = BigInt(req.amount ?? req.maxAmountRequired);
  if (Number(value) / 1e6 > maxUsd) throw new Error(`price ${Number(value) / 1e6} USDC exceeds maxUsd ${maxUsd}`);

  const account = privateKeyToAccount(payerPrivateKey.startsWith('0x') ? payerPrivateKey : `0x${payerPrivateKey}`);
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl ?? 'https://mainnet.base.org') });
  const held = await pub.readContract({ address: usdc, abi: BAL_ABI, functionName: 'balanceOf', args: [account.address] });
  if (held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address, to: getAddress(req.payTo), value,
    validAfter: BigInt(now - 60), validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 120)),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? 'USD Coin', version: req.extra?.version ?? '2', chainId: base.id, verifyingContract: usdc },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization', message: authorization,
  });
  const xPayment = Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'exact', network: req.network,
    payload: { signature, authorization: {
      from: authorization.from, to: authorization.to, value: value.toString(),
      validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
    } },
  })).toString('base64');

  const r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment }, body: payload });
  const text = await r2.text();
  if (r2.status !== 200) throw new Error(`paid request failed (HTTP ${r2.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// CLI:  PAYER_PRIVATE_KEY=0x… node true402.mjs /v1/token-safety '{"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, bodyJson] = process.argv.slice(2);
  if (!path) { console.error('usage: node true402.mjs <path> [jsonBody]'); process.exit(1); }
  call(path, bodyJson ? JSON.parse(bodyJson) : {}, { payerPrivateKey: process.env.PAYER_PRIVATE_KEY })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
