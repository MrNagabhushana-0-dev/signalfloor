"""SignalFloor Market Analyst agent (BAND remote agent).
Computes real market signals from public data and posts them to the BAND room
for the Trade Executor. SIMULATION ONLY - analysis demo, not investment advice."""
import asyncio, logging, os, re, sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from band import Agent, configure_logging
from band.adapters import LangGraphAdapter
from band.runtime.formatters import strip_leading_mentions

from signals import fetch_snapshots, pick_signal
from envelope import last_sender_and_text

configure_logging(logging.INFO)
log = logging.getLogger("market-analyst")

WATCHLIST = os.environ.get("WATCHLIST", "RELIANCE.NS,TCS.NS,INFY.NS,HDFCBANK.NS,ITC.NS").split(",")
CYCLE_SECONDS = int(os.environ.get("CYCLE_SECONDS", "900"))
MAX_CYCLES = int(os.environ.get("MAX_CYCLES", "0"))  # 0 = run forever (deployment); tests set a bound
DEMO_MODE = os.environ.get("DEMO_MODE", "true").lower() == "true"
POST_STATUS = os.environ.get("POST_STATUS", "true").lower() == "true"  # post visible NO-TRADE status on flat cycles
EXECUTOR_HANDLE = os.environ.get("EXECUTOR_HANDLE", "mr.nagabhushana.dev/trade-executor")
ROOM_ID = os.environ.get("BAND_ROOM_ID", "49aadbc7-32f4-4a1b-b3b0-2e69307defef")

SENDER = re.compile(r"^\[(?P<sender>[^\]]+)\]:\s*(?P<text>.*)$", re.DOTALL)
checkpointer = InMemorySaver()
send_tool = None  # captured from band tools on first graph build

def format_signal(sym, side, s, reason):
    return (f"SIGNAL {sym} {side} price={s['price']} asof={s.get('asof','?')} sma10={s['sma10']} sma30={s['sma30']} "
            f"rsi14={s['rsi14']} change1d={s['change_pct']}% reason=\"{reason}\" "
            f"(delayed public daily-bar data via yfinance as of {s.get('asof','?')}; educational simulation, not investment advice)")

def _load_creds(key):
    import yaml
    cfg = yaml.safe_load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agent_config.yaml")))
    return cfg[key]["agent_id"], cfg[key]["api_key"]

async def signal_loop():
    """Periodically compute signals and post them to the room via the REST choke
    point (posting works even before any inbound message builds the graph)."""
    from band.client.rest import AsyncRestClient, ChatMessageRequest, ChatMessageRequestMentionsItem
    from band.platform.posting import post_message
    _, api_key = _load_creds("market_analyst")
    rest = AsyncRestClient(api_key=api_key)
    mention = ChatMessageRequestMentionsItem(handle=EXECUTOR_HANDLE, kind="mention")
    print(f"[market-analyst] signal loop started watchlist={WATCHLIST} cycle={CYCLE_SECONDS}s demo={DEMO_MODE}", flush=True)
    await asyncio.sleep(8)  # let both agents settle into the room
    cycle = 0
    while True:
        cycle += 1
        if MAX_CYCLES and cycle > MAX_CYCLES:
            print(f"[market-analyst] MAX_CYCLES={MAX_CYCLES} reached; stopping signal loop", flush=True)
            return
        try:
            snaps = await asyncio.to_thread(fetch_snapshots, WATCHLIST)
            sig = pick_signal(snaps, demo=DEMO_MODE)
            if sig:
                sym, side, s, reason = sig
                resp = await post_message(rest=rest, room_id=ROOM_ID,
                                          request=ChatMessageRequest(content=format_signal(sym, side, s, reason),
                                                                     mentions=[mention]))
                print(f"[market-analyst] posted signal {sym} {side} @ {s['price']} resp={bool(resp)}", flush=True)
            else:
                log.info("no actionable signal this cycle")
                if POST_STATUS:
                    notes = []
                    for sym2, s2 in snaps.items():
                        fz2 = (s2 or {}).get("finch") or {}
                        if fz2.get("reason"):
                            notes.append(f"{sym2}: {fz2['reason']}")
                    note = ("STATUS NO-TRADE cycle (strategy v2, Finch RSI zone-transition, delayed public data): "
                            + (" | ".join(notes) if notes else "no market data"))
                    resp = await post_message(rest=rest, room_id=ROOM_ID,
                                              request=ChatMessageRequest(content=note, mentions=[mention]))  # BAND requires >=1 mention
                    print(f"[market-analyst] posted no-trade status resp={bool(resp)}", flush=True)
        except Exception:
            import traceback; traceback.print_exc()
        await asyncio.sleep(CYCLE_SECONDS)

def graph_factory(band_tools: list[Any]):
    global send_tool
    send_message = next(t for t in band_tools if t.name == "band_send_message")
    send_tool = send_message

    async def reply(state: MessagesState) -> dict[str, list[Any]]:
        if not state["messages"]:
            return {"messages": []}
        content = str(state["messages"][-1].content)
        msg, text = last_sender_and_text(content, strip_leading_mentions)
        sender = (msg or {}).get("sender_id") or None
        low = text.lower()
        is_agent = (msg or {}).get("sender_type") == "Agent"
        if is_agent and not (low.startswith("analyze") or "snapshot" in low or "status" in low):
            print(f"[market-analyst] ignoring agent chatter: {text[:80]!r}", flush=True)
            return {"messages": []}
        if low.startswith("analyze") or "snapshot" in low or "status" in low:
            snaps = await asyncio.to_thread(fetch_snapshots, WATCHLIST)
            lines = []
            for sym, s in snaps.items():
                if "error" in s:
                    lines.append(f"{sym}: data unavailable")
                else:
                    lines.append(f"{sym}: {s['price']} ({s['change_pct']:+}% 1d) sma10 {s['sma10']} sma30 {s['sma30']} rsi {s['rsi14']}")
            answer = "MARKET SNAPSHOT (delayed public data via yfinance; educational simulation)\n" + "\n".join(lines)
        else:
            answer = ("Market Analyst online. I compute SMA/RSI signals on " + ",".join(WATCHLIST) +
                      " from public market data and share them here for the Trade Executor. "
                      "Say 'analyze' for a fresh snapshot. Simulation demo only.")
        try:
            await send_message.ainvoke({"content": answer, "mentions": [sender] if sender else []})
        except Exception as e:
            print(f"[market-analyst] reply send failed: {e!r}", flush=True)
            await send_message.ainvoke({"content": answer})
        return {"messages": []}

    builder = StateGraph(MessagesState)
    builder.add_node("reply", reply)
    builder.add_edge(START, "reply")
    builder.add_edge("reply", END)
    return builder.compile(checkpointer=checkpointer)

async def main() -> None:
    adapter = LangGraphAdapter(graph_factory=graph_factory)
    agent = Agent.from_config("market_analyst", adapter=adapter)
    loop_task = asyncio.create_task(signal_loop())
    try:
        await agent.run()
    finally:
        loop_task.cancel()

if __name__ == "__main__":
    asyncio.run(main())
