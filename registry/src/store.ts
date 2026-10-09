import fs from 'node:fs';
import path from 'node:path';

export interface AgentRecord {
  address: string; // lowercase
  agentCardUrl?: string;
  x402?: { chains?: string[]; assets?: string[] };
  status: 'self-registered' | 'observed'; // observed = crawled, not tradeable via Hire402 escrow
  registeredAt: string;
  listings: string[];
  lineage?: { parent: string; spawnedAt: string };
}

export interface ListingRecord {
  id: string;
  seller: string; // lowercase
  unit: string;
  pricing: {
    model: 'exact' | 'milestones';
    escrow?: string;
    amount?: string; // base units, for exact pricing
    milestones?: { amount: string; deadlineHours?: number }[];
  };
  sla?: Record<string, unknown>;
  createdAt: string;
}

export interface EscrowRef {
  escrowId: number;
  chainId: number;
  address: string;
  buyer: string;
  seller: string;
  registeredBy: string;
  createdAt: string;
}

export interface ReceiptRecord {
  id: string;
  payer: string;
  to: string; // the provider who received the payment
  amount: string; // base units
  txHash: string;
  service: string;
  createdAt: string;
}

/**
 * Phase 1 dev store: in-memory with a JSON snapshot on each mutation.
 * The interface is deliberately Postgres-shaped for the Phase 2 swap
 * (roadmap §2 — production persistence is a Phase 2/3 item).
 */
import type { IndexerState } from './indexer';
import { freshIndexerState } from './indexer';
import type { AnchorState } from './anchor';
import { freshAnchorState } from './anchor';

export class RegistryStore {
  agents = new Map<string, AgentRecord>();
  listings = new Map<string, ListingRecord>();
  escrows = new Map<string, EscrowRef>(); // key: `${escrowId}@${chainId}`
  receipts: ReceiptRecord[] = [];
  /** replay protection: last accepted nonce per address */
  nonces = new Map<string, bigint>();
  /** continuous indexer state: persistent checkpoint + audit trail */
  indexerState: IndexerState = freshIndexerState();
  /** reputation-root anchoring: latest anchored epoch + its committed leaves */
  anchorState: AnchorState = freshAnchorState();

  constructor(private file: string | null) {}

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const a of raw.agents ?? []) this.agents.set(a.address, a);
    for (const l of raw.listings ?? []) this.listings.set(l.id, l);
    for (const e of raw.escrows ?? []) this.escrows.set(`${e.escrowId}@${e.chainId}`, e);
    this.receipts = raw.receipts ?? [];
    for (const [k, v] of Object.entries(raw.nonces ?? {})) this.nonces.set(k, BigInt(v as string));
    if (raw.indexerState) {
      this.indexerState = raw.indexerState as IndexerState;
    }
    if (raw.anchorState) {
      this.anchorState = raw.anchorState as AnchorState;
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = {
      agents: [...this.agents.values()],
      listings: [...this.listings.values()],
      escrows: [...this.escrows.values()],
      receipts: this.receipts,
      nonces: Object.fromEntries([...this.nonces.entries()].map(([k, v]) => [k, v.toString()])),
      indexerState: this.indexerState,
      anchorState: this.anchorState,
    };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2));
  }
}
