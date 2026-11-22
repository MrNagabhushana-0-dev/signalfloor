# SignalFloor

Agent-to-agent market analysis and **simulated** paper-trading demo built on [BAND](https://www.band.ai) rooms.

Built for **Diwali Festiverse: The Agent-to-Agent Hackathon (India Edition)** — team **0dev**.

> **Simulation only.** All trades are booked against a local paper portfolio.
> There is no brokerage connection, no real order placement, and no live-market
> data feed: quotes are **delayed public daily-bar data** pulled via `yfinance`.
> Nothing here is investment advice, and simulated results are not evidence of
> real-world performance.

## Architecture

```
┌──────────────────────────── BAND room ───────────────────────────┐
│                                                                  │
│  Market Analyst (remote agent)        Trade Executor (remote)    │
│  -----------------------------        -----------------------    │
│  • pulls delayed daily bars           • listens for SIGNAL msgs  │
│    via yfinance                       • risk checks: no shorting,│
│  • computes SMA(10/30) + RSI(14)        position cap, cash cap   │
│  • posts SIGNAL messages to the       • books SIMULATED fills on │
│    room, @mentioning the executor       a paper portfolio        │
│                                       • replies with marked P&L  │
└──────────────────────────────────────────────────────────────────┘
```

The agents talk to each other through the BAND room — the analyst never calls
the executor directly. A human can join the same room and ask either agent for
a snapshot (`analyze`) or portfolio status (`status`).

## Sponsor platforms

- **BAND** — agent registration, A2A room transport, mentions, history (core, in use).
- **Finch** — the RSI Zone Reversal skill (free, Apache-2.0) is vendored under
  `vendor/finch-rsi-zone-reversal/` with its LICENSE and governs v2 entries.
- **AdaL** — account created and CLI authenticated; video generation requires paid
  plan credits, not activated for this submission. The demo walkthrough video is
  assembled from scripted screen capture instead.
- **Lyzr** — signup was blocked by the site's bot protection during the hackathon
  window. No integration claimed.
- **Agent37** — persistent hosting requires a funded wallet; not activated. The
  free GitHub Pages snapshot serves as the public demo artifact.

## Strategy versions

Both evidence runs are from 2026-11-19 and labeled wherever they appear:

- **v1 (daytime)** — hand-rolled rules: simple-average RSI including the latest
  bar + SMA trend rules. Genuine fills: 2 x SIM BUY 106 TCS.NS (@ 2347.5, @ 2342.7)
  on an oversold reading (RSI 28.4). Watchlist narrowed to TCS.NS for the demo —
  a disclosed config choice.
- **v2 (evening)** — entries gated by the Finch skill: Wilder RSI on completed
  bars, entry only on crossing back OUT of oversold. Thresholds are ours
  (14 / 30 / 70); the skill ships no defaults by design. First v2 output was a
  verified NO-TRADE cycle (TCS 50.7 -> 47.0, no zone transition). No forced trades.

The RSI numbers differ by construction (simple vs Wilder, latest vs completed
bar); dashboard, this README and the pitch deck show both, labeled.

## Signals

Per watchlist symbol (default: `RELIANCE.NS,TCS.NS,INFY.NS,HDFCBANK.NS,ITC.NS`):

- v2 (current): the Finch RSI Zone Reversal skill evaluates the analyst's bars;
  `BUY` only on a transition back out of the oversold zone, `SELL` only on a
  transition back out of overbought.
- v1 (provenance): `BUY` when SMA10 > SMA30 with RSI < 70, or RSI ≤ 30
  (oversold); `SELL` when SMA10 < SMA30 with RSI > 30, or RSI ≥ 70 (overbought).

Every signal message carries its data provenance (`asof=` bar date) and a
delayed-data / simulation disclaimer.

## Repo layout

```
agents/
  market_analyst.py   # signal producer (BAND remote agent)
  trade_executor.py   # risk-checked simulated executor (BAND remote agent)
  signals.py          # yfinance fetch + SMA/RSI math
  portfolio.py        # paper portfolio with risk checks
  envelope.py         # BAND inbound message envelope parser
requirements.txt
agent_config.yaml     # NOT committed - BAND agent credentials (see below)
```

## Run it

```bash
uv venv --python 3.11 && source .venv/bin/activate
uv pip install -r requirements.txt
# agent_config.yaml holds your own BAND agent IDs + API keys, room and handles
# (no room or handle defaults are shipped in source - identifiers stay local):
#   market_analyst: {agent_id: "...", api_key: "..."}
#   trade_executor: {agent_id: "...", api_key: "..."}
#   room_id: "<your BAND room uuid>"
#   executor_handle: "<you>/trade-executor"
#   analyst_handle: "<you>/market-analyst"
# (env vars BAND_ROOM_ID / EXECUTOR_HANDLE / ANALYST_HANDLE also work)
python agents/trade_executor.py &
MAX_CYCLES=4 CYCLE_SECONDS=300 DEMO_MODE=true python agents/market_analyst.py
```

`DEMO_MODE=true` guarantees one signal per cycle so the A2A loop is
demonstrable; with it off, the analyst only speaks when the rules fire.
