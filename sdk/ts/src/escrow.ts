import type {
  Account,
  Chain,
  Hash,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem';
import { parseEventLogs } from 'viem';
import { ESCROW_ABI } from './escrow-abi.js';
import { ZERO_ADDRESS } from './chain.js';

type Pc = PublicClient<Transport, Chain>;
type Wc = WalletClient<Transport, Chain, Account>;

export * from './escrow-abi.js';

export interface MilestoneInput {
  amount: bigint;
  deadline: bigint;
  descriptionURI: string;
}

export interface CreateInput {
  seller: `0x${string}`;
  verifier?: `0x${string}`; // optional third-party dispute initiator
  arbiter?: `0x${string}`; // 0 → contract default
  feeBps: bigint;
  challengeSeconds: bigint;
  milestones: MilestoneInput[];
}

/** Global escrow states (contract enum). */
export const EscrowState = {
  Created: 0,
  Funded: 1,
  Active: 2,
  Complete: 3,
  Cancelled: 4,
} as const;

/** Per-milestone statuses (contract enum). */
export const MilestoneStatus = {
  Pending: 0,
  Submitted: 1,
  Approved: 2,
  Released: 3,
  Disputed: 4,
  Refunded: 5,
} as const;

export class EscrowClient {
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

  private async send(functionName: string, args: unknown[]): Promise<Hash> {
    const hash = await this.wc.writeContract({
      address: this.address,
      abi: ESCROW_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    });
    await this.pc.waitForTransactionReceipt({ hash });
    return hash;
  }

  private async read(functionName: string, args: unknown[]): Promise<any> {
    return this.pc.readContract({
      address: this.address,
      abi: ESCROW_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    });
  }

  /** Buyer creates an escrow; returns its id and tx hash. */
  async create(input: CreateInput): Promise<{ id: bigint; hash: Hash }> {
    const hash = await this.send('create', [
      {
        token: this.token,
        seller: input.seller,
        verifier: input.verifier ?? ZERO_ADDRESS,
        arbiter: input.arbiter ?? ZERO_ADDRESS,
        feeBps: input.feeBps,
        challengeSeconds: input.challengeSeconds,
        milestones: input.milestones.map((m) => ({
          amount: m.amount,
          deadline: m.deadline,
          descriptionURI: m.descriptionURI,
        })),
      },
    ]);
    // The escrow id comes from the EscrowCreated event in the receipt —
    // deterministic. (Reading escrowCount() right after mining can hit a
    // stale public-RPC backend that hasn't indexed the tx yet.)
    const receipt = await this.pc.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: ESCROW_ABI, logs: receipt.logs });
    const created = logs.find((l) => l.eventName === 'EscrowCreated');
    const id = (created?.args as { escrowId?: bigint } | undefined)?.escrowId;
    if (id === undefined) throw new Error('EscrowCreated event not found in create receipt');
    return { id, hash };
  }

  count(): Promise<bigint> { return this.read('escrowCount', []); }
  fund(id: bigint): Promise<Hash> { return this.send('fund', [id]); }
  start(id: bigint): Promise<Hash> { return this.send('start', [id]); }
  submit(id: bigint, index: bigint, attestationURI: string): Promise<Hash> {
    return this.send('submit', [id, index, attestationURI]);
  }
  approve(id: bigint, index: bigint): Promise<Hash> {
    return this.send('approve', [id, index]);
  }
  /** Optimistic claim: only valid after the challenge window elapses. */
  claimTimeout(id: bigint, index: bigint): Promise<Hash> {
    return this.send('claim', [id, index, 0, ZERO_BYTES32, ZERO_BYTES32, 0n]);
  }
  /** Claim inside the window using the buyer's EIP-712 approval signature. */
  claimSigned(
    id: bigint, index: bigint, v: number, r: `0x${string}`, s: `0x${string}`, sigExpiry: bigint,
  ): Promise<Hash> {
    return this.send('claim', [id, index, v, r, s, sigExpiry]);
  }
  dispute(id: bigint, index: bigint, reasonURI: string): Promise<Hash> {
    return this.send('dispute', [id, index, reasonURI]);
  }
  resolve(id: bigint, index: bigint, releaseToSeller: boolean, verdictURI: string): Promise<Hash> {
    return this.send('resolve', [id, index, releaseToSeller, verdictURI]);
  }
  expireRefund(id: bigint, index: bigint): Promise<Hash> {
    return this.send('expireRefund', [id, index]);
  }
  cancel(id: bigint): Promise<Hash> { return this.send('cancel', [id]); }

  /**
   * Multi-output reads return positional tuples in viem; we destructure to
   * named objects for callers.
   */
  async core(id: bigint) {
    const r = (await this.read('getEscrowCore', [id])) as readonly [
      `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`,
      number, number, number,
    ];
    return {
      buyer: r[0], seller: r[1], verifier: r[2], arbiter: r[3], token: r[4],
      feeBps: r[5], challengeSeconds: r[6], state: r[7],
    } as const;
  }

  async totals(id: bigint) {
    const r = (await this.read('getEscrowTotals', [id])) as readonly [
      bigint, bigint, bigint, bigint, bigint,
    ];
    return {
      totalAmount: r[0], released: r[1], refunded: r[2], feesPaid: r[3], fundedAt: r[4],
    } as const;
  }

  async milestone(id: bigint, index: bigint) {
    const r = (await this.read('getMilestone', [id, index])) as readonly [
      bigint, bigint, bigint, number, boolean,
    ];
    return {
      amount: r[0], deadline: r[1], submittedAt: r[2], status: r[3], resolvedRelease: r[4],
    } as const;
  }

  milestoneCount(id: bigint): Promise<bigint> { return this.read('milestoneCount', [id]); }

  async milestoneURIs(id: bigint, index: bigint) {
    const r = (await this.read('getMilestoneURIs', [id, index])) as readonly [string, string];
    return { descriptionURI: r[0], attestationURI: r[1] } as const;
  }
  feeConfig() {
    return Promise.all([
      this.read('minFeeBps', []),
      this.read('maxFeeBps', []),
      this.read('treasury', []),
      this.read('defaultArbiter', []),
    ]).then(([minFeeBps, maxFeeBps, treasury, defaultArbiter]) => ({
      minFeeBps, maxFeeBps, treasury, defaultArbiter,
    }));
  }

  /** All MilestoneReleased events where `payee` received a payout. */
  async releasedEventsTo(payee: `0x${string}`) {
    const logs = await this.pc.getContractEvents({
      address: this.address,
      abi: ESCROW_ABI,
      eventName: 'MilestoneReleased',
      fromBlock: 0n,
    });
    return logs.filter((l) => (l.args.payee ?? '').toLowerCase() === payee.toLowerCase());
  }
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
