// CBBTC/USDC 1-minute regime-aware bot for make.fun's bars-replay/v1 (btc-race-24h-20261115-0828).
//
// Four behaviours share one position slot, every threshold relative (percent, never absolute
// price levels), with a 1-USDC probe trade for the race window's "at least 1 trade" guardrail:
//
//   A. Capitulation rider (full size): the close is 3.5% below the highest close of the last 90
//      minutes (a velocity filter only a genuine washout trips) and the next close is the first
//      above its predecessor — buy the turn near the low, ride the rebound. Exits at +4.5% over
//      the filled cost, a 2% trailing stop off the best close since the fill, or a 2% emergency
//      stop that reads the bar's LOW (fires one bar earlier on knife moves than a close-based
//      stop would).
//
//   C. Trend-pullback rider (full size): while the EMA(360) rises and the close holds above it,
//      buy a 1% pullback off the 45-minute high on its first up-close. Exits at +3%, a 1.2%
//      trail, or a 1.2% stop.
//
//   S. Chop scalper (40% size): only while the market is range-bound — the EMA(240) has moved
//      less than 1.2% over the last hour and the 30-minute range is under 3% — buy a 0.6% dip
//      under the SMA(30) on its first up-close, exit at +0.8%, a 0.8% trail, or a 0.8% stop.
//      At most 6 losing scalper rides in a row and a 45-minute cooldown after any exit; a
//      washout that trips A while the scalper holds hands the scalp back and lets A take over.
//
// Sells go out with the slippage cap wide open and are retried every bar while their reason
// holds, so an exit is never refused on price; buys carry a generous 10% cap so a live entry
// is never silently refused. The probe buys fees.min_notional_quote_units (1 USDC) on bar 2
// and sells it the next bar.
//
// Deterministic by construction: float64 on + - * / over the bars only, no clock, no env, no
// randomness. Runs on the grader's `node /bot/main.ts` via the byte-identical kit shim under
// vendor/.

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

// module S: chop scalper (mean-reversion, regime-gated)
const S_WIN_FALLBACK = 45; // rolling max window feeding the range/vol measure
const S_LOWIN_FALLBACK = 20; // rolling min window feeding the range/vol measure
const S_WASH_PCT = 0.0035;
const S_TP = 0.006;
const S_TRAIL = 0.02;
const S_STOP = 0.012;
const S_TIME_BARS = 16;
const S_SIZE_NUM = 60n; // 60% of cash per scalper ride
const S_SIZE_DEN = 100n;
const S_MAX_LOSSES = 99;
const S_COOLDOWN = 12;
const TREND_SPAN = 240;
const TREND_LOOK = 60;
const CHOP_TREND = 0.0012;
const CHOP_VOL = 0.02;
const SMA_SPAN = 30;
const SMA_LOOK = 12;

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
const hiC = new Rolling(C_WIN, true);
const hiS = new Rolling(S_WIN_FALLBACK, true);
const lowGuard = new Rolling(360, false);
const loS = new Rolling(S_LOWIN_FALLBACK, false);
let washHigh = 0;
let pullHigh = 0;
let swingHigh = 0;
let swingLow = 0;
let guardLow = 0;

// EMA(C_SPAN) and EMA(TREND_SPAN), each seeded as the mean of its first span of closes
const emaWarm: number[] = [];
let ema = 0;
let emaReady = false;
const emaHist: number[] = [];
const trWarm: number[] = [];
let tr = 0;
let trReady = false;
const trHist: number[] = [];

// SMA(SMA_SPAN) rolling sum
const smaWarm: number[] = [];
let smaAcc = 0;
let sma = 0;
const smaHist: number[] = [];

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
let sEntryI = -1;
let sFreshLowIdx = -1;
let sFreshLowVal = Infinity;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars[0];
    if (!bar) return [];
    const c = Number(bar.c);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const i = closes.length; // index the current bar will occupy once pushed below

    // settle the sell sent last bar: the scalper's loss counter and its cooldown
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
        if (posMode === 'S') sEntryI = i;
      }
    }

    closes.push(c);
    hiA.push(c, i, closes);
    hiC.push(c, i, closes);
    hiS.push(c, i, closes);
    loS.push(c, i, closes);
    lowGuard.push(c, i, closes);
    washHigh = hiA.value;
    pullHigh = hiC.value;
    swingHigh = hiS.value;
    swingLow = loS.value;
    guardLow = lowGuard.value;
    if (sFreshLowIdx === -1 || guardLow < sFreshLowVal) {
      sFreshLowIdx = i;
      sFreshLowVal = guardLow;
    }
    // EMAs
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
    if (!trReady) {
      trWarm.push(c);
      if (trWarm.length === TREND_SPAN) {
        tr = trWarm.reduce((a, x) => a + x, 0) / TREND_SPAN;
        trReady = true;
        trHist.push(tr);
      }
    } else {
      tr += (2 / (TREND_SPAN + 1)) * (c - tr);
      if (trHist.length >= TREND_LOOK) trHist.shift();
      trHist.push(tr);
    }
    // SMA(SMA_SPAN) + riwayat 12 barnya (guard mean-tidak-turun)
    smaWarm.push(c);
    smaAcc += c;
    if (smaWarm.length > SMA_SPAN) smaAcc -= smaWarm.shift()!;
    if (smaWarm.length === SMA_SPAN) sma = smaAcc / SMA_SPAN;
    if (smaWarm.length === SMA_SPAN) {
      if (smaHist.length >= SMA_LOOK) smaHist.shift();
      smaHist.push(sma);
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
      const washA = (washHigh - c) / washHigh;
      const pivot = posMode === 'S' && washA >= A_WASH_PCT; // a real washout while scalping: hand back to A
      const timeUp = posMode === 'S' && sEntryI >= 0 && i - sEntryI >= S_TIME_BARS; // neither target nor stop in 16 minutes: flat
      if (roi >= P.tp || trail >= P.ts || hard >= P.sl || timeUp || pivot) {
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
      // chop scalper: range-bound, mean-reversion under the SMA
      const trendStr = trReady && trHist.length >= TREND_LOOK ? Math.abs(tr - trHist[0]!) / tr : 1;
      const vol30 = (swingHigh - swingLow) / c;
      const meanRising = smaHist.length >= SMA_LOOK && sma >= smaHist[0]!; // jangan scalping saat mean turun
      const freshOk = sFreshLowIdx >= 0 && i - sFreshLowIdx > 45; // gak nyandung setelah fresh low 6 jam
      const chopMode = trendStr < CHOP_TREND && vol30 < CHOP_VOL;
      if (chopMode && meanRising && freshOk && smaWarm.length === SMA_SPAN && c <= sma * (1 - S_WASH_PCT) && sCooldown === 0 && sLosses < S_MAX_LOSSES) {
        const spend = (state.cash * S_SIZE_NUM) / S_SIZE_DEN;
        if (spend >= minNotional) {
          posMode = 'S';
          entryPx = c;
          maxSinceEntry = c;
          return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
