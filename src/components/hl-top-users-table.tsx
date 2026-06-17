"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Per-builder top-traders table. Mirrors HyperTracker's
 * "Trader leaderboard" — paginated, sortable, 30d window. Data comes
 * from the on-node harness via /api/builder/<slug>/top-users.
 *
 * The harness publishes the top-500 wallets by 30d volume; we render
 * 25 at a time client-side and let the user sort by any column. No
 * extra fetches on sort — the full 500 is < 80 KB JSON.
 */

type Row = {
  address: string;
  volume_30d: number;
  pnl_30d: number;
  fees_30d: number;
  fills_30d: number;
};

type Payload = {
  builder: string;
  as_of: number;
  total_users: number;
  window: string;
  users: Row[];
  note?: string;
};

type SortKey = keyof Pick<Row, "volume_30d" | "pnl_30d" | "fees_30d" | "fills_30d">;

const PAGE_SIZE = 25;

export function HlTopUsersTable({ slug }: { slug: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("volume_30d");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/builder/${encodeURIComponent(slug)}/top-users`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`)),
      )
      .then((p: Payload) => {
        if (!cancelled) setData(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const sorted = useMemo(() => {
    if (!data) return [] as Row[];
    const factor = sortDir === "desc" ? -1 : 1;
    return [...data.users].sort((a, b) => factor * (a[sortKey] - b[sortKey]));
  }, [data, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (error) {
    if (typeof console !== "undefined")
      console.warn(`HlTopUsersTable fetch failed for ${slug}:`, error);
    return null;
  }
  if (!data) {
    return (
      <div className="mt-6 card-soft rounded-lg p-4 border border-ink/10 h-[420px] animate-pulse" />
    );
  }
  if (data.users.length === 0) return null;

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
    setPage(0);
  };

  return (
    <div className="mt-6 card-soft rounded-xl p-4 sm:p-6 border border-ink/10">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Trader leaderboard · last 30d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Top {data.users.length.toLocaleString("en-US")} wallets by 30d
            volume routed through this frontend
          </p>
        </div>
        <p
          className="text-[11px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {data.total_users.toLocaleString("en-US")} total active
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border border-ink/5">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-paper-soft/70 text-left">
              <Th>#</Th>
              <Th>Wallet</Th>
              <ThSort active={sortKey === "volume_30d"} dir={sortDir} onClick={() => setSort("volume_30d")}>
                Volume 30d
              </ThSort>
              <ThSort active={sortKey === "pnl_30d"} dir={sortDir} onClick={() => setSort("pnl_30d")}>
                PnL 30d
              </ThSort>
              <ThSort active={sortKey === "fees_30d"} dir={sortDir} onClick={() => setSort("fees_30d")}>
                Builder fees
              </ThSort>
              <ThSort active={sortKey === "fills_30d"} dir={sortDir} onClick={() => setSort("fills_30d")}>
                Fills
              </ThSort>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr
                key={r.address}
                className="border-t border-ink/5 hover:bg-paper-soft/40 transition-colors"
              >
                <Td muted mono>
                  {page * PAGE_SIZE + i + 1}
                </Td>
                <Td mono>
                  <a
                    href={`https://app.hyperliquid.xyz/explorer/address/${r.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {shortAddr(r.address)}
                  </a>
                </Td>
                <Td mono>{fmtUSD(r.volume_30d)}</Td>
                <Td mono tone={r.pnl_30d > 0 ? "pos" : r.pnl_30d < 0 ? "neg" : undefined}>
                  {fmtSignedUSD(r.pnl_30d)}
                </Td>
                <Td mono>{fmtUSD(r.fees_30d)}</Td>
                <Td mono>{r.fills_30d.toLocaleString("en-US")}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-ink-faint flex-wrap gap-2">
        <span>
          Showing {page * PAGE_SIZE + 1}–
          {Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
        </span>
        <div className="flex items-center gap-1">
          <PageBtn disabled={page === 0} onClick={() => setPage(0)}>
            «
          </PageBtn>
          <PageBtn disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹ Prev
          </PageBtn>
          <span
            className="px-2"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {page + 1} / {pageCount}
          </span>
          <PageBtn
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next ›
          </PageBtn>
          <PageBtn
            disabled={page >= pageCount - 1}
            onClick={() => setPage(pageCount - 1)}
          >
            »
          </PageBtn>
        </div>
      </div>

      {data.note && (
        <p className="mt-2 text-[11px] text-ink-faint italic">{data.note}</p>
      )}
    </div>
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
          {active ? (dir === "desc" ? "▼" : "▲") : "⇅"}
        </span>
      </span>
    </th>
  );
}

function Td({
  children,
  mono,
  muted,
  tone,
}: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  tone?: "pos" | "neg";
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "neg"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <td
      className={`px-3 py-2 tabular-nums ${muted ? "text-ink-faint" : ""} ${toneClass}`}
      style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
    >
      {children}
    </td>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-1 rounded border border-ink/10 hover:bg-paper-soft/60 disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtSignedUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const s = v > 0 ? "+" : "-";
  return `${s}${fmtUSD(Math.abs(v)).replace("$", "$")}`;
}
