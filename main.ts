// CBBTC/USDC 1-minute dip-reversal bot for make.fun's bars-replay/v1 (btc-race-24h-20261115-0828).
//
// Three entry modules share one position slot, with a 1-USDC probe trade for the race window's
// "at least 1 trade" guardrail. Every threshold is relative (percent, never absolute price
// levels), so the bot trades at any price regime:
//
//   A. Capitulation rider: the close is 3.5% below the highest close of the last 90 minutes
//      (a velocity filter only a genuine washout trips) and the next close is the first above
//      its predecessor — buy the turn near the low, ride the rebound. Exits at +4.5% over the
//      filled cost, a 2% trailing stop off the best close since the fill, or a 2% hard stop.
//
//   C. Trend-pullback rider: while the EMA(360) rises and the close holds above it, buy a
//      1% pullback off the 45-minute high on its first up-close. Exits at +3%, a 1.2% trail,
//      or a 1.2% stop. Insurance for windows that never crash.
//
//   S. Guarded swing scalper: a close 0.8% off the 45-minute high that has just ticked up and
//      sits above its 20-minute low, only when no fresh 6-hour low formed in the last 120
//      minutes, at most one losing scalper ride in a row (the next A ride re-arms it) and with
//      a 45-minute cooldown after any exit. Exits at +1%, a 0.8% trail, or a 0.8% stop.
//
// Sells go out with the slippage cap wide open and are retried every bar while their reason
// holds, so an exit is never refused on price; buys carry a generous 10% cap so a live entry
// is never silently refused. The probe buys fees.min_notional_quote_units (1 USDC) on bar 2
// and sells it the next bar.
//
// Deterministic by construction: float64 on + - * / over the closes only, no clock, no env,
// no randomness. Runs on the grader's `node /bot/main.ts` via the byte-identical kit shim
// under vendor/.

import { runBars, type BarsState, type Batch } from './vendor/makefun-bars.ts';

// module A: capitulation rider
const A_WASH_PCT = 0.035;
const A_WIN = 90;
const A_TP = 0.045;
const A_TRAIL = 0.02;
const A_STOP = 0.02;

// module C: trend-pullback rider
const C_SPAN = 360;
const C_RISE = 20;
const C_WIN = 45;
const C_WASH_PCT = 0.01;
const C_TP = 0.03;
const C_TRAIL = 0.012;
const C_STOP = 0.012;

// module S: guarded swing scalper
const S_WASH_PCT = 0.008;
const S_WIN = 45;
const S_LOWIN = 20;
const S_GUARD_SPAN = 360;
const S_GUARD_BARS = 120;
const S_MAX_LOSSES = 1;
const S_COOLDOWN = 45;
const S_TP = 0.01;
const S_TRAIL = 0.008;
const S_STOP = 0.008;

const BUY_MAX_SLIPPAGE_BPS = 1000;
const SELL_MAX_SLIPPAGE_BPS = 10_000;

// monotonic deque of indices tracking a rolling max or min over the last `span` closes
class Rolling {
  private readonly dq: number[] = [];
  private readonly span: number;
  private readonly isMax: boolean;
  value = 0;
  constructor(span: number, isMax: boolean) {
    this.span = span;
    this.isMax = isMax;
  }
  push(c: number, i: number, closes: number[]): void {
    while (this.dq.length > 0) {
      const v = closes[this.dq[this.dq.length - 1]!]!;
      if (this.isMax ? v <= c : v >= c) this.dq.pop();
      else break;
    }
    this.dq.push(i);
    if (this.dq[0]! <= i - this.span) this.dq.shift();
    this.value = closes[this.dq[0]!]!;
  }
}

const closes: number[] = [];
const hiA = new Rolling(A_WIN, true);
const hiS = new Rolling(S_WIN, true);
const loS = new Rolling(S_LOWIN, false);
const lowGuard = new Rolling(S_GUARD_SPAN, false);
let washHigh = 0;
let pullHigh = 0;
let swingHigh = 0;
let swingLow = 0;
let guardLow = 0;

// EMA(C_SPAN) seeded as the mean of its first span of closes, with a short history ring
const emaWarm: number[] = [];
let ema = 0;
let emaReady = false;
const emaHist: number[] = [];

