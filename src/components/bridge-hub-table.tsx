"use client";

import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import type { BridgeProviderRow, CorridorKey } from "@/lib/bridge-hub-types";
import { CORRIDORS, REGIONS } from "@/lib/bridge-hub-types";

const TYPE_LABELS: Record<string, string> = {
  intent: "Intent layer",
  relay: "Relay",
  aggregator: "Aggregator",
  protocol: "Protocol",
};

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtSuccess(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function CorridorDot({
  value,
  label,
}: {
  value: number | null;
  label: string;
}) {
  const active = value != null && Number.isFinite(value);
  return (
    <span
      title={active ? `${label}: ${fmtPct(value)}` : `${label}: not quoted`}
      className={`inline-block w-2 h-2 rounded-full ${
        active ? "bg-indigo-500" : "bg-ink/15"
      }`}
    />
  );
}

/** Main leaderboard — sorted by fee p50, quote speed per region when multi-region data is available */
export function BridgeHubTable({ rows }: { rows: BridgeProviderRow[] }) {
  if (rows.length === 0) return null;

  // Per-region: find fastest and slowest slug among rows with data
  const regionRank: Record<string, { fastest: string | null; slowest: string | null }> = {};
  for (const r of REGIONS) {
    const withData = rows
      .map((row) => ({ slug: row.slug, v: row.regions.find((x) => x.region === r.value)?.quotep50 ?? null }))
      .filter((x) => x.v != null && Number.isFinite(x.v));
    if (withData.length < 2) {
      regionRank[r.value] = { fastest: withData[0]?.slug ?? null, slowest: null };
    } else {
      withData.sort((a, b) => (a.v ?? Infinity) - (b.v ?? Infinity));
      regionRank[r.value] = { fastest: withData[0].slug, slowest: withData[withData.length - 1].slug };
    }
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/10 bg-ink/[0.02]">
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal w-8">#</th>
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal">Provider</th>
            <th className="text-left px-3 py-3 text-[11px] label-mono text-ink-faint font-normal hidden sm:table-cell">Type</th>
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal">Fee p50</th>
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden lg:table-cell">Fee p99</th>
            {REGIONS.map((r) => (
              <th key={r.value} className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden md:table-cell">
                {r.short}
              </th>
            ))}
            <th className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden md:table-cell">Success</th>
            <th className="text-center px-4 py-3 text-[11px] label-mono text-ink-faint font-normal hidden lg:table-cell">Corridors</th>
          </tr>
          <tr className="border-b border-ink/5 bg-ink/[0.01]">
            <td colSpan={3} />
            <td colSpan={2} className="px-4 py-1 text-[10px] text-indigo-500 label-mono text-right hidden lg:table-cell">
              all-in fee · $300 USDC
            </td>
            <td className="px-4 py-1 text-[10px] text-indigo-500 label-mono text-right hidden md:table-cell lg:hidden" />
            {REGIONS.map((r) => (
              <td key={r.value} className="px-4 py-1 text-[10px] text-ink-faint label-mono text-right hidden md:table-cell">
                quote p50
              </td>
            ))}
            <td className="hidden md:table-cell" />
            <td className="hidden lg:table-cell px-4 py-1 text-[10px] text-ink-faint label-mono text-center">
              Sol↗ Base↗ Sol↗ HC
            </td>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isLeader = i === 0;
            return (
              <tr
                key={row.slug}
                className={`border-b border-ink/5 last:border-0 hover:bg-ink/[0.025] transition-colors ${isLeader ? "bg-indigo-500/[0.03]" : ""}`}
              >
                <td className="px-4 py-3.5 text-ink-faint tabular-nums text-[12px] font-mono">
                  {isLeader ? (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-500/15 text-indigo-600 text-[10px] font-semibold">1</span>
                  ) : (
                    i + 1
                  )}
                </td>
                <td className="px-4 py-3.5">
                  <Link href={`/products/${row.slug}`} className="inline-flex items-center gap-2.5 group">
                    <ProviderLogo slug={row.slug} name={row.name} size={24} />
                    <span className="font-medium text-ink group-hover:underline leading-tight">{row.name}</span>
                  </Link>
                </td>
                <td className="px-3 py-3.5 hidden sm:table-cell">
                  {row.type && (
                    <span className="inline-flex rounded-full bg-ink/5 px-2 py-0.5 text-[11px] text-ink-soft">
                      {TYPE_LABELS[row.type] ?? row.type}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums font-semibold text-ink">
                  {fmtPct(row.feep50)}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums text-ink-soft hidden lg:table-cell">
                  {fmtPct(row.feep99)}
                </td>
                {REGIONS.map((r) => {
                  const regionData = row.regions.find((x) => x.region === r.value);
                  const val = regionData?.quotep50 ?? null;
                  const isFastest = val != null && regionRank[r.value]?.fastest === row.slug;
                  const isSlowest = val != null && regionRank[r.value]?.slowest === row.slug;
                  return (
                    <td key={r.value} className="px-4 py-3.5 text-right tabular-nums hidden md:table-cell">
                      {val == null ? (
                        <span className="text-ink/20">—</span>
                      ) : (
                        <span className={isFastest ? "font-semibold text-emerald-600" : isSlowest ? "text-amber-600" : "text-ink-soft"}>
                          {fmtMs(val)}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-4 py-3.5 text-right tabular-nums hidden md:table-cell">
                  <span className={row.feeSuccess != null && row.feeSuccess < 80 ? "text-amber-600" : "text-ink-soft"}>
                    {fmtSuccess(row.feeSuccess)}
                  </span>
                </td>
                <td className="px-4 py-3.5 hidden lg:table-cell">
                  <div className="flex items-center justify-center gap-1.5">
                    {CORRIDORS.map((c) => {
                      const cf = row.corridors.find((x) => x.corridor === c.value);
                      return (
                        <CorridorDot key={c.value} value={cf?.feep50 ?? null} label={c.short} />
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Per-corridor breakdown matrix — fee p50 + p99 per provider × corridor */
export function BridgeCorridorMatrix({ rows }: { rows: BridgeProviderRow[] }) {
  if (rows.length === 0) return null;

  const cheapestP50ByCorr: Partial<Record<CorridorKey, string>> = {};
  for (const c of CORRIDORS) {
    const viable = rows
      .map((r) => ({ slug: r.slug, v: r.corridors.find((x) => x.corridor === c.value)?.feep50 ?? null }))
      .filter((x) => x.v != null)
      .sort((a, b) => (a.v ?? Infinity) - (b.v ?? Infinity));
    if (viable.length > 0) cheapestP50ByCorr[c.value] = viable[0].slug;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/10 bg-ink/[0.02]">
            <th className="text-left px-4 py-3 text-[11px] label-mono text-ink-faint font-normal">Provider</th>
            {CORRIDORS.map((c) => (
              <th
                key={c.value}
                className="text-right px-4 py-3 text-[11px] label-mono text-ink-faint font-normal"
                colSpan={2}
              >
                {c.short}
              </th>
            ))}
          </tr>
          <tr className="border-b border-ink/5 bg-ink/[0.01]">
            <td />
            {CORRIDORS.map((c) => (
              <>
                <td key={`${c.value}-p50`} className="px-3 py-1 text-[10px] text-indigo-500 label-mono text-right">
                  p50
                </td>
                <td key={`${c.value}-p99`} className="px-3 py-1 text-[10px] text-ink-faint label-mono text-right">
                  p99
                </td>
              </>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slug} className="border-b border-ink/5 last:border-0 hover:bg-ink/[0.025] transition-colors">
              <td className="px-4 py-3">
                <Link href={`/products/${row.slug}`} className="inline-flex items-center gap-2 group">
                  <ProviderLogo slug={row.slug} name={row.name} size={18} />
                  <span className="text-ink-soft group-hover:text-ink text-[13px] leading-tight">{row.name}</span>
                </Link>
              </td>
              {CORRIDORS.map((c) => {
                const cf = row.corridors.find((x) => x.corridor === c.value);
                const p50 = cf?.feep50 ?? null;
                const p99 = cf?.feep99 ?? null;
                const isCheapest = cheapestP50ByCorr[c.value] === row.slug && p50 != null;
                return (
                  <>
                    <td key={`${c.value}-p50`} className="px-3 py-3 text-right tabular-nums">
                      {p50 == null ? (
                        <span className="text-ink/20 text-[12px]">—</span>
                      ) : (
                        <span className={isCheapest ? "font-semibold text-emerald-600" : "text-ink-soft"}>
                          {fmtPct(p50)}
                        </span>
                      )}
                    </td>
                    <td key={`${c.value}-p99`} className="px-3 py-3 text-right tabular-nums">
                      {p99 == null ? (
                        <span className="text-ink/20 text-[12px]">—</span>
                      ) : (
                        <span className="text-ink/40 text-[12px]">{fmtPct(p99)}</span>
                      )}
                    </td>
                  </>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-ink-faint border-t border-ink/5">
        Green = cheapest p50 on that corridor. p99 in grey. — = not quoted. All-in cost: fees + slippage + gas at $300 USDC, trailing 24h.
      </p>
    </div>
  );
}
