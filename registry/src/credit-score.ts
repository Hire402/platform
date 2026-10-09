import type { PublicClient } from 'viem';
import { ESCROW_ABI } from '@hire402/sdk';
import type { RegistryStore } from './store';
import type { IndexerState } from './indexer';
import { computeMetabolic } from './metabolic';

/**
 * CREDIT SCORE (spec §8, normative implementation — the published formula).
 *
 *   repayment  40%  released-to-agent ÷ (released + refunded)   — did the
 *                    agent make counterparties whole?
 *   SLA        25%  on-time submissions ÷ submissions          — submitted
 *                    at or before the milestone deadline (chain time)
 *   dispute    20%  undisputed releases ÷ releases              — disputed
 *                    releases drag this to zero
 *   runway     15%  metabolic status (§7): solvent 100%, strained 66%,
 *                    critical 33%, insolvent 0%, unknown 50%
 *
 *   scoreBps = (40·repayBps + 25·slaBps + 20·disputeBps + 15·runwayBps)/100
 *   score    = 300 + scoreBps·550/10000   → 300–850
 *
 * Every component is computed from on-chain events/state (the indexer's
 * audit trail + live milestone reads) — agents can predict their own
 * credit. A component with NO observations is NEUTRAL (50%) so a
 * no-history agent scores 575 — above the ≥ 500 advance gate, because a
 * first advance must be obtainable; the desk still prices APR by policy.
 * All arithmetic is integer (bps) — fully deterministic.
 */

const NEUTRAL_BPS = 5000;
const ADVANCE_GATE = 500;

const RUNWAY_BPS: Record<string, number> = {
  solvent: 10_000,
  strained: 6_600,
  critical: 3_300,
  insolvent: 0,
  unknown: 5_000,
};

export interface CreditScore {
  address: string;
  score: number;
  qualifiesForAdvance: boolean;
  advanceGate: number;
  components: {
    repaymentBps: number;
    slaBps: number;
    disputeBps: number;
    runwayBps: number;
  };
  observations: {
    released: number;
    refunded: number;
    submitted: number;
    onTimeSubmissions: number;
    disputedReleases: number;
    runwayStatus: string;
  };
  formula: string;
  note: string;
}

export async function computeCreditScore(
  pc: PublicClient,
  usdc: `0x${string}`,
  escrowAddr: `0x${string}`,
  store: RegistryStore,
  address: string,
): Promise<CreditScore> {
  const addr = address.toLowerCase();
  const indexer: IndexerState | undefined = (store as { indexerState?: IndexerState }).indexerState;

  let released = 0;
  let refunded = 0;
  let disputedReleases = 0;
  const myEscrows: bigint[] = [];

  if (indexer && indexer.events.length > 0) {
    const sellerOf = new Map<string, string>(); // escrowId → seller
    const disputed = new Set<string>();         // "escrowId:index"
    for (const ev of indexer.events) {
      if (ev.kind === 'EscrowCreated') {
        const seller = String(ev.args.seller ?? '').toLowerCase();
        sellerOf.set(String(ev.args.escrowId), seller);
        if (seller === addr) myEscrows.push(BigInt(String(ev.args.escrowId)));
      }
    }
    for (const ev of indexer.events) {
      const id = String(ev.args.escrowId);
      const key = `${id}:${String(ev.args.index)}`;
      if (ev.kind === 'MilestoneReleased') {
        if (String(ev.args.payee ?? '').toLowerCase() !== addr) continue;
        released += 1;
        if (disputed.has(key)) disputedReleases += 1;
      } else if (ev.kind === 'MilestoneRefunded') {
        if (sellerOf.get(id) === addr) refunded += 1;
      } else if (ev.kind === 'MilestoneDisputed') {
        disputed.add(key);
      }
    }
  }

  // SLA: milestone state (deadline vs submittedAt — both chain timestamps).
  let submitted = 0;
  let onTime = 0;
  for (const id of myEscrows) {
    const count = (await pc.readContract({
      address: escrowAddr, abi: ESCROW_ABI, functionName: 'milestoneCount', args: [id],
    })) as bigint;
    for (let i = 0n; i < count; i++) {
      // getMilestone → [amount, deadline, submittedAt, status, resolvedRelease]
      const m = (await pc.readContract({
        address: escrowAddr, abi: ESCROW_ABI, functionName: 'getMilestone', args: [id, i],
      })) as readonly [bigint, bigint, bigint, number, boolean];
      if (m[2] === 0n) continue; // never submitted
      submitted += 1;
      if (m[1] === 0n || m[2] <= m[1]) onTime += 1; // no deadline, or met it
    }
  }

  // Runway (spec §7 metabolic status).
  const metabolic = await computeMetabolic(pc, usdc, escrowAddr, store, addr);
  const runwayBps = RUNWAY_BPS[metabolic.status] ?? NEUTRAL_BPS;

  // Published formula — neutral components for missing history.
  const repayBps = released + refunded === 0 ? NEUTRAL_BPS : Math.floor((released * 10_000) / (released + refunded));
  const slaBps = submitted === 0 ? NEUTRAL_BPS : Math.floor((onTime * 10_000) / submitted);
  const disputeBps = released === 0 ? NEUTRAL_BPS : Math.floor(((released - disputedReleases) * 10_000) / released);

  const scoreBps = Math.floor((40 * repayBps + 25 * slaBps + 20 * disputeBps + 15 * runwayBps) / 100);
  const score = 300 + Math.floor((scoreBps * 550) / 10_000);

  return {
    address: addr,
    score,
    qualifiesForAdvance: score >= ADVANCE_GATE,
    advanceGate: ADVANCE_GATE,
    components: { repaymentBps: repayBps, slaBps, disputeBps, runwayBps },
    observations: {
      released,
      refunded,
      submitted,
      onTimeSubmissions: onTime,
      disputedReleases,
      runwayStatus: metabolic.status,
    },
    formula: 'scoreBps = (40·repayment + 25·SLA + 20·dispute + 15·runway)/100; score = 300 + scoreBps·550/10000 (300–850); repayment = released/(released+refunded); SLA = onTime/submitted; dispute = undisputedReleases/released; runway: solvent 100%/strained 66%/critical 33%/insolvent 0%/unknown 50%; no-observation components are neutral 50%',
    note: 'all inputs on-chain (indexer audit trail + milestone state + §7 metabolic); advances require score ≥ 500',
  };
}
