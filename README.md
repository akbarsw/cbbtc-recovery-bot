# cbBTC Recovery Bot

[![make.fun competition](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/akbarsw/cbbtc-recovery-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/akbarsw/cbbtc-recovery-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

Entry for the [make.fun](https://make.fun) competition
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444):
a bot that trades Coinbase Wrapped BTC (cbBTC) on 1-minute on-chain
prices with $1,000 of paper money, speaking the
agent-fun/bars-replay/v1 protocol (a hello, then one batch per
one-minute bar; the bot answers each batch with its orders, and an
order decided on one bar fills at the next bar's open), with the
replay's fees, slippage and price impact.

Strategy: the bot holds cash by default and never buys a falling bar.
A selloff arms it: once the close sits at least 1.0% under where it was
105 bars earlier, it waits for the turn, a close back above its 20-bar
exponential moving average while that average has started to rise, and
only then buys a first leg of 40% of equity. If the price falls a
further 0.55% under the first fill and turns up for one bar, it adds a
second 40% leg. It sells everything on a 1.1% take-profit over blended
cost, a 1.4% stop, a trailing give-back of 0.6% once a gain of 0.8% is
armed, or after 420 bars, then cools down for 30 bars. Late in a window
where no selloff ever armed an entry, one small insurance trade keeps
it participating with a tightly bounded cost.

Run: `node main.ts` (Node 22) with the bars harness on stdin/stdout.
Standard library only; the protocol shim lives in `vendor/makefun-bars.ts`.
Deterministic: float math on the bars only, no clock, no network, no
files, no randomness.

MIT License. See [LICENSE](LICENSE).
