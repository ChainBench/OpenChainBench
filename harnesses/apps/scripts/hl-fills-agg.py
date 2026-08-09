#!/usr/bin/env python3
"""
hl-fills-agg: HTTP server exposing daily Hyperliquid fee aggregates.
Reads node fills from /home/ubuntu/hl/data/node_fills_by_block/hourly/{YYYYMMDD}/{H}.
Caches computed days to /home/ubuntu/hl-agg/cache/{YYYYMMDD}.json.

GET /daily?from=20260601&to=20260809
-> [{"date":"20260601","gross_usdc":"...", "builder_usdc":"...","net_usdc":"...","fills":N,"hours":24}, ...]
"""

import json
import os
import sys
import threading
import time
from datetime import date, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

FILLS_DIR = "/home/ubuntu/hl/data/node_fills_by_block/hourly"
CACHE_DIR = "/home/ubuntu/hl-agg/cache"
PORT = 2116

os.makedirs(CACHE_DIR, exist_ok=True)

_lock = threading.Lock()


def aggregate_day(date_str: str, is_today: bool) -> dict | None:
    cache_file = os.path.join(CACHE_DIR, f"{date_str}.json")
    if not is_today and os.path.exists(cache_file):
        with open(cache_file) as f:
            return json.load(f)

    day_dir = os.path.join(FILLS_DIR, date_str)
    if not os.path.isdir(day_dir):
        return None

    hours = sorted(os.listdir(day_dir))
    gross = 0.0
    builder = 0.0
    fills = 0

    for h in hours:
        path = os.path.join(day_dir, h)
        try:
            with open(path) as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        for item in d.get("events") or []:
                            fill = item[1]
                            gross += float(fill.get("fee", 0) or 0)
                            builder += float(fill.get("builderFee", 0) or 0)
                            fills += 1
                    except Exception:
                        pass
        except OSError:
            pass

    result = {
        "date": date_str,
        "gross_usdc": round(gross, 6),
        "builder_usdc": round(builder, 6),
        "net_usdc": round(gross - builder, 6),
        "fills": fills,
        "hours": len(hours),
    }

    if not is_today:
        tmp = cache_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(result, f)
        os.replace(tmp, cache_file)

    return result


def backfill_worker():
    """Pre-aggregate all past days not yet cached."""
    time.sleep(5)
    today = date.today()
    d = date(2026, 6, 1)
    while d < today:
        ds = d.strftime("%Y%m%d")
        cache_file = os.path.join(CACHE_DIR, f"{ds}.json")
        if not os.path.exists(cache_file):
            print(f"backfill: aggregating {ds}", flush=True)
            aggregate_day(ds, False)
        d += timedelta(days=1)
    print("backfill: done", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json({"status": "ok"})
            return
        if parsed.path != "/daily":
            self.send_response(404)
            self.end_headers()
            return

        qs = parse_qs(parsed.query)
        from_str = qs.get("from", ["20260601"])[0]
        to_str = qs.get("to", [date.today().strftime("%Y%m%d")])[0]

        try:
            from_d = date(int(from_str[:4]), int(from_str[4:6]), int(from_str[6:8]))
            to_d = date(int(to_str[:4]), int(to_str[4:6]), int(to_str[6:8]))
        except (ValueError, IndexError):
            self.send_response(400)
            self.end_headers()
            return

        today = date.today()
        # Only return cached days (or today on-demand).
        # Uncached past days are skipped — the backfill thread will cache them.
        # This keeps the HTTP response fast regardless of how many uncached days exist.
        results = []
        d = from_d
        while d <= to_d:
            ds = d.strftime("%Y%m%d")
            is_today = d == today
            cache_file = os.path.join(CACHE_DIR, f"{ds}.json")
            if is_today:
                r = aggregate_day(ds, True)
            elif os.path.exists(cache_file):
                with open(cache_file) as f:
                    r = json.load(f)
            else:
                d += timedelta(days=1)
                continue
            if r:
                results.append(r)
            d += timedelta(days=1)

        self._json(results)

    def _json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    threading.Thread(target=backfill_worker, daemon=True).start()
    print(f"hl-fills-agg listening on :{PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
