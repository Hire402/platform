import type { Hash, PublicClient, WalletClient } from 'viem';
import { ERC20_ABI } from './erc20.js';

/**
 * x402-semantics per-call payment (Phase 1): 402 challenge → on-chain
 * transfer → retry with proof. Full x402 V2 SDK integration lands in
 * Phase 2 (roadmap §2); the wire shape here matches the exact scheme.
 */
export interface X402Challenge {
  error?: string;
  x402: {
    scheme: 'exact';
    payTo: `0x${string}`;
    amount: string; // base units of `asset`
    asset: string;
    resource?: string;
  };
}

export interface PayAndCallOpts {
  walletClient: WalletClient<import('viem').Transport, import('viem').Chain, import('viem').Account>;
  publicClient: PublicClient<import('viem').Transport, import('viem').Chain>;
  erc20: `0x${string}`;
  endpoint: string;
  body: unknown;
  /** Client-side sanity cap: refuse to pay challenges above this. */
  maxAmount: bigint;
}

export interface PayAndCallResult {
  result: Record<string, unknown>;
  txHash: Hash | null;
}

export async function payAndCall(opts: PayAndCallOpts): Promise<PayAndCallResult> {
  const bodyStr = JSON.stringify(opts.body);
  const payer = opts.walletClient.account?.address;
  if (!payer) throw new Error('wallet client has no account');

  const first = await fetch(opts.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyStr,
  });

  if (first.status !== 402) {
    if (first.ok) {
      return { result: (await first.json()) as Record<string, unknown>, txHash: null };
    }
    throw new Error(`paid call failed (no challenge): ${first.status} ${await first.text()}`);
  }

  const challenge = (await first.json()) as X402Challenge;
  const amount = BigInt(challenge.x402.amount);
  if (amount > opts.maxAmount) {
    throw new Error(`challenge amount ${amount} exceeds client cap ${opts.maxAmount}`);
  }

  const txHash = (await opts.walletClient.writeContract({
    address: opts.erc20,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [challenge.x402.payTo, amount],
    // Explicit gas: skips eth_estimateGas, which can simulate against a
    // stale public-RPC backend (recent transfers not indexed yet) and fail
    // spuriously. The real on-chain state has the funds.
    gas: 120_000n,
  })) as Hash;
  await opts.publicClient.waitForTransactionReceipt({ hash: txHash });

  const second = await fetch(opts.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-402-proof': txHash,
      'x-402-payer': payer,
    },
    body: bodyStr,
  });
  if (!second.ok) {
    throw new Error(`paid call failed after payment: ${second.status} ${await second.text()}`);
  }
  return { result: (await second.json()) as Record<string, unknown>, txHash };
}
