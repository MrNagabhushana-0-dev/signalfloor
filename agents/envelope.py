"""Parse the BAND adapter's inbound message envelope (JSON lines after a header)."""
import json

def parse_messages(content):
    out = []
    for line in str(content).splitlines():
        line = line.strip()
        if line.startswith("{") and '"sender_id"' in line:
            try:
                o = json.loads(line)
                if isinstance(o, dict) and "content" in o:
                    out.append(o)
            except Exception:
                continue
    return out

def last_sender_and_text(content, strip_fn=None):
    msgs = parse_messages(content)
    if not msgs:
        return None, str(content)
    m = msgs[-1]
    text = m["content"]
    if strip_fn:
        text = strip_fn(text).strip()
    return m, text
