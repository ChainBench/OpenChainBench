"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Per-source-pair breakdown for the oracle-deviation bench. Re-pivots
 * the leaderboard. instead of "max disagreement per asset", it shows
 * "disagreement per (asset, oracle pair)" so a reader can attribute
 * the headline number to a specific pair like Chainlink↔Binance.
 *
 * Numbers are the same time-aligned p50/24h the leaderboard uses, so
 * the row's worst cell here equals the asset's headline value (modulo
 * the per-asset max being the per-source-pair max in the same window).
 */

type Payload = {
  sources: string[];
  oraclePairs: string[];
  rows: { asset: string; cells: Record<string, number | null> }[];
  dataAsOf: number | null;
};

const SOURCE_LABEL: Record<string, string> = {
  chainlink: "Chainlink",
  pyth: "Pyth",
  binance: "Binance",
  coinbase: "Coinbase",
};

function prettyPair(key: string): { short: string; long: string } {
  const [a, b] = key.split("-");
  const la = SOURCE_LABEL[a] ?? a;
  const lb = SOURCE_LABEL[b] ?? b;
  return {
    short: `${la.slice(0, 2)}↔${lb.slice(0, 2)}`,
    long: `${la} ↔ ${lb}`,
  };
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  if (v === 0) return "0%";
  if (v < 0.001) return "<0.001%";
  if (v < 1) return `${v.toFixed(3)}%`;
  return `${v.toFixed(2)}%`;
}

/**
 * Colour-codes the cell by deviation magnitude so the eye finds the
 * outliers instantly. Thresholds chosen against the bench's own
 * disclaimer ("~5-20 bps is normal floor", 100 bps = 1%):
 *   < 0.05% (5 bps)  : within scrape noise, neutral
 *   < 0.20% (20 bps) : normal floor
 *   < 0.50%          : noticeable
 *   < 1.00%          : meaningful
 *   ≥ 1.00%          : outlier — a protocol settling on this oracle pair
 *                       at this asset would be eating the difference.
 */
function cellTone(v: number | null): string {
  if (v == null) return "text-ink-faint/40";
  if (v < 0.05) return "text-ink";
  if (v < 0.2) return "text-ink";
  if (v < 0.5) return "text-amber-600 dark:text-amber-400";
  if (v < 1) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400 font-semibold";
}

export function OraclePairMatrix() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ref-based fetch guard so the effect never calls setState synchronously
  // (lint rule no-setstate-in-effect, and one fewer render than a "loading"
  // boolean state). State only updates when the request resolves or fails.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!open || data || inFlightRef.current) return;
    inFlightRef.current = true;
    let cancelled = false;
    fetch("/api/bench/oracle-deviation/oracle-pairs", {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`)),
      )
      .then((j: Payload) => {
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "fetch failed");
        }
      })
      .finally(() => {
        inFlightRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [open, data]);

  const loading = open && !data && !error;

  return (
    <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="label-mono text-ink-faint">Oracle pair breakdown</p>
          <p className="mt-1 text-sm text-ink-faint">
            Pivot the leaderboard by which two oracles disagree. Same p50 (24h)
            as the headline, split per source pair.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs uppercase tracking-[0.16em] px-3 py-2 border border-ink/20 rounded-md hover:border-ink/40 hover:bg-ink/5 transition-colors"
          aria-expanded={open}
        >
          {open ? "Hide breakdown" : "View by oracle pair"}
        </button>
      </div>

      {open && (
        <div className="mt-6">
          {loading && !data && (
            <p className="text-sm text-ink-faint">Loading…</p>
          )}
          {error && !data && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Couldn&apos;t load oracle pair breakdown: {error}
            </p>
          )}
          {data && (
            <>
              <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                <table className="w-full min-w-[560px] border-collapse text-sm tabular-nums">
                  <thead>
                    <tr>
                      <th className="border-y-2 border-ink py-2 pr-3 text-left font-medium label-mono text-ink-faint">
                        Asset
                      </th>
                      {data.oraclePairs.map((p) => {
                        const { short, long } = prettyPair(p);
                        return (
                          <th
                            key={p}
                            title={long}
                            className="border-y-2 border-ink py-2 px-2 text-right font-medium label-mono text-ink-faint whitespace-nowrap"
                          >
                            {short}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.asset} className="border-b border-ink/10">
                        <td className="py-2 pr-3 font-medium">{row.asset}</td>
                        {data.oraclePairs.map((p) => {
                          const v = row.cells[p];
                          return (
                            <td
                              key={p}
                              className={`py-2 px-2 text-right ${cellTone(v)}`}
                              title={v == null ? "no data" : `${prettyPair(p).long}: ${fmtPct(v)}`}
                            >
                              {fmtPct(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between flex-wrap gap-2 text-xs text-ink-faint">
                <span>
                  P50 over 24 hours · time-aligned (snaps prices to each
                  oracle&apos;s update timestamp). XRP / ADA / DOGE show fewer
                  cells: Chainlink mainnet feeds for these are deprecated.
                </span>
                {data.dataAsOf && (
                  <span className="whitespace-nowrap">
                    Data as of {new Date(data.dataAsOf).toUTCString().slice(17, 25)} UTC
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
