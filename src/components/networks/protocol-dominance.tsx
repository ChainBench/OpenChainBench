"use client";

import { useMemo } from "react";
import { fmtMoney } from "@/lib/live/format";
import type { SwapEvent } from "@/lib/live/types";

/**
 * Bottom-right card. The relay does not currently surface aggregated
 * 24h volume per DEX — until that ships, we derive a session-local
 * approximation from the rolling swap feed (last MAX_FEED events) so
 * the card has live content instead of a stub. The hint clarifies it's
 * a session window, not the canonical 24h split.
 */
export function ProtocolDominance({ recent }: { recent: SwapEvent[] }) {
  const rows = useMemo(() => {
    const byExchange: Record<string, number> = {};
    let total = 0;
    for (const s of recent) {
      const name = s.exchange?.trim() || "Unknown";
      byExchange[name] = (byExchange[name] ?? 0) + (s.usd || 0);
      total += s.usd || 0;
    }
    const arr = Object.entries(byExchange)
      .map(([name, vol]) => ({ name, vol, pct: total > 0 ? (vol / total) * 100 : 0 }))
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 6);
    return { arr, total };
  }, [recent]);

  return (
    <section className="card-soft rounded-xl p-6">
      <header className="mb-4">
        <h2 className="label-mono text-ink-muted">Protocol dominance</h2>
        <p className="mt-1 text-sm text-ink-soft">
          DEX share of recent volume (session window · {fmtMoney(rows.total)})
        </p>
      </header>
      {rows.arr.length === 0 ? (
        <p className="text-sm text-ink-faint">Waiting for swaps…</p>
      ) : (
        <ul className="space-y-3">
          {rows.arr.map((r) => (
            <li key={r.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-ink truncate">{r.name}</span>
                <span className="font-mono tabular text-ink-soft">
                  {r.pct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-rule overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(2, r.pct)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
