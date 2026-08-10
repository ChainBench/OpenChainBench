"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { logoPath } from "@/lib/logo-manifest";
import type { ProtocolRow, WindowMetrics } from "@/lib/apps-leaderboard";

const WINDOWS = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "allTime", label: "All time" },
];

// Maps leaderboard slug → perp venue slug + logo key
const VENUE: Record<string, { perpSlug: string | null; logoKey: string }> = {
  hyperliquid:    { perpSlug: "hyperliquid",    logoKey: "hyperliquid" },
  dydx:           { perpSlug: "dydx",           logoKey: "dydx" },
  gmx:            { perpSlug: "gmx",            logoKey: "gmx" },
  "gains-trade":  { perpSlug: "gains",          logoKey: "gains" },
  drift:          { perpSlug: null, logoKey: "drift" },
  "jupiter-perps": { perpSlug: null, logoKey: "jupiter" },
  vertex:         { perpSlug: null, logoKey: "vertex" },
};

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function Dash() {
  return <span className="text-ink-muted">—</span>;
}

export function AppsLeaderboardTable({
  protocols,
  updatedAt,
}: {
  protocols: ProtocolRow[];
  updatedAt: string | null;
}) {
  const [win, setWin] = useState("30d");

  if (protocols.length === 0) {
    return (
      <div className="py-12 text-center text-ink-muted text-sm">
        No data yet — collector is warming up.
      </div>
    );
  }

  const sorted = [...protocols].sort(
    (a, b) => (b.windows[win]?.gross ?? 0) - (a.windows[win]?.gross ?? 0),
  );

  const maxGross = sorted[0]?.windows[win]?.gross ?? 1;

  return (
    <div className="card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-4 pb-0 flex items-end justify-between gap-4 flex-wrap border-b border-rule">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className={`px-3 py-2 text-sm font-mono border-b-2 transition-colors ${
                win === w.key
                  ? "border-accent text-ink font-medium"
                  : "border-transparent text-ink-muted hover:text-ink-soft"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        {updatedAt && (
          <span className="text-[11px] text-ink-faint font-mono pb-2">
            Updated {new Date(updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule">
              <th className="text-left py-3 pl-4 sm:pl-6 pr-3 font-medium text-ink-muted text-xs w-8">#</th>
              <th className="text-left py-3 pr-4 font-medium text-ink-muted text-xs">Protocol</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs">Gross fees</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">Token holders</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden sm:table-cell">LPs</th>
              <th className="text-right py-3 pr-4 sm:pr-6 font-medium text-ink-muted text-xs hidden md:table-cell">Latest</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const wm: WindowMetrics | undefined = p.windows[win];
              const barW = wm?.gross ? Math.max(2, Math.round((wm.gross / maxGross) * 100)) : 0;
              const venue = VENUE[p.slug];
              const logo = venue ? logoPath(venue.logoKey) : null;
              const href = venue?.perpSlug ? `/perp/${venue.perpSlug}` : null;

              const nameCell = (
                <div className="flex items-center gap-2.5">
                  {logo && (
                    <Image
                      src={logo}
                      alt={p.name}
                      width={24}
                      height={24}
                      className="rounded-full shrink-0 object-contain bg-paper-soft"
                    />
                  )}
                  <div>
                    <div className="font-medium text-ink leading-tight">{p.name}</div>
                    <div className="text-xs text-ink-muted capitalize mt-0.5">{p.category}</div>
                  </div>
                </div>
              );

              return (
                <tr
                  key={p.id}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft transition-colors"
                >
                  <td className="py-4 pl-4 sm:pl-6 pr-3 text-ink-muted font-mono text-xs tabular-nums align-middle">
                    {i + 1}
                  </td>
                  <td className="py-4 pr-4 align-middle">
                    {href ? (
                      <Link href={href} className="hover:opacity-80 transition-opacity">
                        {nameCell}
                      </Link>
                    ) : nameCell}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right align-middle">
                    <div className="font-mono font-semibold text-ink tabular-nums">
                      {wm?.gross ? fmt(wm.gross) : <Dash />}
                    </div>
                    {barW > 0 && (
                      <div className="mt-1.5 ml-auto h-[3px] rounded-full bg-rule" style={{ width: "80px" }}>
                        <div
                          className="h-full rounded-full bg-accent/60"
                          style={{ width: `${barW}%` }}
                        />
                      </div>
                    )}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {wm?.burn ? fmt(wm.burn) : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-ink-soft tabular-nums align-middle hidden sm:table-cell">
                    {wm?.lp ? fmt(wm.lp) : <Dash />}
                  </td>
                  <td className="py-4 pr-4 sm:pr-6 text-right font-mono text-xs text-ink-muted align-middle hidden md:table-cell">
                    {p.latestDay ? p.latestDay.slice(0, 10) : <Dash />}
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