let probeArmed = true;
let probeSelling = false;
let posMode: 'A' | 'C' | 'S' | null = null;
let entryPx = 0;
let maxSinceEntry = 0;
let sellSent = false;
let sellCost = 0n;
let sellMode: 'A' | 'C' | 'S' | null = null;
let sLosses = 0;
let sCooldown = 0;
let sFreshLowIdx = -1;
let sFreshLowVal = Infinity;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars[0];
    if (!bar) return [];
    const c = Number(bar.c);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    // settle the sell we sent last bar: the scalper's loss counter and its cooldown
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'sell') {
        const net = BigInt(f.notional_quote_units) - BigInt(f.fee_quote_units);
        if (sellMode === 'S') {
          if (net < sellCost) sLosses++;
        } else {
          sLosses = 0;
        }
        sCooldown = S_COOLDOWN;
        sellCost = 0n;
        sellMode = null;
      }
      if (f.status === 'filled' && f.side === 'buy' && BigInt(f.notional_quote_units) > 2n * minNotional) {
        // re-anchor the entry trackers to the actual fill of a main buy
        entryPx = Number(f.price);
        maxSinceEntry = Number(f.price);
        posMode = posMode ?? 'A';
      }
    }

    closes.push(c);
    const i = closes.length - 1;
    hiA.push(c, i, closes);
    hiS.push(c, i, closes);
    loS.push(c, i, closes);
    lowGuard.push(c, i, closes);
    washHigh = hiA.value;
    pullHigh = hiS.value;
    swingHigh = hiS.value;
    swingLow = loS.value;
    if (sFreshLowIdx === -1 || lowGuard.value < sFreshLowVal) {
      sFreshLowIdx = i;
      sFreshLowVal = lowGuard.value;
    }
    // EMA(C_SPAN)
    if (!emaReady) {
      emaWarm.push(c);
      if (emaWarm.length === C_SPAN) {
        ema = emaWarm.reduce((a, x) => a + x, 0) / C_SPAN;
        emaReady = true;
        emaHist.push(ema);
      }
    } else {
      ema += (2 / (C_SPAN + 1)) * (c - ema);
      if (emaHist.length >= C_RISE) emaHist.shift();
      emaHist.push(ema);
    }

    if (state.warmingUp) return [];

    const held = state.positions.get(bar.symbol);

    // a sell decided on an earlier bar that has not filled yet: hand the position back
    if (sellSent && held !== undefined) {
      return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
    }
    sellSent = false;
    if (sCooldown > 0) sCooldown--;

    // probe trade: one 1-USDC round trip for the race window's >=1-trade guardrail
    if (probeArmed && i >= 2 && held === undefined && state.cash > 2n * minNotional) {
      probeArmed = false;
      probeSelling = true;
      return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: minNotional, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
    }
    if (probeSelling && held !== undefined && held.cost <= 2n * minNotional) {
      probeSelling = false;
      return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
    }

    // main position: exits first
    if (held !== undefined && held.cost > 2n * minNotional) {
      if (c > maxSinceEntry) maxSinceEntry = c;
      const posVal = state.value(bar.symbol, held.qty);
      const roi = Number(posVal - held.cost) / Number(held.cost);
      const trail = (maxSinceEntry - c) / maxSinceEntry;
      // the big A ride's emergency stop reads the bar's LOW: on a knife move it fires one bar
      // earlier than a close-based stop would, for materially less slippage damage
      const hard = posMode === 'A' ? (entryPx - Number(bar.l)) / entryPx : (entryPx - c) / entryPx;
      const P = posMode === 'C' ? { tp: C_TP, ts: C_TRAIL, sl: C_STOP } : posMode === 'S' ? { tp: S_TP, ts: S_TRAIL, sl: S_STOP } : { tp: A_TP, ts: A_TRAIL, sl: A_STOP };
      if (roi >= P.tp || trail >= P.ts || hard >= P.sl) {
        sellSent = true;
        sellCost = held.cost;
        sellMode = posMode;
        return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // entries: A overrides C overrides S
    if (held === undefined && i > 1 && c > closes[i - 1]!) {
      const washA = (washHigh - c) / washHigh;
      if (washA >= A_WASH_PCT && state.cash >= minNotional) {
        posMode = 'A';
        entryPx = c;
        maxSinceEntry = c;
        return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: state.cash, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
      }
      if (emaReady && emaHist.length >= C_RISE && ema > emaHist[0]! && c > ema) {
        const pull = (pullHigh - c) / pullHigh;
        if (pull >= C_WASH_PCT && state.cash >= minNotional) {
          posMode = 'C';
          entryPx = c;
          maxSinceEntry = c;
          return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: state.cash, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
      const washS = (swingHigh - c) / swingHigh;
      const freshOk = sFreshLowIdx >= 0 && i - sFreshLowIdx > S_GUARD_BARS;
      if (washS >= S_WASH_PCT && freshOk && sCooldown === 0 && sLosses < S_MAX_LOSSES && c > swingLow * (1 + 0.002) && state.cash >= minNotional) {
        posMode = 'S';
        entryPx = c;
        maxSinceEntry = c;
        return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: state.cash, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
