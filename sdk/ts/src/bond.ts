import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from 'viem';
import { BOND_ABI } from './bond-abi.js';
import { ZERO_ADDRESS } from './chain.js';

type Pc = PublicClient<Transport, Chain>;
type Wc = WalletClient<Transport, Chain, Account>;

export * from './bond-abi.js';

/**
 * BondVault client (spec §8). All writes use explicit gas: bond calls often
 * target a just-deployed vault, and stale public-RPC estimates against
 * fresh contracts produce out-of-gas reverts (see docs/spec-pins.md).
 */
export class BondClient {
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
      abi: BOND_ABI,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
      gas,
    });
    await this.pc.waitForTransactionReceipt({ hash });
    return hash;
  }

  stake(amount: bigint): Promise<Hash> { return this.send('stake', [amount], 120_000n); }
  unstake(amount: bigint): Promise<Hash> { return this.send('unstake', [amount], 120_000n); }
  slash(verifier: `0x${string}`, beneficiary: `0x${string}`, amount: bigint, reason: string): Promise<Hash> {
    return this.send('slash', [verifier, beneficiary, amount, reason], 150_000n);
  }
  setSlasher(who: `0x${string}`, allowed: boolean): Promise<Hash> {
    return this.send('setSlasher', [who, allowed], 100_000n);
  }

  stakeOf(verifier: `0x${string}`): Promise<bigint> {
    return this.pc.readContract({
      address: this.address, abi: BOND_ABI, functionName: 'stakeOf', args: [verifier],
    });
  }
  slasherOf(who: `0x${string}`): Promise<boolean> {
    return this.pc.readContract({
      address: this.address, abi: BOND_ABI, functionName: 'slasher', args: [who],
    });
  }
  totals(): Promise<{ totalStaked: bigint; totalSlashed: bigint }> {
    return Promise.all([
      this.pc.readContract({ address: this.address, abi: BOND_ABI, functionName: 'totalStaked' }),
      this.pc.readContract({ address: this.address, abi: BOND_ABI, functionName: 'totalSlashed' }),
    ]).then(([totalStaked, totalSlashed]) => ({ totalStaked, totalSlashed }));
  }
}

export { ZERO_ADDRESS };
