import type { PublicClient } from 'viem';
import {
  ERC20_ABI,
  ESCROW_ABI,
  EscrowState,
  MilestoneStatus,
  balanceOf,
} from '@hire402/sdk';
import type { RegistryStore } from './store';

export interface MetabolicAccount {
  address: string;
  liquid: string;
  escrowedReceivables: string;
  incomeNet: string;
  incomeGross: string;
  burn: string;
  net: string;
  runwayDays: number | null;
  runwayNote: string;
  status: 'solvent' | 'strained' | 'critical' | 'insolvent' | 'unknown';
}

import type { IndexerState } from './indexer';

const DAY_MS = 86_400_000;
const s = (n: bigint) => n.toString();

/**
 * Public RPCs reject eth_getLogs from genesis and cap the block span
 * (Base Sepolia public RPC: tightened 500 → 200 blocks on 2026-10-08),
 * so event scans use a bounded lookback well under the cap — default
 * 150 blocks ≈ 5 minutes on Base Sepolia, leaving ~50 blocks of
 * head-drift margin between the getBlockNumber anchor and the getLogs
 * call (configurable via HIRE402_INDEX_LOOKBACK). The continuous
 * indexer's audit trail supersedes these scans once established.
 */
async function scanFrom(pc: PublicClient): Promise<bigint> {
  const lookback = BigInt(process.env.HIRE402_INDEX_LOOKBACK ?? '150');
  const latest = await pc.getBlockNumber();
  return latest > lookback ? latest - lookback : 0n;
}

/**
 * Metabolic accounting per spec §7. Event-sourced: income derives from
 * on-chain MilestoneReleased events; burn from provider-signed,
 * chain-verified receipts; liquid from the token balance; receivables
 * from live escrow state.
 */
export async function computeMetabolic(
  pc: PublicClient,
  usdc: `0x${string}`,
  escrowAddr: `0x${string}`,
  store: RegistryStore,
  address: string,
): Promise<MetabolicAccount> {
  const addr = address.toLowerCase();

  // income (net of fee = realized; gross = payout + fee) — from the indexed
  // event trail (store.indexerState) when the indexer is active; falls back
  // to bounded-lookback chain scans otherwise.
  const indexer: IndexerState | undefined = (store as { indexerState?: IndexerState }).indexerState;
  let incomeNet = 0n;
  let incomeGross = 0n;
  let releasedJobs = 0;

  if (indexer && indexer.events.length > 0) {
    // Indexed mode: read from the audit trail (no getLogs → no range caps).
    for (const ev of indexer.events) {
      if (ev.kind !== 'MilestoneReleased') continue;
      if (String(ev.args.payee ?? '').toLowerCase() !== addr) continue;
      incomeNet += BigInt(String(ev.args.payout ?? '0'));
      incomeGross += BigInt(String(ev.args.payout ?? '0')) + BigInt(String(ev.args.fee ?? '0'));
      releasedJobs += 1;
    }
  } else {
    // Fallback mode (no indexer trail): bounded chain scan (spec §5.6).
    const fromBlock = await scanFrom(pc);
    for (const ref of store.escrows.values()) {
      const released = await pc.getContractEvents({
        address: escrowAddr,
        abi: ESCROW_ABI,
        eventName: 'MilestoneReleased',
        args: { escrowId: BigInt(ref.escrowId) },
        fromBlock,
      });
      for (const l of released) {
        if ((l.args.payee ?? '').toLowerCase() !== addr) continue;
        incomeNet += l.args.payout ?? 0n;
        incomeGross += (l.args.payout ?? 0n) + (l.args.fee ?? 0n);
        releasedJobs += 1;
      }
    }
  }

  const burns = store.receipts.filter((r) => r.payer.toLowerCase() === addr);
  const burn = burns.reduce((acc, r) => acc + BigInt(r.amount), 0n);
  const liquid = await balanceOf(pc, usdc, address as `0x${string}`);

  // escrowed receivables from the agent's live escrows
  let receivables = 0n;
  for (const ref of store.escrows.values()) {
    if (ref.seller.toLowerCase() !== addr) continue;
    const id = BigInt(ref.escrowId);
    // getEscrowCore returns a positional tuple:
    // [buyer, seller, verifier, arbiter, token, feeBps, challengeSeconds, state]
    const core = await pc.readContract({
      address: escrowAddr, abi: ESCROW_ABI, functionName: 'getEscrowCore', args: [id],
    });
    const escrowState = Number(core[7]);
    if (escrowState !== EscrowState.Active) continue;
    const count = await pc.readContract({
      address: escrowAddr, abi: ESCROW_ABI, functionName: 'milestoneCount', args: [id],
    });
    for (let i = 0n; i < count; i++) {
      // getMilestone returns: [amount, deadline, submittedAt, status, resolvedRelease]
      const m = await pc.readContract({
        address: escrowAddr, abi: ESCROW_ABI, functionName: 'getMilestone', args: [id, i],
      });
      const st = Number(m[3]);
      if (
        st === MilestoneStatus.Pending ||
        st === MilestoneStatus.Submitted ||
        st === MilestoneStatus.Disputed
      ) {
        receivables += m[0];
      }
    }
  }

  // solvency — spec §7 with the early-solvency rule: a daily burn rate is
  // only meaningful with ≥ 2 burn observations spanning ≥ 24h. Below that,
  // classify by net cash flow (net ≥ 0 with income ⇒ solvent).
  const net = incomeNet - burn;
  let status: MetabolicAccount['status'];
  let runwayDays: number | null = null;
  let runwayNote: string;
  const burnsSorted = [...burns].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const spanMs =
    burnsSorted.length >= 2
      ? Date.parse(burnsSorted[burnsSorted.length - 1].createdAt) - Date.parse(burnsSorted[0].createdAt)
      : 0;
  if (burnsSorted.length < 2 || spanMs < DAY_MS) {
    if (releasedJobs === 0 && burnsSorted.length === 0) {
      status = 'unknown';
      runwayNote = 'no economic activity yet';
    } else {
      status = net > 0n ? 'solvent' : 'strained';
      runwayNote =
        burnsSorted.length < 2
          ? 'early-solvency rule (insufficient burn history)'
          : 'early-solvency rule (burn history spans < 24h)';
    }
  } else {
    const spanDays = Math.max(1, spanMs / DAY_MS);
    const dailyRate = burn / BigInt(Math.ceil(spanDays));
    runwayDays = dailyRate > 0n ? Number((liquid + receivables) / dailyRate) : null;
    status =
      runwayDays !== null && runwayDays >= 90 ? 'solvent'
      : runwayDays !== null && runwayDays >= 30 ? 'strained'
      : runwayDays !== null && runwayDays >= 7 ? 'critical'
      : 'insolvent';
    runwayNote = `runway @ ${dailyRate.toString()}/day over ${Math.ceil(spanDays)}d window`;
  }

  return {
    address: addr,
    liquid: s(liquid),
    escrowedReceivables: s(receivables),
    incomeNet: s(incomeNet),
    incomeGross: s(incomeGross),
    burn: s(burn),
    net: s(net),
    runwayDays,
    runwayNote,
    status,
  };
}

