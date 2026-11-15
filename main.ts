// CBBTC/USDC 1-minute dip-reversal bot for make.fun's bars-replay/v1 (btc-race-24h-20261115-0828).
//
// Two entry modules share one position slot, with a 1-USDC probe trade for the race window's
// "at least 1 trade" guardrail:
//
//   A. Capitulation rider: the close is 3.5% below the highest close of the last 90 minutes
//      (a velocity filter only a genuine washout trips) and the next close is the first above
//      its predecessor — buy the turn near the low, ride the rebound. Exits at +4.5% over the
//      filled cost, a 2% trailing stop off the best close since the fill, or a 2% hard stop.
//
//   C. Trend-pullback rider: while the EMA(360) rises and the close holds above it, buy a
//      pullback of 1% off the 45-minute high on its first up-close. Exits at +3%, a 1.2%
//      trail, or a 1.2% stop. Insurance for windows that never crash.
//
// Sells go out with the slippage cap wide open and are retried every bar while their reason
// holds, so an exit is never refused on price. The probe buys fees.min_notional_quote_units
// (1 USDC) on bar 2 and sells it the next bar.
//
// Deterministic by construction: float64 on + - * / over the closes only, no clock, no env,
// no randomness. Runs on the grader's `node /bot/main.ts` via the byte-identical kit shim
// under vendor/.

import { runBars, type BarsState, type Batch } from './vendor/makefun-bars.ts';

// module A: capitulation rider
const WASH_PCT = 0.035;
const WASHOUT_WIN = 90;
const A_TP = 0.045;
const A_TRAIL = 0.02;
const A_STOP = 0.02;

// module C: trend-pullback rider
const C_WASH_PCT = 0.01;
const C_WIN = 45;
const C_EMA_SPAN = 360;
const C_RISE_LOOK = 20;
const C_TP = 0.03;
const C_TRAIL = 0.012;
const C_STOP = 0.012;

const BUY_MAX_SLIPPAGE_BPS = 1000;
const SELL_MAX_SLIPPAGE_BPS = 10_000;

const closes: number[] = [];
// monotonic deques of indices for the rolling max closes of the two windows
const dqA: number[] = [];
const dqC: number[] = [];
let washHigh = 0;
let pullHigh = 0;

// EMA(C_EMA_SPAN) seeded as the mean of its first span of closes, with a short history ring
const emaWarm: number[] = [];
let ema = 0;
let emaReady = false;
const emaHist: number[] = [];

let probeArmed = true;
let probeSelling = false;
let posMode: 'A' | 'C' | null = null;
let entryPx = 0;
let maxSinceEntry = 0;
let sellSent = false;

function noteClose(c: number): void {
  const i = closes.length;
  // rolling max over the last WASHOUT_WIN closes
  while (dqA.length > 0 && closes[dqA[dqA.length - 1]!]! <= c) dqA.pop();
  dqA.push(i);
  if (dqA[0]! <= i - WASHOUT_WIN) dqA.shift();
  washHigh = closes[dqA[0]!]!;
  // rolling max over the last C_WIN closes
  while (dqC.length > 0 && closes[dqC[dqC.length - 1]!]! <= c) dqC.pop();
  dqC.push(i);
  if (dqC[0]! <= i - C_WIN) dqC.shift();
  pullHigh = closes[dqC[0]!]!;
  // EMA(C_EMA_SPAN)
  if (!emaReady) {
    emaWarm.push(c);
    if (emaWarm.length === C_EMA_SPAN) {
      ema = emaWarm.reduce((a, x) => a + x, 0) / C_EMA_SPAN;
      emaReady = true;
      emaHist.push(ema);
    }
  } else {
    ema += (2 / (C_EMA_SPAN + 1)) * (c - ema);
    if (emaHist.length >= C_RISE_LOOK) emaHist.shift();
    emaHist.push(ema);
  }
  closes.push(c);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars[0];
    if (!bar) return [];
    const c = Number(bar.c);
    noteClose(c);
    const i = closes.length - 1;

    // re-anchor the entry trackers to the actual fill when a main buy lands
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy' && BigInt(f.notional_quote_units) > 2n * minNotional) {
        entryPx = Number(f.price);
        maxSinceEntry = Number(f.price);
        posMode = posMode ?? 'A';
      }
    }

    if (state.warmingUp) return [];

    const held = state.positions.get(bar.symbol);

    // a sell decided on an earlier bar that has not filled yet: hand the position back
    if (sellSent && held !== undefined) {
      return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
    }
    sellSent = false;

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
      const hard = (entryPx - c) / entryPx;
      const tp = posMode === 'C' ? C_TP : A_TP;
      const ts = posMode === 'C' ? C_TRAIL : A_TRAIL;
      const sl = posMode === 'C' ? C_STOP : A_STOP;
      if (roi >= tp || trail >= ts || hard >= sl) {
        sellSent = true;
        return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // entries: A overrides C
    if (held === undefined && i > 1 && c > closes[i - 1]!) {
      const wash = (washHigh - c) / washHigh;
      if (wash >= WASH_PCT) {
        const spend = state.cash;
        if (spend >= minNotional) {
          posMode = 'A';
          entryPx = c;
          maxSinceEntry = c;
          return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
      if (emaReady && emaHist.length >= C_RISE_LOOK) {
        const esRising = ema > emaHist[0]!;
        const pull = (pullHigh - c) / pullHigh;
        if (esRising && c > ema && pull >= C_WASH_PCT) {
          const spend = state.cash;
          if (spend >= minNotional) {
            posMode = 'C';
            entryPx = c;
            maxSinceEntry = c;
            return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
          }
        }
      }
    }
    return [];
  },
});
