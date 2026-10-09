import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from 'viem';
import { ADVANCED_ESCROW_ABI } from './desk-abi.js';

type Pc = PublicClient<Transport, Chain>;
type Wc = WalletClient<Transport, Chain, Account>;

export * from './desk-abi.js';

/** Split a 65-byte ECDSA signature (r||s||v) into (v, r, s) with v ∈ {27, 28}. */
export function splitSignature(sig: `0x${string}`): { v: number; r: `0x${string}`; s: `0x${string}` } {
  if (sig.length !== 132) throw new Error(`bad signature length ${sig.length} (want 132 hex chars)`);
  const r = sig.slice(0, 66) as `0x${string}`;
  const s = ('0x' + sig.slice(66, 130)) as `0x${string}`;
  let v = parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27; // some signers emit 0/1
  if (v !== 27 && v !== 28) throw new Error(`bad recovery id ${v}`);
  return { v, r, s };
}

/**
 * AdvanceClient (spec §8 Advances): the seller-side surface of the capital
 * desk rail. All writes use explicit gas — stale public-RPC estimates
 * against fresh contracts produce out-of-gas reverts (docs/spec-pins.md).
 */
export class AdvanceClient {
  constructor(
    private pc: Pc,
    private wc: Wc,
    public address: `0x${string}`,
    public token: `0x${string}`,
  ) {}

  get account(): `0x${string}` {
    if (!this.wc.account) throw new Error('wallet client has no account');
    return this.wc.account.address;
  }

  private async send(functionName: string, args: unknown[], gas: bigint): Promise<Hash> {
    const hash = await this.wc.writeContract({
      address: this.address,
      abi: ADVANCED_ESCROW_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
      gas,
    });
    await this.pc.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Seller accepts the desk's signed AdvanceOffer. */
  acceptAdvance(
    escrowId: bigint,
    principal: bigint,
    aprBps: number,
    offerExpiry: bigint,
    signature: `0x${string}`,
  ): Promise<Hash> {
    const { v, r, s } = splitSignature(signature);
    return this.send('acceptAdvance', [escrowId, principal, aprBps, offerExpiry, v, r, s], 250_000n);
  }

  /** Voluntary direct repayment (capped at live debt by the contract). */
  repayAdvance(escrowId: bigint, amount: bigint): Promise<Hash> {
    return this.send('repayAdvance', [escrowId, amount], 200_000n);
  }

  desk(): Promise<`0x${string}`> {
    return this.pc.readContract({ address: this.address, abi: ADVANCED_ESCROW_ABI, functionName: 'desk' });
  }
  advanceDebt(escrowId: bigint): Promise<bigint> {
    return this.pc.readContract({ address: this.address, abi: ADVANCED_ESCROW_ABI, functionName: 'advanceDebt', args: [escrowId] });
  }
  remainingReceivables(escrowId: bigint): Promise<bigint> {
    return this.pc.readContract({ address: this.address, abi: ADVANCED_ESCROW_ABI, functionName: 'remainingReceivables', args: [escrowId] });
  }

  async advance(escrowId: bigint) {
    const r = (await this.pc.readContract({
      address: this.address, abi: ADVANCED_ESCROW_ABI, functionName: 'getAdvance', args: [escrowId],
    })) as readonly [bigint, number, bigint, bigint, bigint];
    return {
      principal: r[0], aprBps: r[1], accruedInterestNow: r[2], lastAccrual: r[3], totalRepaid: r[4],
    } as const;
  }

  /** Offer digest as computed on-chain — for desk-side verification/tests. */
  advanceOfferDigest(
    escrowId: bigint,
    seller: `0x${string}`,
    principal: bigint,
    aprBps: number,
    offerExpiry: bigint,
  ): Promise<`0x${string}`> {
    return this.pc.readContract({
      address: this.address, abi: ADVANCED_ESCROW_ABI, functionName: 'advanceOfferDigest',
      args: [escrowId, seller, principal, aprBps, offerExpiry],
    });
  }
}
