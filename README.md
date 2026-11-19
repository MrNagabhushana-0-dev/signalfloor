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

- **BAND** — agent registration, A2A room transport, mentions, history (core).
- **Agent37** — sandbox hosting for the always-on agents *(planned)*.
- **AdaL** — demo walkthrough video *(planned)*.

## Signals

Per watchlist symbol (default: `RELIANCE.NS,TCS.NS,INFY.NS,HDFCBANK.NS,ITC.NS`):

- `BUY`  when SMA10 > SMA30 with RSI < 70, or RSI ≤ 30 (oversold)
- `SELL` when SMA10 < SMA30 with RSI > 30, or RSI ≥ 70 (overbought)

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
# agent_config.yaml holds your own BAND agent IDs + API keys:
#   market_analyst: {agent_id: "...", api_key: "..."}
#   trade_executor: {agent_id: "...", api_key: "..."}
python agents/trade_executor.py &
MAX_CYCLES=4 CYCLE_SECONDS=300 DEMO_MODE=true python agents/market_analyst.py
```

`DEMO_MODE=true` guarantees one signal per cycle so the A2A loop is
demonstrable; with it off, the analyst only speaks when the rules fire.
