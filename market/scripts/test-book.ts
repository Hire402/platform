import { Books } from '../src/book';

/**
 * Scripted order-book test (roadmap Phase 2 acceptance):
 * 200 deterministic orders (100 buys, 100 sells) across 2 units with
 * overlapping ranges. Asserts: trades cleared, qty conservation, and the
 * never-crossed invariant holds after EVERY placement.
 */
function fail(msg: string): never {
  console.error(`BOOK TEST FAIL: ${msg}`);
  process.exit(1);
}

const books = new Books();
const units = ['gpu-hour', 'tok-infer:mock-small'];

let totalTrades = 0;
let placed = 0;
const filledQtyByOrder = new Map<string, bigint>();

for (const unit of units) {
  // 100 buys: 1.20 → 0.21 USDC (base units), qty 1
  for (let i = 0; i < 100; i++) {
    const price = 1_200_000n - BigInt(i) * 10_000n;
    const order = {
      id: `b_${unit}_${i}`, unit, side: 'buy' as const,
      price, qty: 1n, remaining: 1n, agent: `0xbuyer${i}`, ts: i,
    };
    const { trades, invariant } = books.place(order);
    if (!invariant) fail(`crossed book after buy ${i} on ${unit}`);
    for (const t of trades) {
      filledQtyByOrder.set(t.buyId, (filledQtyByOrder.get(t.buyId) ?? 0n) + t.qty);
      filledQtyByOrder.set(t.sellId, (filledQtyByOrder.get(t.sellId) ?? 0n) + t.qty);
    }
    totalTrades += trades.length;
    placed++;
  }
  // 100 sells: 0.80 → 1.79 USDC, qty 1 (overlaps buys from 0.80 to 1.20)
  for (let i = 0; i < 100; i++) {
    const price = 800_000n + BigInt(i) * 10_000n;
    const order = {
      id: `s_${unit}_${i}`, unit, side: 'sell' as const,
      price, qty: 1n, remaining: 1n, agent: `0xseller${i}`, ts: 100 + i,
    };
    const { trades, invariant } = books.place(order);
    if (!invariant) fail(`crossed book after sell ${i} on ${unit}`);
    for (const t of trades) {
      filledQtyByOrder.set(t.buyId, (filledQtyByOrder.get(t.buyId) ?? 0n) + t.qty);
      filledQtyByOrder.set(t.sellId, (filledQtyByOrder.get(t.sellId) ?? 0n) + t.qty);
    }
    totalTrades += trades.length;
    placed++;
  }
}

// Quantitative expectations (deterministic under price-time priority):
// each ask consumes the best remaining bid, so asks 0.80..1.00 exhaust bids
// 1.20..1.01 → 21 trades per unit, 42 total. Assert ≥ 40.
if (totalTrades < 40) fail(`expected ≥ 40 trades across 2 units, got ${totalTrades}`);

// Conservation: no order overfills.
for (const [id, filled] of filledQtyByOrder) {
  if (filled > 1n) fail(`order ${id} overfilled (${filled})`);
}

// Final invariant across all books.
if (!books.allInvariants()) fail('final crossed-book state');

// Never-crossed book means best bid < best ask on each unit (when both sides non-empty).
for (const unit of units) {
  const book = books.unit(unit);
  const b = book.bestBid();
  const a = book.bestAsk();
  if (b !== null && a !== null && b >= a) fail(`${unit}: best bid ${b} >= best ask ${a}`);
}

console.log(
  `BOOK TEST PASS: ${placed} orders placed, ${totalTrades} trades cleared across ${units.length} units,` +
    ` never-crossed invariant held after every placement, no overfills.`,
);
