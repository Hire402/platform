import type { PublicClient } from 'viem';
import { ESCROW_ABI } from '@hire402/sdk';
import { makeBackoff } from './backoff';

/**
 * THE CONTINUOUS INDEXER (production): incrementally consumes escrow events
 * from a persistent checkpoint, storing a full audit trail in the store.
 * Restart-safe: the checkpoint survives reboots.
 *
 * Replaces bounded-lookback scans: metabolic accounting and reputation read
 * from the indexed events instead of re-querying the chain — history is
 * complete regardless of RPC getLogs range caps.
 *
 * Public-RPC safety: chunked getLogs (INDEXER_CHUNK_BLOCKS, default 150 —
 * under the Base Sepolia public-RPC getLogs span cap, tightened 500 →
 * 200 blocks on 2026-10-08, with head-drift margin) with retry; reorg
 * safety via INDEXER_CONFIRMATIONS (default 3 blocks behind head).
 */

type Args = { [k: string]: unknown };

export interface IndexedEvent {
  kind: string;
  block: number;
  txHash: string;
  logIndex: number;
  args: Args;
}

export interface IndexerState {
  checkpoint: { lastBlock: string }; // stringified bigint for JSON storage
  events: IndexedEvent[]; // bounded audit trail (INDEXER_MAX_EVENTS, default 10k)
}

export function freshIndexerState(): IndexerState {
  return { checkpoint: { lastBlock: '0' }, events: [] };
}

const CHUNK_BLOCKS = BigInt(process.env.INDEXER_CHUNK_BLOCKS ?? '150');
const CONFIRMATIONS = BigInt(process.env.INDEXER_CONFIRMATIONS ?? '3');
const MAX_EVENTS = Number(process.env.INDEXER_MAX_EVENTS ?? '10000');

export interface IndexerStore {
  indexerState: IndexerState;
  save(): unknown;
}

async function fetchChunk(
  pc: PublicClient,
  escrowAddr: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<IndexedEvent[]> {
  const out: IndexedEvent[] = [];
  for (const eventName of [
    'EscrowCreated', 'EscrowFunded', 'EscrowStarted',
    'MilestoneSubmitted', 'MilestoneApproved', 'MilestoneReleased',
    'MilestoneRefunded', 'MilestoneDisputed', 'MilestoneResolved',
    'EscrowCompleted', 'EscrowCancelled',
  ] as const) {
    const logs = await pc.getContractEvents({
      address: escrowAddr,
      abi: ESCROW_ABI,
      eventName,
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const args: Args = {};
      if (log.args) {
        for (const [k, v] of Object.entries(log.args)) {
          args[k] = typeof v === 'bigint' ? v.toString() : v;
        }
      }
      out.push({
        kind: eventName,
        block: Number(log.blockNumber ?? 0),
        txHash: log.transactionHash ?? '',
        logIndex: Number(log.logIndex ?? 0),
        args,
      });
    }
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out;
}

/** Pulls new escrow events up to (head − confirmations). Idempotent. */
export async function pollIndexer(
  pc: PublicClient,
  escrowAddr: `0x${string}`,
  store: IndexerStore,
): Promise<number> {
  const state = store.indexerState;
  const lastBlock = BigInt(state.checkpoint.lastBlock || '0');
  const head = await pc.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

  if (safeHead <= lastBlock) return 0; // nothing new

  let from = lastBlock + 1n;
  let total = 0;
  while (from <= safeHead) {
    const to = from + CHUNK_BLOCKS - 1n > safeHead ? safeHead : from + CHUNK_BLOCKS - 1n;
    const events = await fetchChunk(pc, escrowAddr, from, to);
    state.events.push(...events);
    total += events.length;
    state.checkpoint.lastBlock = to.toString();
    from = to + 1n;
  }

  // Bound the audit trail (keep the latest MAX_EVENTS)
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }

  if (total > 0) {
    console.log(`[index ] ${total} new event(s) → checkpoint ${state.checkpoint.lastBlock}`);
  }
  store.save();
  return total;
}

/** Filters indexed events for a given agent address (income/payee). */
export function eventsFor(
  state: IndexerState,
  kind: string,
  filter: (args: Args) => boolean,
): IndexedEvent[] {
  return state.events.filter((e) => e.kind === kind && filter(e.args));
}

/**
 * Start the continuous poll loop with 429-aware backoff: on failure the
 * delay doubles (jittered) up to a ceiling, on the first success the loop
 * returns to its normal cadence. Provider RPCs rate-limit sustained
 * polling — a plain setInterval would spin into a 429 storm.
 */
export function startIndexerLoop(
  pc: PublicClient,
  escrowAddr: `0x${string}`,
  store: IndexerStore,
  pollMs: number = Number(process.env.INDEXER_POLL_MS ?? '5000'),
): void {
  const backoff = makeBackoff(pollMs, Math.max(pollMs * 12, 60_000));
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let wait = pollMs;
    try {
      await pollIndexer(pc, escrowAddr, store);
      wait = backoff.success();
    } catch (e) {
      wait = backoff.fail();
      console.error(`[index ] poll error — retrying in ${Math.round(wait / 1000)}s:`, String(e));
    }
    setTimeout(() => void tick(), wait);
  };

  void tick(); // boot-time catch-up
}
