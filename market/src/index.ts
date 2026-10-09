import Fastify from 'fastify';
import { checkNonceAndSkew, verifyRegistryRequest } from '@hire402/sdk';
import { Books, type Order } from './book';

/**
 * Hire402 Market (Phase 2): order books for standardized units. Mutations
 * are EIP-712-authenticated (RegistryRequest over the raw body) exactly
 * like the registry. Books are in-memory (Phase 3 swaps in persistence);
 * every placement is checked against the never-crossed invariant.
 */
const PORT = Number(process.env.MARKET_PORT ?? 4150);
const books = new Books();
const nonces = new Map<string, bigint>();
let chainId = 31337n; // set from env/registry in Phase 2.1; sig domain uses this

async function main() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  app.get('/healthz', async () => ({ ok: true, service: 'hire402-market' }));

  app.get('/v1/book', async (req) => {
    const q = (req.query ?? {}) as { unit?: string };
    if (!q.unit) return { error: 'unit required' };
    const book = books.unit(q.unit);
    return {
      unit: q.unit,
      bestBid: book.bestBid()?.toString() ?? null,
      bestAsk: book.bestAsk()?.toString() ?? null,
      depth: book.depth(),
    };
  });

  app.get('/v1/trades', async (req) => {
    const q = (req.query ?? {}) as { unit?: string };
    if (!q.unit) return { trades: [], count: 0, total: books.totalTrades() };
    const book = books.unit(q.unit);
    return { trades: book.trades.slice(-50), count: book.trades.length, total: books.totalTrades() };
  });

  app.post('/v1/orders', async (req, reply) => {
    const auth = await verifyRegistryRequest(chainId, req.body as string, req.headers);
    if (!auth.ok) return reply.code(401).send({ error: auth.error });
    const h = (k: string) => {
      const v = req.headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    if (!checkNonceAndSkew(nonces, auth.address, BigInt(h('x-hire402-nonce') ?? '0'))) {
      return reply.code(401).send({ error: 'nonce replay' });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body as string) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }
    const unit = body.unit as string | undefined;
    const side = body.side as 'buy' | 'sell' | undefined;
    const price = BigInt((body.price as string | undefined) ?? '0');
    const qty = BigInt((body.qty as string | undefined) ?? '0');
    if (!unit || (side !== 'buy' && side !== 'sell') || price <= 0n || qty <= 0n) {
      return reply.code(400).send({ error: 'unit, side(buy|sell), price>0, qty>0 required (base-unit strings)' });
    }

    const order: Order = {
      id: `ord_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      unit, side, price, qty, remaining: qty,
      agent: auth.address, ts: Date.now(),
    };
    const result = books.place(order);
    if (!result.invariant) {
      return reply.code(500).send({ error: 'invariant violation — book crossed' });
    }
    return reply.code(201).send({
      orderId: order.id,
      trades: result.trades.map((t) => ({ id: t.id, price: t.price.toString(), qty: t.qty.toString() })),
      remaining: order.remaining.toString(),
    });
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[market ] listening on :${PORT} — order books for standardized units`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
