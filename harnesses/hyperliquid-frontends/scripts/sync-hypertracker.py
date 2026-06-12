#!/usr/bin/env python3
"""Diff the local builder registry against HyperTracker's public builder list.

HyperTracker (app.coinmarketman.com/hypertracker) publishes its full curated
builder registry as static JSON on CloudFront. This script fetches it, compares
it with builders.json, and reports:
  1. labeled builders missing from our registry (above revenue thresholds)
  2. name collisions where HyperTracker maps the same label to a different
     address (how the fomo 0xb838 -> 0x2a2b mixup was caught on 2026-06-12)

Read-only: prints a report, never edits builders.json. New entries ship via PR.

Usage: python3 scripts/sync-hypertracker.py [--all-time-min 10000] [--h24-min 100]
"""

import argparse
import json
import re
import urllib.request
from pathlib import Path

CDN = "https://dw3ji7n7thadj.cloudfront.net/aggregator"
REGISTRY = Path(__file__).resolve().parent.parent / "builders.json"


def fetch(name: str) -> list[dict]:
    req = urllib.request.Request(f"{CDN}/{name}", headers={"User-Agent": "OpenChainBench-sync"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["builders"]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all-time-min", type=float, default=10000)
    ap.add_argument("--h24-min", type=float, default=100)
    args = ap.parse_args()

    ht_all = fetch("builders_all.json")
    ht_24h = {b["address"].lower(): b for b in fetch("builders_24h.json")}
    registry = json.loads(REGISTRY.read_text())

    ours: set[str] = set()
    for e in registry:
        ours.add(e["address"].lower())
        ours.update(a.lower() for a in e.get("addresses", []))

    labeled = [b for b in ht_all if b.get("refCode")]
    print(f"registry: {len(registry)} entries / {len(ours)} addresses | hypertracker: {len(ht_all)} total, {len(labeled)} labeled")

    missing = []
    for b in labeled:
        if b["address"].lower() in ours:
            continue
        rev_all = b.get("revenue") or 0
        rev_24h = ht_24h.get(b["address"].lower(), {}).get("revenue") or 0
        if rev_all >= args.all_time_min or rev_24h >= args.h24_min:
            missing.append((b, rev_all, rev_24h))
    missing.sort(key=lambda x: -max(x[1], x[2] * 30))

    print(f"\nmissing labeled builders (all-time >= ${args.all_time_min:,.0f} or 24h >= ${args.h24_min:,.0f}): {len(missing)}")
    for b, rev_all, rev_24h in missing:
        joined = str(b.get("timeJoined", ""))[:10]
        print(f"  {str(b['refCode'])[:28]:28} {b['address']} all=${rev_all:>10,.0f} 24h=${rev_24h:>7,.0f} users={b.get('users') or 0:>5} joined={joined}")

    ht_by_name: dict[str, list[dict]] = {}
    for b in labeled:
        ht_by_name.setdefault(norm(b["refCode"]), []).append(b)

    print("\nname collisions with a different address (check for stale mappings):")
    hits = 0
    for e in registry:
        entry_addrs = {e["address"].lower(), *(a.lower() for a in e.get("addresses", []))}
        for key in {norm(e["slug"]), norm(e["name"])}:
            for b in ht_by_name.get(key, []):
                if b["address"].lower() not in entry_addrs:
                    hits += 1
                    print(f"  ours {e['slug']:22} {e['address']}  HT '{b['refCode']}' {b['address']} all=${(b.get('revenue') or 0):,.0f}")
    if not hits:
        print("  none")


if __name__ == "__main__":
    main()
