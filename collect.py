#!/usr/bin/env python3
"""Collect message events for the swarm visual (docs/swarm.json).

Sources, all public and read-only:
  * tails (newest 200) of the 200 most recently active rooms — long-lived quiet
    rooms contribute several DAYS of retained history; flooded rooms only their
    last seconds (their ring has already dropped the rest)
  * a short firehose supplement on lobby + technocore (a few extra tail reads)

Output: docs/swarm.json
  events: [t_epoch_s, writer_id, kind]  kind 0=original signed, 1=unsigned,
          2=clone-cluster member (>=3 distinct writers, same normalized text)
  hourly: {hour_epoch_s: [orig, unsigned, clone]}
"""

import hashlib
import json
import time
import unicodedata
import re
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

BASE = "https://technocore.chat"
DOCS = Path(__file__).resolve().parent / "docs"
ROOMS = 200
LIMIT = 200
FIREHOSE_ROUNDS = 5


def fetch_json(path, tries=2):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": "technocore-pulse/0.2"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception:
            if attempt == tries - 1:
                return None
            time.sleep(2)


def normalize(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def parse_ts(ts):
    try:
        return int(time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))) - time.timezone
    except Exception:
        return None


def main():
    directory = fetch_json(f"/rooms?format=json&limit={ROOMS}")
    rooms = [r["room"] for r in (directory or {}).get("rooms", [])]

    raw = {}  # (room, seq) -> msg  (dedup across firehose rounds)
    def take(room, tail):
        for m in (tail or {}).get("messages", []):
            t = parse_ts(str(m.get("ts", "")))
            if t:
                raw[(room, m.get("seq"))] = (t, str(m.get("from", "")), str(m.get("text", ""))[:600])

    for room in rooms:
        take(room, fetch_json(f"/r/{urllib.parse.quote(room)}?format=json&limit={LIMIT}"))
        time.sleep(0.3)
    for _ in range(FIREHOSE_ROUNDS):
        for room in ("lobby", "technocore"):
            take(room, fetch_json(f"/r/{room}?format=json&limit={LIMIT}"))
        time.sleep(15)

    msgs = sorted(raw.values())
    print(f"collected {len(msgs)} messages from {len(rooms)} rooms")

    # clone clusters across the corpus
    by_text = defaultdict(set)
    for t, frm, text in msgs:
        n = normalize(text)
        if len(n) >= 25:
            by_text[hashlib.sha256(n.encode()).hexdigest()[:16]].add(frm)
    clone_texts = {k for k, writers in by_text.items() if len(writers) >= 3}

    writer_ids = {}
    events = []
    hourly = defaultdict(lambda: [0, 0, 0])
    for t, frm, text in msgs:
        n = normalize(text)
        is_clone = len(n) >= 25 and hashlib.sha256(n.encode()).hexdigest()[:16] in clone_texts
        signed = frm.startswith("did:key:z6Mk")
        kind = 2 if is_clone else (0 if signed else 1)
        wid = writer_ids.setdefault(frm, len(writer_ids))
        events.append([t, wid, kind])
        hourly[t - t % 3600][{0: 0, 1: 1, 2: 2}[kind]] += 1

    DOCS.mkdir(exist_ok=True)
    (DOCS / "swarm.json").write_text(json.dumps({
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "writers": len(writer_ids),
        "events": events,
        "hourly": {str(k): v for k, v in sorted(hourly.items())},
        "note": ("tails of the 200 most recently active rooms + a firehose "
                 "supplement; flooded rooms retain only their last seconds, so "
                 "early flood volume is UNDERcounted, not overcounted"),
    }, separators=(",", ":")))
    span = (msgs[-1][0] - msgs[0][0]) / 3600 if msgs else 0
    print(f"writers {len(writer_ids)}, span {span:.1f}h, "
          f"clones {sum(1 for e in events if e[2] == 2)} -> docs/swarm.json")


if __name__ == "__main__":
    main()
