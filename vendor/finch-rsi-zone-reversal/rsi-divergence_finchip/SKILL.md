---
name: rsi-divergence
description: Mean-reversion structure that acts on the RSI *crossing back out* of an extreme zone rather than on RSI being extreme. The distinction removes the classic failure where a strategy buys repeatedly while RSI stays pinned below its oversold line. Use when an agent needs a reversal rule on a slow timeframe, or must explain why "RSI below 30" is a state and not a signal.
license: Apache-2.0
---

# RSI Zone Reversal

The most common RSI bug is treating an extreme as an event. RSI below 30 can persist for dozens of bars in a downtrend, and a strategy that buys on the state will add into a falling market for as long as the state lasts.

This package requires a **transition**: the previous RSI value must be inside the extreme zone and the current value outside it. That single condition removes the repeated-entry failure mode entirely and makes each signal a genuine change of state. The RSI itself is Wilder-smoothed, which is the original definition - different from the simple-average variant some libraries ship, so expect small numeric differences from a chart at identical settings.

## When to use this

- An agent has to decide whether an oversold reading is actionable yet.
- You need a reversal entry that cannot fire twice on the same extreme.
- You are diagnosing a mean-reversion strategy that keeps adding into a trend.

Poor fit for strongly trending instruments: on a slow timeframe a trend can keep RSI above the overbought line for a very long time, so the exit never triggers.

## What this package deliberately does not contain

This is a **framework release**, not the tuned production build. Specifically:

- **No position sizing or stop.** Reversal entries need a hard invalidation level and that is yours to define.
- **No true divergence detection.** Despite the family name, this implements the zone-transition rule, not a price/RSI swing comparison. Divergence detection needs swing identification, which is a separate and much more fragile problem.
- **No tuned period or zone levels.**

- **No default thresholds in code.** `scripts/rsi_zone_reversal.py` raises `PARAM_INCOMPLETE`
  rather than falling back to a number. A silent default would make you believe
  you are running a calibrated system when you are running someone else's
  parameters.

Every decision boundary is an input. That is the whole contract.

## Decision contract

| `action` | Condition |
|---|---|
| `long` | Previous RSI below the oversold line **and** current RSI at or above it |
| `exit` | Previous RSI above the overbought line **and** current RSI at or below it |
| `flat` | No zone transition |

Response carries `rsi_now` and `rsi_prev` so the transition - not just the level - is visible in your logs.

## Output schema

```json
{
  "action": "long",
  "price": 61840.0,
  "rsi_now": 29.4,
  "rsi_prev": 27.1,
  "oversold": 28.0,
  "overbought": 72.0,
  "reason": "RSI recovered out of oversold (27.1 -> 29.4)"
}
```

`action` is the only field you must branch on. `reason` is meant for logs and for
an agent to quote back to a human — do not parse it.

## Run it

```bash
python3 scripts/rsi_zone_reversal.py \
  --params references/params-example.json \
  --symbol BTC/USDT \
  --interval 4h
```

`references/params-example.json` holds **round, obviously-illustrative numbers**.
They exist so the command runs on the first try, not because they are good.

Feeding position state in:

```bash
python3 scripts/rsi_zone_reversal.py --params my.json --state '{"avg_entry": 61250.5, "layers": 2}'
```

## Calibrating the thresholds

1. **`rsi_period`** - the lookback. Wilder smoothing makes the value respond slowly; a short period makes the zones meaningless because RSI oscillates through them constantly.
2. **`oversold` / `overbought`** - measure, do not guess. Compute the empirical distribution of RSI on your symbol and timeframe, then place the zone edges at the percentiles that produce the signal frequency you can actually act on. Symmetric 30/70 is a convention, not an optimum.
3. Keep the zones **away** from 0 and 100. Wide zones produce almost no transitions; very narrow zones produce transitions on noise.

Hold out the most recent ~30% of bars. Count how many signals occur in each block - a rule that fires twice in a year is not calibratable, it is a coincidence.

## Known limits

- Requires at least `rsi_period + 2` closed bars before it can produce any transition; with less history it returns `flat` with a diagnostic.
- Wilder smoothing means the first `period` values carry a fixed-seed bias. On short fetches this shows up as a shifted RSI level.
- No trend filter. In a persistent downtrend the oversold transitions keep firing and each one loses; pairing this with a regime filter is strongly recommended and is left to the caller.
- The forming bar is excluded, so decisions do not repaint.

## Disclaimer

This is a decision framework for research and education. It is not investment
advice, not a profit claim, and not a backtest result. Crypto derivatives can
lose more than the deposit. You are responsible for the parameters you choose
and for every order your executor places.
