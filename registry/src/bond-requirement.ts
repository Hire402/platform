import type { RegistryStore } from './store';
import type { ListingRecord } from './store';
import type { IndexerState, IndexedEvent } from './indexer';

/**
 * BOND REQUIREMENT (spec §8, normative) — registry-side decay.
 *
 *   base     = max($500-equiv, 2 × median price of the agent's listed units)
 *   decay    = LINEAR: −3.6% of the INITIAL requirement per clean completed
 *              job → exactly the 10% floor after 25 clean jobs
 *              (0.036 × 25 = 0.90)
 *   clean    = a MilestoneReleased to the agent on a milestone that was
 *              never disputed; a dispute against the agent's milestone
 *              RESETS the counter to zero (a released-but-disputed
 *              milestone is not clean)
 *
 * Fully event-sourced off the continuous indexer's audit trail — no chain
 * reads, no getLogs range caps. No trail (fresh registry) ⇒ full
 * requirement: no history, no discount (conservative default).
 */

const MIN_BOND_USDC = BigInt(process.env.BOND_MIN_USDC ?? '500000000'); // $500-equiv, 6dp
const DECAY_BPS_PER_JOB = 360n; // −3.6% of the initial requirement per clean job
const FLOOR_BPS = 1000n;        // 10% of initial
const FULL_BPS = 10_000n;

export interface BondRequirement {
  address: string;
  base: string;                 // 6dp USDC (stringified bigint)
  minBondUsdc: string;
  medianUnitPrice: string;
  listingsCounted: number;
  cleanJobs: number;
  decayBps: string;
  requiredBond: string;
  floorHit: boolean;
  note: string;
}

/** A listing's unit price: exact pricing, else the sum of its milestones. */
function unitPrice(l: ListingRecord): bigint | null {
  if (l.pricing.amount) {
    const v = BigInt(l.pricing.amount);
    return v > 0n ? v : null;
  }
  if (l.pricing.milestones?.length) {
    const total = l.pricing.milestones.reduce((acc, m) => acc + BigInt(m.amount), 0n);
    return total > 0n ? total : null;
  }
  return null;
}

function median(prices: bigint[]): bigint {
  if (prices.length === 0) return 0n;
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Clean completed jobs from the indexed event trail (sorted by block/logIndex).
 * Disputes reset; disputed releases don't count. Single forward pass.
 */
export function cleanJobsFromTrail(state: IndexerState, address: string): number {
  const addr = address.toLowerCase();
  const sellerOf = new Map<string, string>(); // escrowId → seller (lowercase)
  const disputed = new Set<string>();         // "escrowId:index"
  let clean = 0;
  for (const ev of state.events as IndexedEvent[]) {
    if (ev.kind === 'EscrowCreated') {
      sellerOf.set(String(ev.args.escrowId), String(ev.args.seller ?? '').toLowerCase());
    } else if (ev.kind === 'MilestoneDisputed') {
      const id = String(ev.args.escrowId);
      disputed.add(`${id}:${String(ev.args.index)}`);
      if (sellerOf.get(id) === addr) clean = 0; // disputes reset the counter
    } else if (ev.kind === 'MilestoneReleased') {
      if (String(ev.args.payee ?? '').toLowerCase() !== addr) continue;
      if (disputed.has(`${String(ev.args.escrowId)}:${String(ev.args.index)}`)) continue;
      clean += 1;
    }
  }
  return clean;
}

/** The staking requirement for a listed agent (spec §8). */
export function computeBondRequirement(store: RegistryStore, address: string): BondRequirement {
  const addr = address.toLowerCase();

  // median price of the agent's listed units
  const prices: bigint[] = [];
  for (const l of store.listings.values()) {
    if (l.seller !== addr) continue;
    const p = unitPrice(l);
    if (p !== null) prices.push(p);
  }
  const medianPrice = median(prices);
  const base = medianPrice * 2n > MIN_BOND_USDC ? medianPrice * 2n : MIN_BOND_USDC;

  // clean jobs from the indexer's audit trail
  const indexer = (store as { indexerState?: IndexerState }).indexerState;
  let cleanJobs = 0;
  let note = 'linear −3.6% of the initial requirement per clean job; 10% floor after 25 clean jobs; disputes reset the counter (spec §8)';
  if (!indexer || indexer.events.length === 0) {
    note = 'no indexed history yet — full requirement (no history, no discount)';
  } else {
    cleanJobs = cleanJobsFromTrail(indexer, addr);
  }

  let decayBps = FULL_BPS - DECAY_BPS_PER_JOB * BigInt(cleanJobs);
  let floorHit = false;
  if (decayBps <= FLOOR_BPS) {
    // At 25 clean jobs the decay LANDS exactly on the floor; beyond that the
    // clamp holds it there. Either way the requirement is at the floor.
    decayBps = FLOOR_BPS;
    floorHit = true;
  }
  const requiredBond = (base * decayBps) / FULL_BPS;

  return {
    address: addr,
    base: base.toString(),
    minBondUsdc: MIN_BOND_USDC.toString(),
    medianUnitPrice: medianPrice.toString(),
    listingsCounted: prices.length,
    cleanJobs,
    decayBps: decayBps.toString(),
    requiredBond: requiredBond.toString(),
    floorHit,
    note,
  };
}
