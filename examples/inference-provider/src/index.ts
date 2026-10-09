import Fastify from 'fastify';
import { decodeEventLog } from 'viem';
import {
  ANVIL_RPC,
  DEV,
  ERC20_ABI,
  RegistryClient,
  balanceOf,
  publicClient,
  walletClient,
} from '@hire402/sdk';

type Pc = ReturnType<typeof publicClient>;
type Wc = ReturnType<typeof walletClient>;

/**
 * Metered inference provider (x402-semantics): 402 challenge → on-chain
 * USDC transfer → retry with proof. Verifies the payment on-chain before
 * serving, then posts a signed burn receipt to the registry (the agent's
 * "metabolism" record). Full x402 V2 SDK lands in Phase 2.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const USDC = process.env.USDC_ADDRESS;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const PORT = Number(process.env.PORT ?? 4210);
const PRICE = BigInt(process.env.INFER_PRICE ?? '800000'); // 0.80 USDC
const PROVIDER_KEY = process.env.PROVIDER_KEY ?? DEV.provider;

let pc: Pc;
let wc: Wc;
let registry: RegistryClient;

/** Verifies the x402 payment proof on-chain; returns diagnostics on failure. */
async function verifyPayment(txHash: string, payer: string): Promise<{ ok: boolean; detail: string }> {
  // Public-RPC backends can lag behind the mempool — retry the receipt read.
  let receipt: Awaited<ReturnType<typeof pc.getTransactionReceipt>> | undefined;
  for (let i = 0; i < 8; i++) {
    try {
      receipt = await pc.getTransactionReceipt({ hash: txHash as `0x${string}` });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!receipt) {
    return { ok: false, detail: `tx ${txHash} receipt not visible yet` };
  }
  if (receipt.status !== 'success') {
    return { ok: false, detail: `tx ${txHash} status=${receipt.status}` };
  }
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== USDC?.toLowerCase()) continue;
    try {
      const d = decodeEventLog({
        abi: ERC20_ABI,
        data: l.data,
        topics: l.topics as [] | [`0x${string}`, ...`0x${string}`[]],
      });
      if (d.eventName !== 'Transfer') continue;
      const args = d.args as { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
      if (
        args.from?.toLowerCase() === payer.toLowerCase() &&
        args.to?.toLowerCase() === wc.account?.address.toLowerCase() &&
        args.value === PRICE
      ) {
        return { ok: true, detail: 'verified' };
      }
      return {
        ok: false,
        detail: `Transfer mismatch: from=${args.from} (want ${payer}), to=${args.to} (want ${wc.account?.address}), value=${args.value} (want ${PRICE})`,
      };
    } catch (e) {
      return { ok: false, detail: `decode error: ${String(e)}` };
    }
  }
  return {
    ok: false,
    detail: `no USDC Transfer log in receipt (logs=${receipt.logs.length}, usdc=${USDC})`,
  };
}

async function main() {
  if (!USDC) {
    console.error('USDC_ADDRESS is required');
    process.exit(1);
  }
  pc = publicClient(RPC);
  wc = walletClient(PROVIDER_KEY as `0x${string}`, RPC);
  registry = new RegistryClient(REGISTRY_URL, wc, pc);
  const providerAddress = wc.account!.address;

  const startBalance = await balanceOf(pc, USDC as `0x${string}`, providerAddress);
  console.log(`[provider] I am ${providerAddress} — starting USDC balance: ${startBalance}`);

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, agent: 'inference-provider' }));

  app.get('/wallet', async () => ({
    address: providerAddress,
    usdcBalance: (await balanceOf(pc, USDC as `0x${string}`, providerAddress)).toString(),
  }));

  app.post('/v1/infer', async (req, reply) => {
    const body = (req.body ?? {}) as { prompt?: string };
    const prompt = body.prompt ?? '';
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const proof = Array.isArray(headers['x-402-proof']) ? headers['x-402-proof'][0] : headers['x-402-proof'];
    const payer = Array.isArray(headers['x-402-payer']) ? headers['x-402-payer'][0] : headers['x-402-payer'];

    if (!proof || !payer) {
      // 402 challenge — the x402-semantics payment flow.
      return reply.code(402).send({
        error: 'payment required',
        x402: {
          scheme: 'exact',
          payTo: providerAddress,
          amount: PRICE.toString(),
          asset: 'USDC',
          resource: '/v1/infer',
        },
      });
    }

    const verdict = await verifyPayment(proof, payer);
    if (!verdict.ok) {
      console.error(`[provider] payment proof rejected: ${verdict.detail}`);
      return reply.code(402).send({ error: 'payment proof does not verify on-chain', detail: verdict.detail });
    }

    // Serve the (mock) inference. A `--live-llm` flag may replace this.
    const result = {
      model: 'mock-small',
      result: `[mock inference] synthesis for: ${prompt}`,
      usage: { promptTokens: prompt.length * 2, completionTokens: 42 },
    };

    // Record the payer's burn (metabolism) — signed by me, verified by the
    // registry against the chain.
    void registry
      .post('/v1/receipts', {
        payer,
        amount: PRICE.toString(),
        txHash: proof,
        service: 'inference',
      })
      .catch((e) => console.error('[provider] receipt post failed:', String(e)));

    return result;
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[provider] listening on :${PORT} — ${PRICE} (6dp USDC) per inference`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
