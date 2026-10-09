import path from 'node:path';
import Fastify from 'fastify';
import { RegistryStore } from './store';
import { PostgresStore } from './pg-store';
import { makeAuth } from './auth';
import { registerRoutes } from './routes';
import { publicClient } from '@hire402/sdk';
import { pollIndexer, startIndexerLoop, type IndexerStore } from './indexer';
import { startAnchorScheduler, type AnchorSchedulerDeps } from './anchor';

/**
 * Adoption: the directory head-start (GTM §5.4). CRAWL_SEEDS is a comma-
 * separated list of agent-card URLs; each is fetched and indexed as
 * `observed` (not tradeable until self-registered). Phase 2.5.1: extend to
 * ADP DNS records and the x402 discovery extension.
 */
async function crawlSeeds(store: Pick<RegistryStore, 'agents' | 'save'>) {
  const seeds = (process.env.CRAWL_SEEDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (seeds.length === 0) return;
  let added = 0;
  for (const url of seeds) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const card = (await res.json()) as { wallet?: string; name?: string };
      if (!card.wallet || !/^0x[0-9a-fA-F]{40}$/.test(card.wallet)) continue;
      const addr = card.wallet.toLowerCase();
      const prev = store.agents.get(addr);
      if (prev?.status === 'self-registered') continue; // never downgrade
      if (prev) continue; // already observed
      store.agents.set(addr, {
        address: addr,
        agentCardUrl: url,
        status: 'observed',
        registeredAt: new Date().toISOString(),
        listings: [],
      });
      added += 1;
    } catch {
      /* unreachable seed — skip */
    }
  }
  if (added > 0) {
    store.save();
    console.log(`[crawler] indexed ${added} observed agent(s) from ${seeds.length} seed(s)`);
  }
}

/**
 * Hire402 Registry (spec §10). Machine-first, EIP-712-authenticated,
 * non-custodial: it indexes the chain; it never touches funds.
 * Chain is selected via HIRE402_CHAIN/HIRE402_RPC (see sdk chain.ts).
 */
const RPC = process.env.HIRE402_RPC ?? 'http://127.0.0.1:8545';
const ESCROW = process.env.ESCROW_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const PORT = Number(process.env.REGISTRY_PORT ?? 4010);
const DATA = process.env.REGISTRY_DATA ?? path.join('ops', 'data', 'registry.json');

async function main() {
  if (!ESCROW || !USDC) {
    console.error('ESCROW_ADDRESS and USDC_ADDRESS are required');
    process.exit(1);
  }
  const pc = publicClient(RPC);
  const chainId = BigInt(await pc.getChainId());

  // Storage: Postgres (production) or JSON file (dev/CI).
  const STORE_TYPE = process.env.REGISTRY_STORE ?? 'json';
  let store: RegistryStore | PostgresStore;
  if (STORE_TYPE === 'postgres') {
    const dbUrl = process.env.DATABASE_URL ?? '';
    if (!dbUrl) {
      console.error('REGISTRY_STORE=postgres requires DATABASE_URL');
      process.exit(1);
    }
    console.log('[store ] Postgres backend:', dbUrl.replace(/:[^:@]*@/, ':***@'));
    store = new PostgresStore(dbUrl);
    await store.load();
  } else {
    store = new RegistryStore(DATA);
    store.load();
  }
  const auth = makeAuth(chainId, store.nonces);

  const app = Fastify({ logger: false });
  // Raw string bodies: EIP-712 signatures cover keccak256(rawBody).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  // Cast to the RegistryStore shape the routes expect (same public interface).
  registerRoutes(app, { pc, usdc: USDC as `0x${string}`, escrowAddr: ESCROW as `0x${string}`, chainId, store: store as unknown as RegistryStore, auth });

  await crawlSeeds(store); // adoption: index seed endpoints as `observed`
  setInterval(() => void crawlSeeds(store), 60_000);

  // Continuous indexer: incrementally consume escrow events (production).
  // The poller runs alongside the crawler; the checkpoint survives reboots.
  // Continuous indexer: incrementally consume escrow events (production).
  // The loop back-429s against provider RPCs (INDEXER_POLL_MS cadence).
  if (store.indexerState) {
    const ESCROW_ADDR = ESCROW as `0x${string}`;
    const storeAny = store as unknown as IndexerStore;
    startIndexerLoop(pc, ESCROW_ADDR, storeAny);
    console.log('[index ] continuous indexer started');
  }

  // Reputation-root anchoring (spec §7): one Merkle root over all
  // self-registered agents' aggregates per epoch, on-chain. The chain
  // enforces the gapless epoch sequence. Enabled when ANCHOR_ADDRESS +
  // ANCHORER_KEY are set; the cadence defaults to 6h (ANCHOR_EPOCH_SECONDS).
  const ANCHOR_ADDRESS = process.env.ANCHOR_ADDRESS;
  const ANCHORER_KEY = process.env.ANCHORER_KEY;
  const ANCHOR_EPOCH_SECONDS = Number(process.env.ANCHOR_EPOCH_SECONDS ?? 21_600);
  if (ANCHOR_ADDRESS && ANCHORER_KEY) {
    startAnchorScheduler({
      pc,
      rpc: RPC,
      escrowAddr: ESCROW as `0x${string}`,
      store: store as unknown as AnchorSchedulerDeps['store'],
      anchorAddr: ANCHOR_ADDRESS as `0x${string}`,
      anchorerKey: ANCHORER_KEY as `0x${string}`,
      epochSeconds: ANCHOR_EPOCH_SECONDS,
    });
    console.log(`[anchor] scheduler started (cadence ${ANCHOR_EPOCH_SECONDS}s) → ${ANCHOR_ADDRESS}`);
  } else {
    console.log('[anchor] disabled (set ANCHOR_ADDRESS + ANCHORER_KEY to enable)');
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[registry] listening on :${PORT} (escrow=${ESCROW} usdc=${USDC} rpc=${RPC})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
