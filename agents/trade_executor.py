"""SignalFloor Trade Executor agent (BAND remote agent).
Listens for SIGNAL messages from the Market Analyst, risk-checks them and books
SIMULATED paper trades. No real orders, no brokerage connection, simulation only."""
import asyncio, logging, os, re, sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from band import Agent, configure_logging
from band.adapters import LangGraphAdapter
from band.runtime.formatters import strip_leading_mentions

from portfolio import PaperPortfolio
from signals import fetch_snapshots
from envelope import last_sender_and_text

configure_logging(logging.INFO)
log = logging.getLogger("trade-executor")

PORTFOLIO_PATH = os.environ.get("PORTFOLIO_PATH", os.path.expanduser("~/festiverse/data/paper_portfolio.json"))
def _cfg_value(key):
    import yaml
    cfg = yaml.safe_load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agent_config.yaml")))
    return cfg.get(key)

ANALYST_HANDLE = os.environ.get("ANALYST_HANDLE") or _cfg_value("analyst_handle")
if not ANALYST_HANDLE:
    raise SystemExit("Set ANALYST_HANDLE via env or agent_config.yaml (see README); no defaults are shipped in source.")

SENDER = re.compile(r"^\[(?P<sender>[^\]]+)\]:\s*(?P<text>.*)$", re.DOTALL)
SIGNAL = re.compile(r"SIGNAL\s+(?P<sym>[A-Z0-9\.\^\-]+)\s+(?P<side>BUY|SELL)\s+price=(?P<price>[0-9\.]+)", re.I)
checkpointer = InMemorySaver()
book = PaperPortfolio(PORTFOLIO_PATH)

def graph_factory(band_tools: list[Any]):
    send_message = next(t for t in band_tools if t.name == "band_send_message")

    async def reply(state: MessagesState) -> dict[str, list[Any]]:
        if not state["messages"]:
            return {"messages": []}
        content = str(state["messages"][-1].content)
        msg, text = last_sender_and_text(content, strip_leading_mentions)
        sender = (msg or {}).get("sender_id") or None
        sender_name = (msg or {}).get("sender_name", "unknown")
        print(f"[trade-executor] inbound from {sender_name} ({(msg or {}).get('sender_type')}): {text[:120]!r}", flush=True)
        is_agent = (msg or {}).get("sender_type") == "Agent"
        sig = SIGNAL.search(text)
        if is_agent and not sig and not any(k in text.lower() for k in ("status", "portfolio", "p&l", "pnl")):
            print(f"[trade-executor] ignoring agent chatter: {text[:80]!r}", flush=True)
            return {"messages": []}
        if sig:
            sym, side, price = sig.group("sym").upper(), sig.group("side").upper(), float(sig.group("price"))
            ok, msg = book.try_fill(sym, side, price)
            print(f"[trade-executor] signal {sym} {side} @ {price} -> {msg}", flush=True)
            marks = {}
            try:
                open_syms = list(book.state["positions"].keys())
                if open_syms:
                    snaps = await asyncio.to_thread(fetch_snapshots, open_syms)
                    marks = {k: v["price"] for k, v in snaps.items() if "error" not in v}
            except Exception as e:
                print(f"[trade-executor] mark fetch failed ({e!r}); reporting at cost", flush=True)
            answer = f"{msg}. {book.report(marks=marks or None)} (marks: delayed public data, live-fetched)"
        elif "status" in text.lower() or "p&l" in text.lower() or "pnl" in text.lower() or "portfolio" in text.lower():
            snaps = await asyncio.to_thread(fetch_snapshots, list(book.state["positions"].keys()) or ["RELIANCE.NS"])
            marks = {k: v["price"] for k, v in snaps.items() if "error" not in v}
            answer = book.report(marks=marks)
        else:
            answer = ("Trade Executor online. I receive SIGNAL messages from the Market Analyst, "
                      "run risk checks (position limits, no shorting, paper cash), and book simulated "
                      "fills on a paper portfolio. Say 'status' for current P&L. Simulation only - no real trades.")
        try:
            mentions = [sender] if sender else []
            r = await send_message.ainvoke({"content": answer, "mentions": mentions})
            print(f"[trade-executor] reply sent: {str(r)[:120]}", flush=True)
        except Exception as e:
            print(f"[trade-executor] mention send failed ({e!r}); retrying without mention", flush=True)
            try:
                r = await send_message.ainvoke({"content": answer})
                print(f"[trade-executor] reply sent (no mention): {str(r)[:120]}", flush=True)
            except Exception as e2:
                print(f"[trade-executor] plain send failed: {e2!r}", flush=True)
        return {"messages": []}

    builder = StateGraph(MessagesState)
    builder.add_node("reply", reply)
    builder.add_edge(START, "reply")
    builder.add_edge("reply", END)
    return builder.compile(checkpointer=checkpointer)

async def main() -> None:
    adapter = LangGraphAdapter(graph_factory=graph_factory)
    agent = Agent.from_config("trade_executor", adapter=adapter)
    await agent.run()

if __name__ == "__main__":
    asyncio.run(main())