export async function computeReputation(
  pc: PublicClient,
  escrowAddr: `0x${string}`,
  store: RegistryStore,
  address: string,
) {
  const addr = address.toLowerCase();
  let completed = 0;
  let disputes = 0;

  // Event-sourced (spec §7: the chain is the source of truth). Indexed mode
  // reads the continuous indexer's full audit trail — no getLogs range caps
  // and no escrow registration required; fallback scans registered escrows.
  const indexer: IndexerState | undefined = (store as { indexerState?: IndexerState }).indexerState;
  if (indexer && indexer.events.length > 0) {
    const sellerOf = new Map<string, string>(); // escrowId → seller
    for (const ev of indexer.events) {
      if (ev.kind === 'EscrowCreated') {
        sellerOf.set(String(ev.args.escrowId), String(ev.args.seller ?? '').toLowerCase());
      }
    }
    for (const ev of indexer.events) {
      if (ev.kind === 'MilestoneReleased' && String(ev.args.payee ?? '').toLowerCase() === addr) {
        completed += 1;
      } else if (ev.kind === 'MilestoneDisputed'
        && sellerOf.get(String(ev.args.escrowId)) === addr) {
        disputes += 1;
      }
    }
  } else {
    const fromBlock = await scanFrom(pc);
    for (const ref of store.escrows.values()) {
      if (ref.seller.toLowerCase() !== addr) continue;
      const released = await pc.getContractEvents({
        address: escrowAddr, abi: ESCROW_ABI, eventName: 'MilestoneReleased',
        args: { escrowId: BigInt(ref.escrowId) }, fromBlock,
      });
      completed += released.filter(
        (l) => (l.args.payee ?? '').toLowerCase() === addr,
      ).length;
      const disputed = await pc.getContractEvents({
        address: escrowAddr, abi: ESCROW_ABI, eventName: 'MilestoneDisputed',
        args: { escrowId: BigInt(ref.escrowId) }, fromBlock,
      });
      disputes += disputed.length;
    }
  }
  return {
    address: addr,
    completedJobs: completed,
    disputedJobs: disputes,
    slashed: '0', // Phase 2: BondVault events feed this
    slaHitRate: completed > 0 ? (completed - disputes) / completed : null,
    // Bond decay (spec §8): required bond decays 3.6% per clean completed
    // job toward a 10% floor — history replaces collateral.
    bondDecay: {
      initialBond: (process.env.BOND_INITIAL ?? '1000000').toString(),
      requiredBond: decay(completed, disputes, BigInt(process.env.BOND_INITIAL ?? '1000000')).toString(),
      note: 'decays 3.6%/clean job, floor 10% of initial; disputes reset progress',
    },
  };
}

function decay(completed: number, disputes: number, initial: bigint): bigint {
  const floor = (initial * 10n) / 100n;
  if (disputes > 0 || completed === 0) return initial;
  let required = initial;
  for (let i = 0; i < completed; i++) {
    required = (required * 9_640n) / 10_000n; // −3.6% per clean job
    if (required <= floor) return floor;
  }
  return required;
}

export { ERC20_ABI };
