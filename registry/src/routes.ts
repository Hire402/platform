import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PublicClient } from 'viem';
import { decodeEventLog } from 'viem';
import { ERC20_ABI, ESCROW_ABI } from '@hire402/sdk';
import type { ListingRecord, RegistryStore, AgentRecord } from './store';
import type { makeAuth } from './auth';
import { computeMetabolic, computeReputation } from './metabolic';
import { computeBondRequirement } from './bond-requirement';
import { computeCreditScore } from './credit-score';
import { merkleProof } from './anchor';

export interface RegistryDeps {
  pc: PublicClient;
  usdc: `0x${string}`;
  escrowAddr: `0x${string}`;
  chainId: bigint;
  store: RegistryStore;
  auth: ReturnType<typeof makeAuth>;
}

type Query = { unit?: string; status?: string; sort?: string };

function parseBody(req: FastifyRequest): Record<string, unknown> {
  if (typeof req.body !== 'string') return {};
  try {
    return JSON.parse(req.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function registerRoutes(app: FastifyInstance, deps: RegistryDeps) {
  const { pc, usdc, escrowAddr, store, auth } = deps;

  // ---------------- input safety: per-IP POST rate limit ----------------
  // (v0.1: in-memory fixed window — fine for a single-process registry;
  //  Postgres-backed if it ever scales out. Fastify caps request bodies
  //  at 1 MiB by default.)
  const WINDOW_MS = 60_000;
  const MAX_POSTS_PER_WINDOW = 60;
  const hits = new Map<string, { n: number; reset: number }>();
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST') return;
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
    }
    const w = hits.get(ip);
    if (!w || now >= w.reset) {
      hits.set(ip, { n: 1, reset: now + WINDOW_MS });
      return;
    }
    w.n += 1;
    if (w.n > MAX_POSTS_PER_WINDOW) {
      reply.code(429).send({ error: 'rate limit: too many POSTs; retry after the window' });
    }
  });

  const rejectAuth = async (
    req: FastifyRequest,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const a = await auth(req);
    if (!a.ok) {
      reply.code(a.status).send({ error: a.error });
      return null;
    }
    return a;
  };

  // ---------------- public: machine-first surface ----------------
  app.get('/healthz', async () => ({ ok: true, service: 'hire402-registry' }));

  /** The registry is itself an A2A-visible agent (adoption: be discoverable
   *  where agents already shop — spec §2, dogfooding the discovery layer). */
  app.get('/.well-known/agent-card.json', async () => ({
    name: 'hire402-registry',
    description: 'The trust layer for delegated agent spending: directory, escrow registry, metabolic ledger, reputation. The agent is the user; the human is the account holder.',
    url: `http://127.0.0.1:${process.env.REGISTRY_PORT ?? 4010}`,
    version: '0.1.0',
    protocol: { transport: 'http/json', a2a: 'semantics-0.1' },
    capabilities: {
      search: '/v1/listings?unit=',
      agent: '/v1/agents/{address}',
      metabolic: '/v1/agents/{address}/metabolic',
      reputation: '/v1/reputation/{address}',
      bond: '/v1/agents/{address}/bond',
      creditScore: '/v1/agents/{address}/credit-score',
      anchor: '/v1/anchor',
      quotes: '/v1/market/quotes?unit=',
    },
    payments: { escrow: true, x402: 'semantics-0.1' },
  }));

  app.get('/llms.txt', async () => {
    return `# Hire402 Registry

> Machine-first directory for delegated agent spending (spec v0.1 §10).
> The agent is the user; the human is the account holder.

Endpoints:
- POST /v1/agents — self-register (EIP-712 RegistryRequest auth)
- GET /v1/agents?unit=&status=&sort=
- GET /v1/agents/{address} — record + metabolic + reputation
- POST /v1/listings — publish a service (sig auth)
- GET /v1/listings?unit=&sort=price
- POST /v1/escrows — register an on-chain escrow for indexing (sig auth)
- POST /v1/receipts — provider-signed burn receipt (sig auth)
- GET /v1/agents/{address}/metabolic — P&L, runway, solvency
- GET /v1/reputation/{address}
- GET /v1/agents/{address}/bond — staking requirement w/ clean-job decay (§8)
- GET /v1/agents/{address}/credit-score — the published formula; desk gate ≥ 500 (§8)
- GET /v1/anchor — anchored reputation-root status (§7)
- GET /v1/anchor/proof/{address} — Merkle inclusion proof vs the on-chain root
- GET /v1/market/quotes?unit=

Chain facts:
- escrow: ${escrowAddr}
- settlement asset: USDC ${usdc}
- fee: 150 bps on release (in-contract cap 300)

Auth: EIP-712 RegistryRequest(bytes payload,uint64 ts,uint256 nonce) over
keccak256(rawBody); headers X-Hire402-Sig/-Addr/-Ts/-Nonce. Replay-protected.
`;
  });

  app.get('/v1/schema', async () => ({
    openapi: '3.1.0',
    info: { title: 'Hire402 Registry', version: '0.1.0' },
    paths: {
      '/v1/agents': { get: { summary: 'directory search' }, post: { summary: 'self-register (sig)' } },
      '/v1/agents/{address}': { get: { summary: 'agent record + metabolic + reputation + bond requirement' } },
      '/v1/agents/{address}/bond': { get: { summary: 'staking requirement with clean-job decay (spec §8)' } },
      '/v1/agents/{address}/credit-score': { get: { summary: 'published credit formula; advances require ≥ 500 (spec §8)' } },
      '/v1/anchor': { get: { summary: 'anchored reputation-root status (spec §7)' } },
      '/v1/anchor/proof/{address}': { get: { summary: 'Merkle inclusion proof against the on-chain root' } },
      '/v1/listings': { get: { summary: 'search listings' }, post: { summary: 'publish listing (sig)' } },
      '/v1/escrows': { post: { summary: 'register escrow for indexing (sig)' } },
      '/v1/receipts': { post: { summary: 'post burn receipt (sig)' } },
      '/v1/market/quotes': { get: { summary: 'indicative quotes from listings' } },
    },
  }));

  // ---------------- agents ----------------
  app.post('/v1/agents', async (req, reply) => {
    const a = await rejectAuth(req, reply);
    if (!a) return;
    const body = parseBody(req) as {
      address?: string;
      agentCardUrl?: string;
      x402?: AgentRecord['x402'];
      lineage?: { parent?: string };
    };
    const address = (body.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || address !== a.address) {
      return reply.code(400).send({ error: 'body.address must be the signer' });
    }
    const lineage =
      body.lineage?.parent && /^0x[0-9a-f]{40}$/i.test(body.lineage.parent)
        ? { parent: body.lineage.parent.toLowerCase(), spawnedAt: new Date().toISOString() }
        : undefined;
    const prev = store.agents.get(address);
    const record: AgentRecord = {
      address,
      agentCardUrl: body.agentCardUrl,
      x402: body.x402 ?? { chains: ['eip155:31337'], assets: ['USDC'] },
      status: 'self-registered', // self-registration upgrades an observed record
      registeredAt: prev?.registeredAt ?? new Date().toISOString(),
      listings: prev?.listings ?? [],
      lineage: prev?.lineage ?? lineage,
    };
    store.agents.set(address, record);
    store.save();
    return reply.code(201).send(record);
  });

  app.get('/v1/agents', async (req) => {
    const q = (req.query ?? {}) as Query;
    let list = [...store.agents.values()];
    if (q.status) list = list.filter((a) => a.status === q.status);
    return { agents: list, count: list.length };
  });

  app.get('/v1/agents/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const record = store.agents.get(address.toLowerCase());
    if (!record) return reply.code(404).send({ error: 'agent not registered' });
    const [metabolic, reputation, creditScore] = await Promise.all([
      computeMetabolic(pc, usdc, escrowAddr, store, record.address),
      computeReputation(pc, escrowAddr, store, record.address),
      computeCreditScore(pc, usdc, escrowAddr, store, record.address),
    ]);
    const bondRequirement = computeBondRequirement(store, record.address);
    return { ...record, metabolic, reputation, creditScore, bondRequirement };
  });

  app.get('/v1/agents/:address/bond', async (req, reply) => {
    const { address } = req.params as { address: string };
    const record = store.agents.get(address.toLowerCase());
    if (!record) return reply.code(404).send({ error: 'agent not registered' });
    return computeBondRequirement(store, record.address);
  });

  /** The published credit formula (spec §8) — the desk's ≥ 500 gate, verified. */
  app.get('/v1/agents/:address/credit-score', async (req, reply) => {
    const { address } = req.params as { address: string };
    const record = store.agents.get(address.toLowerCase());
    if (!record) return reply.code(404).send({ error: 'agent not registered' });
    return computeCreditScore(pc, usdc, escrowAddr, store, record.address);
  });

  app.get('/v1/agents/:address/metabolic', async (req, reply) => {
    const { address } = req.params as { address: string };
    const record = store.agents.get(address.toLowerCase());
    if (!record) return reply.code(404).send({ error: 'agent not registered' });
    return computeMetabolic(pc, usdc, escrowAddr, store, record.address);
  });

  app.get('/v1/reputation/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    return computeReputation(pc, escrowAddr, store, address.toLowerCase());
  });

  // ---------------- reputation-root anchoring (spec §7) ----------------
  app.get('/v1/anchor', async () => {
    const a = store.anchorState;
    return {
      enabled: Boolean(process.env.ANCHOR_ADDRESS),
      contract: a?.contract ?? null,
      latestEpoch: a?.latestEpoch ?? 0,
      root: a?.latestRoot || null,
      leafCount: a?.leafCount ?? 0,
      lastAnchoredAt: a?.lastAnchoredAt ?? null,
      epochSeconds: Number(process.env.ANCHOR_EPOCH_SECONDS ?? 21_600),
      note: 'epoch ids are consecutive sequence numbers; the chain enforces the gapless sequence; verify any self-registered agent against the on-chain root via /v1/anchor/proof/{address}',
    };
  });

  /** Merkle inclusion proof of an agent's reputation against the anchored root. */
  app.get('/v1/anchor/proof/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const addr = address.toLowerCase();
    const a = store.anchorState;
    if (!a || a.latestEpoch === 0) {
      return reply.code(404).send({ error: 'no epoch anchored yet' });
    }
    const idx = a.entries.findIndex((e) => e.address === addr);
    if (idx === -1) {
      return reply.code(404).send({ error: 'agent not in the latest anchored epoch (self-register to be included)' });
    }
    const proof = merkleProof(a.leaves as `0x${string}`[], idx);
    return {
      epoch: a.latestEpoch,
      address: addr,
      index: idx,
      leaf: a.leaves[idx],
      entry: a.entries[idx],
      proof,
      root: a.latestRoot,
      contract: a.contract ?? null,
      verify: 'leaf = keccak256(abi.encodePacked(address, uint256 completedJobs, uint256 disputedJobs, uint256 slashed)); leaves sorted by address; odd levels duplicate the last node; fold direction from index bits (right-sib when index bit = 0)',
    };
  });

  // ---------------- listings ----------------
  app.post('/v1/listings', async (req, reply) => {
    const a = await rejectAuth(req, reply);
    if (!a) return;
    const body = parseBody(req) as {
      unit?: string;
      pricing?: ListingRecord['pricing'];
      sla?: ListingRecord['sla'];
    };
    if (!body.unit || !body.pricing) {
      return reply.code(400).send({ error: 'unit and pricing required' });
    }
    const id = `srvc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const record: ListingRecord = {
      id,
      seller: a.address,
      unit: body.unit,
      pricing: body.pricing,
      sla: body.sla,
      createdAt: new Date().toISOString(),
    };
    store.listings.set(id, record);
    const agent = store.agents.get(a.address);
    if (agent) agent.listings.push(id);
    store.save();
    return reply.code(201).send(record);
  });

  app.get('/v1/listings', async (req) => {
    const q = (req.query ?? {}) as Query;
    let list = [...store.listings.values()];
    if (q.unit) list = list.filter((l) => l.unit === q.unit);
    if (q.sort === 'price') {
      list = list.sort(
        (x, y) => Number(x.pricing.amount ?? Infinity) - Number(y.pricing.amount ?? Infinity),
      );
    }
    return { listings: list, count: list.length };
  });

  app.get('/v1/market/quotes', async (req) => {
    const q = (req.query ?? {}) as Query;
    const list = [...store.listings.values()].filter((l) => !q.unit || l.unit === q.unit);
    const best =
      list.filter((l) => l.pricing.amount).sort((x, y) => Number(x.pricing.amount) - Number(y.pricing.amount))[0] ?? null;
    return { unit: q.unit ?? null, best, sources: list.length };
  });

  // ---------------- escrow indexing ----------------
  app.post('/v1/escrows', async (req, reply) => {
    const a = await rejectAuth(req, reply);
    if (!a) return;
    const body = parseBody(req) as { escrowId?: string | number };
    const escrowId = Number(body.escrowId);
    if (!Number.isFinite(escrowId) || escrowId <= 0) {
      return reply.code(400).send({ error: 'escrowId required' });
    }
    // Public-RPC backends can lag behind the mempool — retry the chain read.
    let core: readonly unknown[] | undefined;
    for (let i = 0; i < 8; i++) {
      try {
        core = (await pc.readContract({
          address: escrowAddr,
          abi: ESCROW_ABI,
          functionName: 'getEscrowCore',
          args: [BigInt(escrowId)],
        })) as readonly unknown[];
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!core) {
      return reply.code(503).send({ error: 'escrow not visible on chain yet — retry shortly' });
    }
    // positional tuple: [buyer, seller, verifier, arbiter, token, feeBps, challengeSeconds, state]
    const key = `${escrowId}@${deps.chainId}`;
    store.escrows.set(key, {
      escrowId,
      chainId: Number(deps.chainId),
      address: escrowAddr,
      buyer: (core[0] as string).toLowerCase(),
      seller: (core[1] as string).toLowerCase(),
      registeredBy: a.address,
      createdAt: new Date().toISOString(),
    });
    store.save();
    return reply.code(201).send(store.escrows.get(key));
  });

  // ---------------- burn receipts (x402-semantics) ----------------
  app.post('/v1/receipts', async (req, reply) => {
    const a = await rejectAuth(req, reply);
    if (!a) return; // a.address = the provider that received payment
    const body = parseBody(req) as {
      payer?: string;
      amount?: string;
      txHash?: `0x${string}`;
      service?: string;
    };
    const payer = (body.payer ?? '').toLowerCase();
    const txHash = (body.txHash ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(payer) || !body.amount || !txHash) {
      return reply.code(400).send({ error: 'payer, amount, txHash required' });
    }
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      return reply.code(400).send({ error: 'txHash must be a 32-byte hex string' });
    }
    let amount: bigint;
    try {
      amount = BigInt(body.amount);
    } catch {
      return reply.code(400).send({ error: 'amount must be an integer string in base units' });
    }
    if (amount <= 0n) {
      return reply.code(400).send({ error: 'amount must be positive' });
    }

    // Verify on-chain: a USDC Transfer(payer → provider, amount) exists in
    // the receipt. The registry never trusts signatures over money — it
    // checks the chain. (Retry: public backends can lag the mempool.)
    let receipt: Awaited<ReturnType<typeof pc.getTransactionReceipt>> | undefined;
    for (let i = 0; i < 8; i++) {
      try {
        receipt = await pc.getTransactionReceipt({ hash: txHash as `0x${string}` });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!receipt) {
      return reply.code(400).send({ error: 'tx receipt not visible on chain yet' });
    }
    const verified = receipt.logs.some(
      (l: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }) => {
      if (l.address.toLowerCase() !== usdc.toLowerCase()) return false;
      try {
        const d = decodeEventLog({
          abi: ERC20_ABI,
          data: l.data,
          topics: l.topics as [] | [`0x${string}`, ...`0x${string}`[]],
        });
        return (
          d.eventName === 'Transfer' &&
          (d.args as { from?: string }).from?.toLowerCase() === payer &&
          (d.args as { to?: string }).to?.toLowerCase() === a.address &&
          (d.args as { value?: bigint }).value === amount
        );
      } catch {
        return false;
      }
    });
    if (!verified) {
      return reply.code(400).send({ error: 'receipt does not verify on-chain' });
    }

    // Replay guard: a txHash is recorded ONCE. Resubmitting a genuine
    // receipt must not double-count the payer's burn (runway, credit
    // score, delisting are downstream of it).
    if (store.receipts.some((r) => r.txHash.toLowerCase() === txHash)) {
      return reply.code(409).send({ error: 'receipt already recorded' });
    }

    const record = {
      id: `rcpt_${Date.now().toString(36)}`,
      payer,
      to: a.address,
      amount: body.amount,
      txHash,
      service: body.service ?? 'unknown',
      createdAt: new Date().toISOString(),
    };
    store.receipts.push(record);
    store.save();
    return reply.code(201).send(record);
  });

}
