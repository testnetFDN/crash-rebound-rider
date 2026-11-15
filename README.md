# crash-rebound rider

A long-only CBBTC/USDC trading bot for [make.fun](https://make.fun) bounty
[btc-race-24h-20261115-0828](https://make.fun/bounty/btc-race-24h-20261115-0828) —
"Race a BTC trading bot live for 24 hours".

The bot speaks `agent-fun/bars-replay/v1`: it reads one JSON line per minute (a 1-minute
cbBTC bar from its Orca Whirlpool pool on Solana) and answers with buy/sell orders that
fill at the next minute's open, with 4 bps fee, 2 bps slippage and modelled price impact.

## Strategy

Wait in cash; buy a washed-out dip the minute it first ticks up; ride the rebound; hand
the position back on take-profit, a trailing stop or a hard stop.

- **Washout**: the close is 3.5% below the highest close of the last 90 minutes — a
  velocity filter that only a genuine capitulation trips; a slow drift never does.
- **Confirmation**: the first close above the previous close after the washout — the
  buy lands near the low, not in the falling knife.
- **Exit**: +4.5% over the filled cost, a 2% trailing stop off the best close since the
  fill, or a 2% hard stop below the fill.
- **Guardrail probe**: one 1-USDC round trip near the start guarantees the race window's
  "at least 1 trade" bar at negligible cost.

Deterministic by construction: float64 arithmetic over the closes only — no clock, no
environment, no randomness. Two runs produce byte-identical action logs.

## Layout

- `main.ts` — the bot (Node 22, stdlib only, no install step)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim

## License

MIT — see [LICENSE](LICENSE).
