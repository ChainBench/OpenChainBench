"use client";

import { ProviderLogo } from "@/components/provider-logo";
import { CHAIN_LIST, chainMeta } from "@/lib/live/chains";
import type { GlobalView } from "@/lib/live/types";

/**
 * Bottom-left card on /networks. Approximates per-chain TPS by dividing
 * 24h trade counts by 86400 — close enough for an editorial dashboard.
 * If no stats payload has arrived yet, renders a placeholder so the
 * card still claims its grid slot.
 */
export function NetworkPerformance({ stats }: { stats: GlobalView | null }) {
  if (!stats || !stats.byChain || stats.byChain.length === 0) {
    return <PerformancePlaceholder />;
  }

  const rows = stats.byChain
    .map((c) => {
      const meta = chainMeta(c.name);
      const tps = (c.trades24h || 0) / 86400;
      return {
        key: meta?.key ?? c.name.toLowerCase(),
        display: meta?.display ?? c.name,
        slug: meta?.slug ?? c.name.toLowerCase(),
        color: meta?.color ?? "#94a3b8",
        tps,
      };
    })
    // Restrict to the chains we track on the chart so the card stays compact.
    .filter((r) => CHAIN_LIST.some((c) => c.key === r.key))
    .sort((a, b) => b.tps - a.tps);

  const max = rows.reduce((m, r) => Math.max(m, r.tps), 0) || 1;

  return (
    <section className="card-soft rounded-xl p-6">
      <header className="mb-4">
        <h2 className="label-mono text-ink-muted">Network performance</h2>
        <p className="mt-1 text-sm text-ink-soft">Current TPS (transactions/sec, 24h average)</p>
      </header>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3">
            <div className="flex items-center gap-2 w-28 shrink-0">
              <ProviderLogo slug={r.slug} name={r.display} size={16} />
              <span className="text-sm text-ink">{r.display}</span>
            </div>
            <div className="flex-1 h-2 rounded-full bg-rule overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (r.tps / max) * 100)}%`,
                  background: r.color,
                }}
              />
            </div>
            <span className="font-mono tabular text-sm text-ink-soft w-16 text-right">
              {r.tps.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PerformancePlaceholder() {
  return (
    <section className="card-soft rounded-xl p-6">
      <header className="mb-4">
        <h2 className="label-mono text-ink-muted">Network performance</h2>
        <p className="mt-1 text-sm text-ink-soft">Current TPS (transactions/sec)</p>
      </header>
      <p className="text-sm text-ink-faint">Waiting for first snapshot…</p>
    </section>
  );
}
