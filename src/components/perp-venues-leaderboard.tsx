"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { formatAge } from "@/components/live-indicator";
import { ProviderLogo } from "@/components/provider-logo";
import type { PerpVenueRow } from "@/lib/perp-stats";
import { perpProductSlug } from "@/lib/perp-product-slug";

/**
 * Sortable + searchable venue leaderboard for /perps. Mirrors the PM
 * leaderboard structure with perp-specific columns: chain badge, 30d
 * volume, open interest, fees 30d, all-in fee (from perp-fees bench),
 * funding 24h (from perp-funding bench), volume / OI ratio (color
 * banded), active markets, health.
 *
 * The data is pure SSR input; this component only handles sort + search
 * state on the client.
 */

type SortKey =
  | "volume30d"
  | "openInterest"
  | "fees30d"
  | "allInFeeBpsEth"
  | "funding24hBpsEth"
  | "volOiRatio"
  | "activeMarkets"
  | "health";

/** Open interest under which a volume-over-OI ratio says more about the
 *  denominator than about the venue. Matches the floor /prediction-markets
 *  uses on the same column, deliberately: two hubs publishing the same
 *  quantity should not disagree about when it is readable. */
const VOL_OI_FLOOR_USD = 500_000;

export function PerpVenuesLeaderboard({ rows }: { rows: PerpVenueRow[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("volume30d");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [q, setQ] = useState("");

  // 24h volume over open interest, the figure the perp-volume-oi-ratio
  // bench ranks (0.3x to 3x is the order-book band, 8x and above the flag).
  // The column read 30-day volume over OI until 2026-09-23, thirty times
  // the bench's number under the same label.
  //
  // The floor is the same one /prediction-markets applies, for the same
  // reason it states: below it a single position moves the ratio by tens of
  // percent, and that hub's FAQ had been quoting a $38.6k book as the
  // cohort's turnover leader. Here the column was sortable and put Nova
  // first at 300.7x on $3,792 of open interest, against a cohort median of
  // 0.58x, while perp-volume-oi-ratio, the bench this column mirrors, does
  // not rank Nova at all. Measured before being written: it silences that
  // one row and nothing else.
  //
  // Null, not zero: no reading rather than a small one, so the row sorts to
  // the bottom under either direction instead of claiming a flat book.
  const ratio = (r: PerpVenueRow) =>
    r.volume24h != null &&
    r.openInterest != null &&
    r.openInterest >= VOL_OI_FLOOR_USD
      ? r.volume24h / r.openInterest
      : null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            r.slug.toLowerCase().includes(needle) ||
            r.chain.toLowerCase().includes(needle),
        )
      : rows;
    const factor = sortDir === "desc" ? -1 : 1;
    return [...out].sort((a, b) => {
      const av = sortKey === "volOiRatio" ? ratio(a) : a[sortKey];
      const bv = sortKey === "volOiRatio" ? ratio(b) : b[sortKey];
      // Nulls always sink under either sort direction so a venue with
      // no data never claims rank #1.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return factor * (av - bv);
    });
  }, [rows, sortKey, sortDir, q]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  return (
    <div className="mt-6 card-soft rounded-xl border border-ink/10">
      <div className="p-3 sm:p-4 border-b border-ink/8 flex items-center justify-between gap-3 flex-wrap">
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {filtered.length} of {rows.length} venues. Under a figure: how
          long before &ldquo;Data as of&rdquo; it was last measured, amber
          from 2 min, red from 10 min.
        </p>
        <input
          type="search" aria-label="Search venue or chain..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search venue or chain..."
          className="text-[12.5px] px-3 py-1.5 rounded-md border border-ink/15 bg-paper focus:outline-none focus:ring-2 focus:ring-teal-500/30 min-w-[180px]"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/60 text-left">
              <Th>#</Th>
              <Th>Venue</Th>
              <Th>Chain</Th>
              <ThSort
                active={sortKey === "volume30d"}
                dir={sortDir}
                onClick={() => setSort("volume30d")}
              >
                Vol 30d
              </ThSort>
              <ThSort
                active={sortKey === "openInterest"}
                dir={sortDir}
                onClick={() => setSort("openInterest")}
              >
                OI
              </ThSort>
              <ThSort
                active={sortKey === "fees30d"}
                dir={sortDir}
                onClick={() => setSort("fees30d")}
              >
                Fees 30d
              </ThSort>
              <ThSort
                active={sortKey === "allInFeeBpsEth"}
                dir={sortDir}
                onClick={() => setSort("allInFeeBpsEth")}
              >
                All-in fee (10x ETH)
              </ThSort>
              <ThSort
                active={sortKey === "funding24hBpsEth"}
                dir={sortDir}
                onClick={() => setSort("funding24hBpsEth")}
              >
                Funding ETH 24h
              </ThSort>
              <ThSort
                active={sortKey === "volOiRatio"}
                dir={sortDir}
                onClick={() => setSort("volOiRatio")}
              >
                Vol/OI 24h
              </ThSort>
              <ThSort
                active={sortKey === "activeMarkets"}
                dir={sortDir}
                onClick={() => setSort("activeMarkets")}
              >
                Markets
              </ThSort>
              <ThSort
                active={sortKey === "health"}
                dir={sortDir}
                onClick={() => setSort("health")}
              >
                Health
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const productHref = `/products/${perpProductSlug(r.slug)}#perp`;
              const vor = ratio(r);
              return (
                <tr
                  key={r.slug}
                  onClick={() => router.push(productHref)}
                  className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors cursor-pointer"
                >
                  <Td muted mono>
                    {i + 1}
                  </Td>
                  <Td>
                    <Link
                      href={productHref}
                      className="flex items-center gap-2 min-w-0 group"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ProviderLogo
                        slug={perpProductSlug(r.slug)}
                        name={r.name}
                        size={18}
                      />
                      <span className="font-medium text-ink truncate group-hover:underline underline-offset-2">
                        {r.name}
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-ink-faint shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </Link>
                  </Td>
                  <Td muted>{r.chain}</Td>
                  <FigureCell
                    text={fmtUSD(r.volume30d)}
                    ageSec={r.figureAgeSec?.volume30d}
                  />
                  <FigureCell
                    text={fmtUSD(r.openInterest)}
                    ageSec={r.figureAgeSec?.openInterest}
                  />
                  <FigureCell
                    text={fmtUSD(r.fees30d)}
                    ageSec={r.figureAgeSec?.fees30d}
                  />
                  <Td mono>{fmtBps(r.allInFeeBpsEth)}</Td>
                  <Td mono>{fmtBpsSigned(r.funding24hBpsEth)}</Td>
                  <VolOiCell ratio={vor} ages={r.figureAgeSec} />
                  <FigureCell
                    text={fmtCount(r.activeMarkets)}
                    ageSec={r.figureAgeSec?.activeMarkets}
                  />
                  <Td mono>{fmtPct(r.health)}</Td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-[12px] text-ink-faint"
                >
                  No venue matches &ldquo;{q}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FigureCell({
  text,
  ageSec,
}: {
  text: string;
  ageSec: number | null | undefined;
}) {
  return (
    <Td mono>
      {text}
      <AgeBadge ageSec={ageSec} />
    </Td>
  );
}

function olderAge(...ages: (number | null | undefined)[]): number | null {
  const known = ages.filter((a): a is number => a != null);
  return known.length ? Math.max(...known) : null;
}

const AGE_CLASS = "block mt-0.5 leading-none text-[10px] whitespace-nowrap";

function AgeBadge({ ageSec }: { ageSec: number | null | undefined }) {
  if (ageSec == null || !Number.isFinite(ageSec) || ageSec < 120) return null;
  const stale = ageSec >= 600;
  const color = stale ? "text-bad-text" : "text-amber-700 dark:text-warn";
  const age = formatAge(Math.floor(ageSec));
  return (
    <span
      className={`${AGE_CLASS} ${color}`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={`Last measured ${age} before the “Data as of” time`}
    >
      {`${age} ${stale ? "stale" : "behind"}`}
    </span>
  );
}

function VolOiCell({
  ratio,
  ages,
}: {
  ratio: number | null;
  ages: PerpVenueRow["figureAgeSec"];
}) {
  if (ratio == null || !Number.isFinite(ratio)) {
    return <Td mono>...</Td>;
  }
  const ageSec = olderAge(ages?.volume24h, ages?.openInterest);
  // Same bands as the perp-volume-oi-ratio bench, on 24h volume: 0.3x to
  // 4x is where order books with real holders (0.3x to 3x) and pool or
  // oracle venues (1x to 4x) sit (teal); under 0.3x the volume may be
  // thin against the positions, 4x to 8x is a high-churn book (amber);
  // 8x and above is where the volume figure deserves a second look (red).
  const band =
    ratio >= 0.3 && ratio <= 4
      ? { fg: "text-teal-700", bg: "bg-teal-500/10", border: "border-teal-500/30" }
      : ratio < 8
        ? { fg: "text-amber-700", bg: "bg-amber-500/10", border: "border-amber-500/30" }
        : { fg: "text-red-700", bg: "bg-red-500/10", border: "border-red-500/30" };
  return (
    <td
      className="px-3 py-2 tabular-nums"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      title={
        ratio >= 0.3 && ratio <= 4
          ? "24h volume over open interest between 0.3x and 4x: order books with real holders sit at 0.3x to 3x, pool and oracle venues at 1x to 4x (bench perp-volume-oi-ratio)."
          : ratio < 0.3
            ? "24h volume over open interest under 0.3x: positions turn over slowly, the volume may be thin against them."
            : ratio < 8
              ? "24h volume over open interest between 4x and 8x: a high-churn book, common on zero-fee venues and incentive programs."
              : "24h volume over open interest of 8x and above: the book turns over more than eight times a day, where the volume figure deserves a second look."
      }
    >
      <span
        className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border ${band.fg} ${band.bg} ${band.border}`}
      >
        {ratio < 10
          ? `${ratio.toFixed(1)}x`
          : `${Math.round(ratio).toLocaleString("en-US")}x`}
      </span>
      <AgeBadge ageSec={ageSec} />
    </td>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </th>
  );
}

function ThSort({
  children,
  active,
  dir,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th
      className={`px-3 py-2 text-[10.5px] font-medium uppercase tracking-wide cursor-pointer select-none ${
        active ? "text-ink" : "text-ink-faint hover:text-ink"
      }`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[9px]">
          {active ? (dir === "desc" ? "v" : "^") : "::"}
        </span>
      </span>
    </th>
  );
}

function Td({
  children,
  mono,
  muted,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${muted ? "text-ink-faint" : ""}`}
      style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
    >
      {children}
    </td>
  );
}

function fmtUSD(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtBps(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)} bps`;
  return `${v.toFixed(1)} bps`;
}

function fmtBpsSigned(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  const pct = v > 1.5 ? v : v * 100;
  if (pct >= 100) return "100%";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}
