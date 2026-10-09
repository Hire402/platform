import { Pool } from 'pg';
import type { AgentRecord, ListingRecord, EscrowRef, ReceiptRecord } from './store';
import type { IndexerState } from './indexer';
import { freshIndexerState } from './indexer';
import type { AnchorState } from './anchor';
import { freshAnchorState } from './anchor';

/**
 * Postgres-backed registry store (Phase 3 production persistence).
 * Same interface as RegistryStore; tables created on boot.
 * REGISTRY_STORE=postgres DATABASE_URL=postgres://user:pass@host:port/db
 */
export class PostgresStore {
  agents = new Map<string, AgentRecord>();
  listings = new Map<string, ListingRecord>();
  escrows = new Map<string, EscrowRef>();
  receipts: ReceiptRecord[] = [];
  nonces = new Map<string, bigint>();
  indexerState: IndexerState = freshIndexerState();
  anchorState: AnchorState = freshAnchorState();
  private pool: Pool | null = null;
  private loaded = false;

  constructor(private databaseUrl: string) {}

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.databaseUrl, max: 5 });
      await this.init();
    }
    return this.pool;
  }

  private async init(): Promise<void> {
    const pool = this.pool!;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        address TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS escrows (
        key TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS nonces (
        address TEXT PRIMARY KEY,
        nonce TEXT NOT NULL
      );
    `);
    console.log('[store ] Postgres tables ready');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const pool = await this.getPool();

    const ag = await pool.query<{'address': string, 'record': AgentRecord}>('SELECT address, record FROM agents');
    for (const r of ag.rows) this.agents.set(r.address, r.record);

    const li = await pool.query<{'id': string, 'record': ListingRecord}>('SELECT id, record FROM listings');
    for (const r of li.rows) this.listings.set(r.id, r.record);

    const es = await pool.query<{'key': string, 'record': EscrowRef}>('SELECT key, record FROM escrows');
    for (const r of es.rows) this.escrows.set(r.key, r.record);

    const re = await pool.query<{'record': ReceiptRecord}>('SELECT record FROM receipts ORDER BY created_at');
    this.receipts = re.rows.map((r) => r.record);

    const no = await pool.query<{'address': string, 'nonce': string}>('SELECT address, nonce FROM nonces');
    for (const r of no.rows) this.nonces.set(r.address, BigInt(r.nonce));

    // Load indexer checkpoint if present
    const ix = await pool.query<{'record': unknown}>(
      "SELECT record FROM escrows WHERE key = '__indexer__'",
    );
    if (ix.rows.length > 0) {
      this.indexerState = ix.rows[0].record as IndexerState;
    }

    // Load anchor state if present
    const an = await pool.query<{'record': unknown}>(
      "SELECT record FROM escrows WHERE key = '__anchor__'",
    );
    if (an.rows.length > 0) {
      this.anchorState = an.rows[0].record as AnchorState;
    }

    this.loaded = true;
    console.log(`[store ] loaded: ${this.agents.size} agents, ${this.listings.size} listings, ${this.escrows.size} escrows, ${this.receipts.length} receipts`);
  }

  async save(): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [address, record] of this.agents) {
        await client.query(
          'INSERT INTO agents (address, record) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET record = $2, updated_at = now()',
          [address, JSON.stringify(record)],
        );
      }
      for (const [id, record] of this.listings) {
        await client.query(
          'INSERT INTO listings (id, record) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET record = $2',
          [id, JSON.stringify(record)],
        );
      }
      for (const [key, record] of this.escrows) {
        await client.query(
          'INSERT INTO escrows (key, record) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET record = $2',
          [key, JSON.stringify(record)],
        );
      }
      for (const r of this.receipts) {
        await client.query(
          'INSERT INTO receipts (id, record) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [r.id, JSON.stringify(r)],
        );
      }
      for (const [address, nonce] of this.nonces) {
        await client.query(
          'INSERT INTO nonces (address, nonce) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET nonce = $2',
          [address, nonce.toString()],
        );
      }
      // Persist the indexer checkpoint
      await client.query(
        'INSERT INTO escrows (key, record) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET record = $2',
        ['__indexer__', JSON.stringify(this.indexerState)],
      );
      // Persist the anchor state
      await client.query(
        'INSERT INTO escrows (key, record) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET record = $2',
        ['__anchor__', JSON.stringify(this.anchorState)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
