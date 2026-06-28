"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import type {
  HlArchiveHistoryResponse,
  HlArchiveRankedRow,
  HlArchiveWindow,
} from "@/types/hl-archive";
import { HL_ARCHIVE_WINDOWS } from "@/types/hl-archive";

/** Windows the live Prom snapshot covers. The remaining ones need the
 *  long-window archive blob. Kept here as a typed tuple so the disabled
 *  pill logic and the URL builder share a single source of truth. */
const PROM_WINDOWS: readonly HlArchiveWindow[] = ["24h", "7d", "30d"] as const;

const LABEL: Record<HlArchiveWindow, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "180d": "180d",
  "1y": "1y",
  all: "All time",
};

type Props = {
  /** Provider slugs known on the live bench. Used to map archive rows
   *  (keyed by 0x address) back to /products/<slug> links by name match
   *  when the archive lacks the slug. Optional. */
  knownProviders?: { slug: string; name: string }[];
};

function isProm(w: HlArchiveWindow): boolean {
  return (PROM_WINDOWS as readonly string[]).includes(w);
}

export function HlHistoryToggle({ knownProviders = [] }: Props) {
  const [window, setWindow] = useState<HlArchiveWindow>("24h");
  // Per-window result cache so flipping back to a window we already
  // loaded is instant and we don't re-hammer the API on every click.
  const [cache, setCache] = useState<
    Record<string, HlArchiveHistoryResponse | { error: string }>
  >({});
  // Tracks whether ANY long-window probe has come back missing so we can
  // visibly disable those pills + show a "soon" hint without a fetch on
  // every render. null = unknown yet, true/false = decided.
  const [archiveReady, setArchiveReady] = useState<boolean | null>(null);
  // In-flight fetches kept in a ref so the effect doesn't have to dispatch
  // a "loading" state synchronously (cascading-renders lint rule). Loading
  // visual is derived from "no cache entry yet for this window".
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (cache[window] || inFlight.current.has(window)) return;
    inFlight.current.add(window);
    let cancelled = false;
    fetch(
      `/api/bench/hyperliquid-frontends/history?window=${encodeURIComponent(window)}`,
      { cache: "no-store" },
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | HlArchiveHistoryResponse
          | { error: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          const err = body && "error" in body ? body.error : `http_${res.status}`;
          setCache((c) => ({ ...c, [window]: { error: err } }));
          if (!isProm(window) && err === "archive_pending") {
            setArchiveReady(false);
            // Auto-revert so the reader keeps seeing data instead of a
            // dead frame; the toggle highlight follows.
            setWindow("30d");
          }
          return;
        }
        setCache((c) => ({ ...c, [window]: body }));
        if (!isProm(window)) setArchiveReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCache((c) => ({ ...c, [window]: { error: "network" } }));
      })
      .finally(() => {
        inFlight.current.delete(window);
      });
    return () => {
      cancelled = true;
    };
  }, [window, cache]);

  const current = cache[window];
  const productBySlug = useMemo(
    () => new Map(knownProviders.map((p) => [p.slug, p])),
    [knownProviders],
  );
  const productByName = useMemo(
    () => new Map(knownProviders.map((p) => [p.name.toLowerCase(), p])),
    [knownProviders],
  );

  return (
    <div className="mt-8 card-soft rounded-xl p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="label-mono text-ink-faint">Historical leaderboard</p>
        <div className="flex flex-wrap items-center gap-1">
          {HL_ARCHIVE_WINDOWS.map((w) => {
            const isLong = !isProm(w);
            const disabled = isLong && archiveReady === false;
            const active = w === window;
            return (
              <button
                key={w}
                type="button"
                onClick={() => !disabled && setWindow(w)}
                disabled={disabled}
                title={
                  disabled
                    ? "Backfill running, available in a few hours"
                    : undefined
                }
                aria-pressed={active}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : disabled
                      ? "text-ink-faint cursor-not-allowed"
                      : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                ].join(" ")}
              >
                {LABEL[w]}
                {disabled && (
                  <span className="ml-1 text-[9px] text-ink-faint">soon</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {current === undefined ? (
        <div className="py-16 text-center text-[12px] text-ink-muted">
          Loading {LABEL[window]} leaderboard
        </div>
      ) : "error" in current ? (
        <div className="py-12 text-center text-[12px] text-ink-muted">
          {current.error === "archive_pending"
            ? "Backfill pending — short-window data still available above."
            : "Could not load this window. Try a shorter timeframe."}
        </div>
      ) : (
        <Leaderboard
          rows={current.rows}
          window={window}
          productBySlug={productBySlug}
          productByName={productByName}
        />
      )}
    </div>
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
