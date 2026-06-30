"use client";

/**
 * Window-scoped leaderboard for the Hyperliquid long-window archive.
 *
 * Stateless: the parent (`BenchmarkBody`) owns the fetched payload and
 * the loading state, so the chart pills (which select the same window)
 * and this table stay synchronized through a single source of truth.
 *
 * Lives in its own component because the long-window archive rows have
 * a different shape from `ProviderResult` (keyed by builder address,
 * carry per-window aggregates instead of p50/p90/p99/mean) so the
 * shared `LedgerTable` cannot render them without a wider refactor.
 */

import { useMemo } from "react";
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import type {
  HlArchiveHistoryResponse,
  HlArchiveRankedRow,
  HlArchiveWindow,
} from "@/types/hl-archive";

type Props = {
  /** Selected window. Drives the visible label only — the rows already
   *  match this window because the parent re-fetched on change. */
  window: HlArchiveWindow;
  /** Cached archive payload, or `null` while loading / on error. */
  payload: HlArchiveHistoryResponse | null;
  /** True while the parent is still fetching this window. */
  loading: boolean;
  /** Provider slugs known on the live bench. Used to map archive rows
   *  (keyed by 0x address) back to /products/<slug> links by name match
   *  when the archive lacks the slug. */
  knownProviders?: { slug: string; name: string }[];
};

const WINDOW_LABEL: Record<HlArchiveWindow, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "180d": "180d",
  "1y": "1y",
  all: "all time",
};

export function HlArchiveLeaderboard({
  window,
  payload,
  loading,
  knownProviders = [],
}: Props) {
  const productBySlug = useMemo(
    () => new Map(knownProviders.map((p) => [p.slug, p])),
    [knownProviders],
  );
  const productByName = useMemo(
    () => new Map(knownProviders.map((p) => [p.name.toLowerCase(), p])),
    [knownProviders],
  );

  if (loading || !payload) {
    return (
      <div className="py-16 text-center text-[12px] text-ink-muted">
        Loading {WINDOW_LABEL[window]} leaderboard
      </div>
    );
  }
  return (
    <Leaderboard
      rows={payload.rows}
      window={window}
      productBySlug={productBySlug}
      productByName={productByName}
    />
  );
}

function Leaderboard({
  rows,
  window,
  productBySlug,
  productByName,
}: {
  rows: HlArchiveRankedRow[];
  window: HlArchiveWindow;
  productBySlug: Map<string, { slug: string; name: string }>;
  productByName: Map<string, { slug: string; name: string }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-[12px] text-ink-muted">
        No builders had attributed flow in this window yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
      <table className="ledger w-full min-w-full border-collapse">
        <thead>
          <tr>
            <th className="border-y-2 border-ink py-2 pr-3 text-left">Product</th>
            <th className="border-y-2 border-ink py-2 px-3 text-right">
              Volume (USD)
            </th>
            <th className="border-y-2 border-ink py-2 px-3 text-right hidden md:table-cell">
              Builder fees (USD)
            </th>
            <th className="border-y-2 border-ink py-2 px-3 text-right hidden md:table-cell">
              Fills
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const known =
              productBySlug.get(r.slug) ?? productByName.get(r.name.toLowerCase());
            const dimmed = !known;
            return (
              <tr
                key={`${r.slug}-${window}`}
                className={`border-b border-rule ${dimmed ? "opacity-60" : ""}`}
              >
                <td className="py-2.5 pr-3 font-serif text-[14px]">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-ink-muted text-[12px] w-7 shrink-0">
                      {String(r.rank).padStart(2, "0")}
                    </span>
                    {known && (
                      <ProviderLogo slug={known.slug} name={known.name} size={20} />
                    )}
                    {known ? (
                      <Link
                        href={`/products/${known.slug}`}
                        className="font-semibold hover:underline underline-offset-2"
                      >
                        {known.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{r.name}</span>
                    )}
                  </span>
                </td>
                <td className="py-2.5 px-3 text-right whitespace-nowrap">
                  {fmtUnit(r.volume_usd, "usd")}
                </td>
                <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
                  {fmtUnit(r.fees_usd, "usd")}
                </td>
                <td className="py-2.5 px-3 text-right text-ink-soft whitespace-nowrap hidden md:table-cell">
                  {r.fills > 0 ? r.fills.toLocaleString() : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
