"""Paper portfolio for SignalFloor. SIMULATION ONLY - no real trades."""
import json, os, threading

class PaperPortfolio:
    def __init__(self, path, starting_cash=1_000_000.0, max_position_pct=0.25, max_open=5):
        self.path = path
        self.lock = threading.Lock()
        self.max_position_pct = max_position_pct
        self.max_open = max_open
        if os.path.exists(path):
            self.state = json.load(open(path))
        else:
            self.state = {"cash": starting_cash, "starting_cash": starting_cash,
                          "positions": {}, "trades": []}
            self._save()

    def _save(self):
        tmp = self.path + ".tmp"
        json.dump(self.state, open(tmp, "w"), indent=1)
        os.replace(tmp, self.path)

    def try_fill(self, symbol, side, price, qty_hint=None):
        """Risk-checked simulated fill. Returns (ok, message)."""
        with self.lock:
            cash = self.state["cash"]
            pos = self.state["positions"]
            if side == "BUY":
                if symbol not in pos and len(pos) >= self.max_open:
                    return False, f"risk check failed: max {self.max_open} open positions"
                budget = min(cash, self.state["starting_cash"] * self.max_position_pct)
                qty = qty_hint or max(1, int(budget // price))
                cost = round(qty * price, 2)
                if cost > cash:
                    return False, f"risk check failed: insufficient paper cash ({cash:.2f} < {cost:.2f})"
                p = pos.get(symbol, {"qty": 0, "avg": 0.0})
                new_qty = p["qty"] + qty
                p["avg"] = round((p["avg"] * p["qty"] + cost) / new_qty, 2)
                p["qty"] = new_qty
                pos[symbol] = p
                self.state["cash"] = round(cash - cost, 2)
                self.state["trades"].append({"side": "BUY", "symbol": symbol, "qty": qty, "price": price})
                self._save()
                return True, f"SIM BUY {qty} {symbol} @ {price} (avg {p['avg']})"
            else:
                p = pos.get(symbol)
                if not p or p["qty"] <= 0:
                    return False, f"risk check failed: no open {symbol} position to sell (no shorting)"
                qty = p["qty"]
                proceeds = round(qty * price, 2)
                pnl = round((price - p["avg"]) * qty, 2)
                del pos[symbol]
                self.state["cash"] = round(cash + proceeds, 2)
                self.state["trades"].append({"side": "SELL", "symbol": symbol, "qty": qty, "price": price, "pnl": pnl})
                self._save()
                return True, f"SIM SELL {qty} {symbol} @ {price} (trade P&L {pnl:+.2f})"

    def report(self, marks=None):
        with self.lock:
            inv = 0.0
            lines = []
            for sym, p in self.state["positions"].items():
                mark = (marks or {}).get(sym, p["avg"])
                val = mark * p["qty"]
                inv += val
                lines.append(f"{sym}: {p['qty']} @ avg {p['avg']} (mark {mark})")
            total = self.state["cash"] + inv
            pnl = total - self.state["starting_cash"]
            pos_txt = "; ".join(lines) if lines else "no open positions"
            return (f"PAPER PORTFOLIO cash {self.state['cash']:.2f} | invested {inv:.2f} | "
                    f"total {total:.2f} | P&L {pnl:+.2f} ({pnl/self.state['starting_cash']*100:+.2f}%) | "
                    f"{len(self.state['trades'])} trades | {pos_txt}")
