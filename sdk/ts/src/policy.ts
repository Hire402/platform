/**
 * Buyer-side spending policies (spec §10, roadmap Phase 2): ADVISORY caps
 * enforced in the SDK before an agent commits money to an escrow. They live
 * in process memory — they reset on restart, and a buggy or prompt-injected
 * agent can skip them. Contract-side, funds are only ever committed
 * per-escrow — the policy bounds cumulative spend. On-chain enforcement (a
 * budget guard the account holder controls, not the agent) is the roadmap
 * item that closes this gap.
 */
export interface PolicyCaps {
  /** Max cumulative spend toward a single counterparty (base units). */
  perCounterparty?: bigint;
  /** Max spend per UTC day (base units). */
  perDay?: bigint;
  /** Max cumulative spend overall (base units). */
  total?: bigint;
}

export class SpendingPolicy {
  private byCounterparty = new Map<string, bigint>();
  private currentDay = new Date().toISOString().slice(0, 10);
  private spentToday = 0n;
  private spentTotal = 0n;

  constructor(private caps: PolicyCaps) {}

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.spentToday = 0n;
    }
  }

  /** Records the spend if it fits the caps; throws with a clear reason otherwise. */
  checkAndRecord(counterparty: string, amount: bigint): void {
    this.rollDay();
    const label = counterparty.toLowerCase();
    const spentCp = this.byCounterparty.get(label) ?? 0n;
    if (this.caps.perCounterparty !== undefined && spentCp + amount > this.caps.perCounterparty) {
      throw new Error(
        `spending policy: per-counterparty cap exceeded (${(spentCp + amount).toString()} > ${this.caps.perCounterparty.toString()})`,
      );
    }
    if (this.caps.perDay !== undefined && this.spentToday + amount > this.caps.perDay) {
      throw new Error(
        `spending policy: daily cap exceeded (${(this.spentToday + amount).toString()} > ${this.caps.perDay.toString()})`,
      );
    }
    if (this.caps.total !== undefined && this.spentTotal + amount > this.caps.total) {
      throw new Error(
        `spending policy: total cap exceeded (${(this.spentTotal + amount).toString()} > ${this.caps.total.toString()})`,
      );
    }
    this.byCounterparty.set(label, spentCp + amount);
    this.spentToday += amount;
    this.spentTotal += amount;
  }

  spentFor(counterparty: string): bigint {
    return this.byCounterparty.get(counterparty.toLowerCase()) ?? 0n;
  }
  spentTodayValue(): bigint { this.rollDay(); return this.spentToday; }
  totalSpent(): bigint { return this.spentTotal; }
}
