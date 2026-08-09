"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProtocolRow, WindowMetrics } from "@/lib/apps-leaderboard";

const WINDOWS = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "allTime", label: "All time" },
];

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function Dot() {
  return <span className="text-ink-muted">—</span>;
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AppsLeaderboardTable({
  protocols,
  updatedAt,
}: {
  protocols: ProtocolRow[];
  updatedAt: string | null;
}) {
  const [window, setWindow] = useState("30d");

  if (protocols.length === 0) {
    return (
      <div className="py-12 text-center text-ink-muted text-sm">
        No data yet — collector is warming up.
      </div>
    );
  }

  const sorted = [...protocols].sort(
    (a, b) =>
      (b.windows[window]?.gross ?? 0) - (a.windows[window]?.gross ?? 0),
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWindow(w.key)}
              className={`px-3 py-1 rounded text-sm font-mono transition-colors ${
                window === w.key
                  ? "bg-ink text-paper"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        {updatedAt && (
          <span className="text-xs text-ink-muted font-mono">
            Updated {new Date(updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/10">
              <th className="text-left py-2 pr-4 font-medium text-ink-soft w-8">#</th>
              <th className="text-left py-2 pr-4 font-medium text-ink-soft">Protocol</th>
              <th className="text-right py-2 pr-4 font-medium text-ink-soft">Gross fees</th>
              <th className="text-right py-2 pr-4 font-medium text-ink-soft hidden sm:table-cell">Burn / AF</th>
              <th className="text-right py-2 pr-4 font-medium text-ink-soft hidden sm:table-cell">LP</th>
              <th className="text-right py-2 font-medium text-ink-soft hidden md:table-cell">Latest data</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const wm: WindowMetrics | undefined = p.windows[window];
              return (
                <tr key={p.id} className="border-b border-ink/5 hover:bg-ink/2">
                  <td className="py-3 pr-4 text-ink-muted font-mono text-xs">{i + 1}</td>
                  <td className="py-3 pr-4">
                    {p.slug ? (
                      <Link
                        href={`/perp/${p.slug}`}
                        className="font-medium text-ink hover:text-accent transition-colors"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">{p.name}</span>
                    )}
                    <div className="text-xs text-ink-muted capitalize">{p.category}</div>
                  </td>
                  <td className="py-3 pr-4 text-right font-mono">
                    {wm?.gross ? fmt(wm.gross) : <Dot />}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-ink-soft hidden sm:table-cell">
                    {wm?.burn ? fmt(wm.burn) : <Dot />}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-ink-soft hidden sm:table-cell">
                    {wm?.lp ? fmt(wm.lp) : <Dot />}
                  </td>
                  <td className="py-3 text-right text-xs text-ink-muted hidden md:table-cell">
                    {p.latestDay ? fmtDate(p.latestDay) : <Dot />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
