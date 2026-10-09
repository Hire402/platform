/**
 * Hire402 order books (Phase 2) — price-time-priority matching for
 * standardized units (spec §3.3). In-memory books per unit; every placement
 * executes against the crossing side and rests the remainder. The core
 * invariant: the book is never crossed (best bid < best ask, or a side is
 * empty) after any operation.
 */
export interface Order {
  id: string;
  unit: string;
  side: 'buy' | 'sell';
  price: bigint; // base units per 1 qty of the unit
  qty: bigint;
  remaining: bigint;
  agent: string;
  ts: number;
}

export interface Trade {
  id: string;
  unit: string;
  price: bigint;
  qty: bigint;
  buyId: string;
  sellId: string;
  ts: number;
}

export class Book {
  bids: Order[] = [];
  asks: Order[] = [];
  trades: Trade[] = [];

  bestBid(): bigint | null {
    let best: bigint | null = null;
    for (const b of this.bids) if (best === null || b.price > best) best = b.price;
    return best;
  }

  bestAsk(): bigint | null {
    let best: bigint | null = null;
    for (const a of this.asks) if (best === null || a.price < best) best = a.price;
    return best;
  }

  /** Core invariant: the book must never be crossed. */
  invariant(): boolean {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b === null || a === null || b < a;
  }

  /** Places an order; executes against crossing depth; rests the remainder. */
  place(o: Order): Trade[] {
    const fills: Trade[] = [];
    if (o.side === 'buy') {
      // asks ascending by price, then by time
      this.asks.sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : x.ts - y.ts));
      while (o.remaining > 0n) {
        const best = this.asks[0];
        if (!best || best.price > o.price) break;
        const qty = o.remaining < best.remaining ? o.remaining : best.remaining;
        this.asks.shift();
        best.remaining -= qty;
        if (best.remaining > 0n) this.asks.unshift(best);
        o.remaining -= qty;
        fills.push({
          id: `trade_${this.trades.length + fills.length}_${o.ts}`,
          unit: o.unit, price: best.price, qty,
          buyId: o.id, sellId: best.id, ts: Date.now(),
        });
      }
      if (o.remaining > 0n) this.bids.push(o);
    } else {
      // bids descending by price, then by time
      this.bids.sort((x, y) => (x.price > y.price ? -1 : x.price < y.price ? 1 : x.ts - y.ts));
      while (o.remaining > 0n) {
        const best = this.bids[0];
        if (!best || best.price < o.price) break;
        const qty = o.remaining < best.remaining ? o.remaining : best.remaining;
        this.bids.shift();
        best.remaining -= qty;
        if (best.remaining > 0n) this.bids.unshift(best);
        o.remaining -= qty;
        fills.push({
          id: `trade_${this.trades.length + fills.length}_${o.ts}`,
          unit: o.unit, price: best.price, qty,
          buyId: best.id, sellId: o.id, ts: Date.now(),
        });
      }
      if (o.remaining > 0n) this.asks.push(o);
    }
    this.trades.push(...fills);
    return fills;
  }

  depth(): { bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] } {
    const agg = (side: Order[]) => {
      const m = new Map<string, bigint>();
      for (const o of side) m.set(o.price.toString(), (m.get(o.price.toString()) ?? 0n) + o.remaining);
      return [...m.entries()].map(([price, qty]) => ({ price, qty: qty.toString() }));
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }
}

export class Books {
  private map = new Map<string, Book>();

  unit(unit: string): Book {
    let b = this.map.get(unit);
    if (!b) {
      b = new Book();
      this.map.set(unit, b);
    }
    return b;
  }

  place(o: Order): { trades: Trade[]; invariant: boolean } {
    const book = this.unit(o.unit);
    const trades = book.place(o);
    return { trades, invariant: book.invariant() };
  }

  allInvariants(): boolean {
    for (const b of this.map.values()) if (!b.invariant()) return false;
    return true;
  }

  totalTrades(): number {
    let n = 0;
    for (const b of this.map.values()) n += b.trades.length;
    return n;
  }
}
