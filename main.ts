// cbBTC recovery bot for the make.fun 24h bars race.
//
// Wire format: agent-fun/bars-replay/v1. After a hello the harness
// streams one batch per one-minute CBBTC bar; each batch is answered
// with the orders chosen on that bar, and those orders fill at the
// following bar's open.
//
// Approach in one paragraph: cash is the default state. The bot only
// acts after a real selloff, defined as the latest close sitting at
// least one percent below the close 105 bars earlier. A selloff alone
// is not a buy signal; price must also reclaim the 20 bar exponential
// moving average while that average is rising again over a 5 bar
// slope. The first purchase spends 40 percent of equity. Should price
// then slide another 0.55 percent under the first decision close and
// print an up bar, a second 40 percent leg is added rather than
// stopping out early. Positions exit on a 1.1 percent profit over
// blended cost, a 1.4 percent loss, a 0.6 percent give-back from the
// peak once the peak gain reached 0.8 percent, or a 420 bar time
// stop, followed by a 30 bar cooldown. If a whole window passes with
// no selloff entry, a single late insurance position of 25 percent
// (out at +0.5 percent, -0.7 percent, or 150 bars) keeps the bot in
// the market with a small, bounded downside.
//
// The bot is a pure function of the bar stream: no clock reads, no
// network, no file access, no randomness, so two runs on the same
// window produce identical orders.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const ASSET = 'CBBTC';

// Selloff measurement and trend confirmation.
const LOOKBACK_BARS = 105;
const SELLOFF_LIMIT = -0.01;
const AVERAGE_SPAN = 20;
const SLOPE_SPAN = 5;

// Position sizing, as integer percents of current equity.
const FIRST_LEG_PCT = 40n;
const SECOND_LEG_PCT = 40n;
const SECOND_LEG_DIP = 0.0055;

// Exit rules on position value relative to its cost basis.
const PROFIT_TARGET = 0.011;
const LOSS_LIMIT = -0.014;
const TRAIL_TRIGGER = 0.008;
const TRAIL_RETRACE = 0.994;
const TIME_STOP_BARS = 420;
const REST_BARS = 30;

// Fallback participation trade when nothing else fired.
const FALLBACK_EARLIEST = 1050;
const FALLBACK_PCT = 25n;
const FALLBACK_PROFIT = 0.005;
const FALLBACK_LOSS = -0.007;
const FALLBACK_TIME_STOP = 150;

const MAX_SLIPPAGE_BPS = 60;

const closeSeries: number[] = [];
const averageSeries: number[] = [];
let positionSince = -1;
let bestRatioSeen = 1;
let restUntilSeq = -1;
let exitRequested = false;
let firstDecisionClose = 0;
let secondLegDone = false;
let fallbackTrade = false;
let entriesMade = 0;

function equityPercent(pct: bigint, equity: bigint): bigint {
  // Integer percent of equity; bigint division truncates toward zero,
  // which only ever rounds the spend down by less than one unit.
  return equity * pct / 100n;
}

await runBars({
  onBatch(state, batch) {
    const currentBar = state.latest.get(ASSET);
    if (currentBar === undefined) return [];
    const closeNow = Number(currentBar.c);
    closeSeries.push(closeNow);
    const previousAverage =
      averageSeries.length === 0 ? closeNow : averageSeries[averageSeries.length - 1];
    const averageNow =
      averageSeries.length === 0
        ? closeNow
        : previousAverage + (2 / (AVERAGE_SPAN + 1)) * (closeNow - previousAverage);
    averageSeries.push(averageNow);
    const seqNow = state.seq;
    const planned: (BuyInput | SellInput)[] = [];

    const openPosition = state.positions.get(ASSET);
    const inPosition = openPosition !== undefined && openPosition.qty > 0n;

    if (inPosition) {
      if (positionSince < 0) {
        positionSince = seqNow;
        bestRatioSeen = 1;
        if (firstDecisionClose === 0) firstDecisionClose = closeNow;
      }
      const valueRatio = Number(state.value(ASSET, openPosition.qty)) / Number(openPosition.cost);
      if (valueRatio > bestRatioSeen) bestRatioSeen = valueRatio;
      const moveFromCost = valueRatio - 1;
      const profitLine = fallbackTrade ? FALLBACK_PROFIT : PROFIT_TARGET;
      const lossLine = fallbackTrade ? FALLBACK_LOSS : LOSS_LIMIT;
      const timeLine = fallbackTrade ? FALLBACK_TIME_STOP : TIME_STOP_BARS;
      const trailingHit =
        bestRatioSeen - 1 >= TRAIL_TRIGGER && valueRatio <= bestRatioSeen * TRAIL_RETRACE;
      const shouldExit =
        moveFromCost >= profitLine ||
        moveFromCost <= lossLine ||
        seqNow - positionSince >= timeLine ||
        trailingHit;
      if (shouldExit && !exitRequested) {
        exitRequested = true;
        restUntilSeq = seqNow + REST_BARS;
        planned.push({
          side: 'sell',
          symbol: ASSET,
          qty: openPosition.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        return planned;
      }
      const dippedFurther =
        !fallbackTrade &&
        !secondLegDone &&
        firstDecisionClose > 0 &&
        closeNow <= firstDecisionClose * (1 - SECOND_LEG_DIP);
      const turningUp = closeNow > closeSeries[closeSeries.length - 2];
      if (dippedFurther && turningUp) {
        const spend = equityPercent(SECOND_LEG_PCT, state.equity);
        const minSpend = BigInt(state.hello.fees.min_notional_quote_units);
        if (spend >= minSpend && spend <= state.cash) {
          secondLegDone = true;
          planned.push({
            side: 'buy',
            symbol: ASSET,
            notional_quote_units: spend,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
      return planned;
    }

    // Flat again: clear the per-trade trackers before judging entries.
    positionSince = -1;
    bestRatioSeen = 1;
    exitRequested = false;
    firstDecisionClose = 0;
    secondLegDone = false;
    fallbackTrade = false;

    if (seqNow < restUntilSeq) return planned;
    if (closeSeries.length <= LOOKBACK_BARS + SLOPE_SPAN) return planned;

    const referenceClose = closeSeries[closeSeries.length - 1 - LOOKBACK_BARS];
    const windowMove = closeNow / referenceClose - 1;
    const averageFiveBack = averageSeries[averageSeries.length - 1 - SLOPE_SPAN];
    const trendTurned = closeNow > averageNow && averageNow > averageFiveBack;
    const minSpend = BigInt(state.hello.fees.min_notional_quote_units);

    if (windowMove <= SELLOFF_LIMIT && trendTurned) {
      const spend = equityPercent(FIRST_LEG_PCT, state.equity);
      if (spend >= minSpend) {
        positionSince = seqNow;
        firstDecisionClose = closeNow;
        entriesMade += 1;
        planned.push({
          side: 'buy',
          symbol: ASSET,
          notional_quote_units: spend,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
      return planned;
    }

    const fallbackDue =
      entriesMade === 0 &&
      seqNow >= FALLBACK_EARLIEST &&
      closeNow > averageNow &&
      closeNow > closeSeries[closeSeries.length - 2];
    if (fallbackDue) {
      const spend = equityPercent(FALLBACK_PCT, state.equity);
      if (spend >= minSpend) {
        positionSince = seqNow;
        firstDecisionClose = closeNow;
        fallbackTrade = true;
        entriesMade += 1;
        planned.push({
          side: 'buy',
          symbol: ASSET,
          notional_quote_units: spend,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
    return planned;
  },
});
