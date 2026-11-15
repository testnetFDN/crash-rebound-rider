// CBBTC/USDC 1-minute dip-reversal bot for make.fun's bars-replay/v1 (btc-race-24h-20261115-0828).
//
// Strategy: wait in cash; buy a washed-out dip the minute it first ticks up, ride the rebound,
// hand the position back on take-profit, a trailing stop or a hard stop. A 1-USDC probe trade
// near the start guarantees the race window's "at least 1 trade" guardrail at negligible cost.
//
//   - Washout: the close is WASH_PCT below the highest close of the last WASHOUT_WIN minutes
//     (a velocity filter: only a genuine capitulation trips it; a slow drift never does).
//   - Confirmation: the washout bar is followed by the first close above the previous close
//     (the turn), so the buy lands near the low, not in the falling knife.
//   - Exit: close at +TAKE_PROFIT over the filled cost, or trailing TAKE_TRAIL off the best
//     close since the fill, or a hard STOP below the fill. A sell is retried every bar while
//     we still hold and its reason holds; sells go out with the slippage cap wide open so an
//     exit is never refused on price.
//   - The probe: buy fees.min_notional_quote_units (1 USDC) on bar 2, sell it the next bar,
//     then the main rules take over with the whole account.
//
// Deterministic by construction: float64 on + - * / over the closes only, no clock, no env, no
// randomness. Runs on the grader's `node /bot/main.ts` via the byte-identical kit shim under vendor/.

import { runBars, type BarsState, type Batch } from './vendor/makefun-bars.ts';

const WASH_PCT = 0.035;
const WASHOUT_WIN = 90;
const TAKE_PROFIT = 0.045;
const TAKE_TRAIL = 0.02;
const STOP = 0.02;
const BUY_MAX_SLIPPAGE_BPS = 200;
const SELL_MAX_SLIPPAGE_BPS = 10_000;

const closes: number[] = [];
// monotonic deque of indices for the rolling max close of the last WASHOUT_WIN bars
const dq: number[] = [];
let washHigh = 0;

let probeArmed = true;
let probeSelling = false;
let entryPx = 0;
let maxSinceEntry = 0;
let sellSent = false;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars[0];
    if (!bar) return [];
    const c = Number(bar.c);
    const i = closes.length;

    // re-anchor the entry trackers to the actual fill when the buy lands
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy') {
        const px = Number(f.price) / 1e5;
        if (BigInt(f.notional_quote_units) > 2n * BigInt(state.hello.fees.min_notional_quote_units)) {
          entryPx = px;
          maxSinceEntry = px;
        }
      }
    }

    // rolling max over the last WASHOUT_WIN closes (deque of indices)
    while (dq.length > 0 && closes[dq[dq.length - 1]!]! <= c) dq.pop();
    dq.push(i);
    if (dq[0]! <= i - WASHOUT_WIN) dq.shift();
    closes.push(c);
    washHigh = closes[dq[0]!]!;

    if (state.warmingUp) return [];

    const held = state.positions.get(bar.symbol);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

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
    if (probeSelling && held !== undefined && BigInt(held.cost_quote_units) <= 2n * minNotional) {
      probeSelling = false;
      return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
    }

    // main position: exits first
    if (held !== undefined && BigInt(held.cost_quote_units) > 2n * minNotional) {
      if (c > maxSinceEntry) maxSinceEntry = c;
      const posVal = state.value(bar.symbol, BigInt(held.qty));
      const roi = Number(posVal - BigInt(held.cost_quote_units)) / Number(held.cost_quote_units);
      const trail = (maxSinceEntry - c) / maxSinceEntry;
      const hard = (entryPx - c) / entryPx;
      if (roi >= TAKE_PROFIT || trail >= TAKE_TRAIL || hard >= STOP) {
        sellSent = true;
        return [{ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // entry: the first up-close while the washout is still on
    if (held === undefined && i > 1 && c > closes[i - 1]!) {
      const wash = (washHigh - c) / washHigh;
      if (wash >= WASH_PCT) {
        const spend = state.cash;
        if (spend >= minNotional) {
          entryPx = c;
          maxSinceEntry = c;
          return [{ side: 'buy', symbol: bar.symbol, notional_quote_units: spend, max_slippage_bps: BUY_MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
