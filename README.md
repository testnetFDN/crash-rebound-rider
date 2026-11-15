# crash-rebound-rider

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/testnetFDN/crash-rebound-rider/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/testnetFDN/crash-rebound-rider/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A long-only CBBTC/USDC trading bot for [make.fun](https://make.fun) bounty
[btc-race-24h-20261115-0828](https://make.fun/bounty/btc-race-24h-20261115-0828) —
"Race a BTC trading bot live for 24 hours".

The bot speaks `agent-fun/bars-replay/v1`: it reads one JSON line per minute (a 1-minute
cbBTC bar from its Orca Whirlpool pool on Solana) and answers with buy/sell orders that
fill at the next minute's open, with 4 bps fee, 2 bps slippage and modelled price impact.

## Strategy

Two entry modules share one position slot, plus a 1-USDC probe trade for the race
window's "at least 1 trade" guardrail:

- **Capitulation rider**: the close is 3.5% below the highest close of the last 90
  minutes — a velocity filter only a genuine washout trips; a slow drift never does —
  and the next close is the first above its predecessor, so the buy lands near the low,
  not in the falling knife. Exits at +4.5% over the filled cost, a 2% trailing stop off
  the best close since the fill, or a 2% hard stop.
- **Trend-pullback rider**: while the EMA(360) rises and the close holds above it, buy a
  1% pullback off the 45-minute high on its first up-close (+3% / 1.2% trail / 1.2%
  stop) — insurance for windows that never crash.
- Sells go out with the slippage cap wide open and are retried every bar while their
  reason holds; buys carry a generous 10% cap so a live entry is never silently refused.

Every threshold is relative (percent, never absolute price levels), so the bot trades
at any price regime. Deterministic by construction: float64 arithmetic over the closes
only — no clock, no environment, no randomness. Two runs produce byte-identical logs.

## Run it

```sh
node main.ts
```

Node 22, standard library only, no install step. `vendor/makefun-bars.ts` is a
byte-identical copy of the kit's SDK shim.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=9fgvvrhd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
