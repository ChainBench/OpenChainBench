import Link from "next/link";
import { CORRIDORS, fetchBridgeHub, REGIONS } from "@/lib/bridge-hub-stats";

/**
 * "Bridge" view on /products/<slug>, behind the pill bar. One provider's
 * row of the /bridge hub, opened up: all-in fee p50/p99 and success on
 * the $300 USDC corridors, quote latency p50/p99 and success, then the
 * per-corridor fee matrix and the per-region quote latency, with the
 * provider's rank among the cohort on the two headline figures.
 *
 * Server component, snapshot-only (fetchBridgeHub reads the
 * worker-written bench blobs). Returns null when the provider is not a
 * bridge in the cohort.
 */
export async function BridgeProviderSection({
  slug,
  name,
}: {
  slug: string;
  name: string;
}) {
  const hub = await fetchBridgeHub();
  const row = hub?.providers.find((p) => p.slug === slug);
  if (!hub || !row) return null;
  if (row.feep50 == null && row.quotep50 == null) return null;

  const rankOn = (key: "feep50" | "quotep50") => {
    const ranked = hub.providers
      .filter((p) => p[key] != null)
      .sort((a, b) => (a[key] as number) - (b[key] as number));
    const i = ranked.findIndex((p) => p.slug === slug);
    return i >= 0 ? { rank: i + 1, of: ranked.length } : null;
  };
  const feeRank = rankOn("feep50");
  const quoteRank = rankOn("quotep50");

  return (
    <section id="bridge" className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0">
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">{name}</h2>
          <span
            className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {row.tag ?? "Bridge"}
          </span>
        </div>
        <Link href="/bridge" className="text-sm text-ink-faint hover:text-ink underline underline-offset-2">
          All bridges
        </Link>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <Kpi label="All-in fee p50" value={fmtPct(row.feep50)} rank={feeRank} good={feeRank?.rank === 1} />
        <Kpi label="All-in fee p99" value={fmtPct(row.feep99)} />
        <Kpi label="Fee quote success" value={fmtPct(row.feeSuccess)} />
        <Kpi label="Quote latency p50" value={fmtMs(row.quotep50)} rank={quoteRank} good={quoteRank?.rank === 1} />
        <Kpi label="Quote latency p99" value={fmtMs(row.quotep99)} />
        <Kpi label="Quote success" value={fmtPct(row.quoteSuccess)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionLabel>All-in fee by corridor · $300 USDC</SectionLabel>
          <div className="overflow-x-auto border-y border-rule">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-left">
                  <Th>Corridor</Th>
                  <Th right>p50</Th>
                  <Th right>p99</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {CORRIDORS.map((c) => {
                  const cf = row.corridors.find((x) => x.corridor === c.value);
                  const quoted = cf && cf.feep50 != null;
                  return (
                    <tr key={c.value}>
                      <td className="py-2.5 pr-3 font-medium text-ink">{c.label}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums" style={{ color: quoted ? undefined : "var(--color-ink-faint)" }}>
                        {quoted ? fmtPct(cf!.feep50) : "not quoted"}
                      </td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-ink-soft">
                        {quoted ? fmtPct(cf!.feep99) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <SectionLabel>Quote latency by origin region</SectionLabel>
          <div className="overflow-x-auto border-y border-rule">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-left">
                  <Th>Region</Th>
                  <Th right>p50 (24h)</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {REGIONS.map((r) => {
                  const rl = row.regions.find((x) => x.region === r.value);
                  return (
                    <tr key={r.value}>
                      <td className="py-2.5 pr-3 font-medium text-ink">{r.label}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums" style={{ color: rl?.quotep50 != null ? undefined : "var(--color-ink-faint)" }}>
                        {rl?.quotep50 != null ? fmtMs(rl.quotep50) : "no data"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-4 text-[12px] text-ink-faint pt-6 mt-6 border-t border-ink/8">
        <Link href="/bridge" className="hover:text-ink underline underline-offset-2">
          Bridge leaderboard
        </Link>
        <span aria-hidden>·</span>
        <Link href="/benchmarks/bridge-fee" className="hover:text-ink underline underline-offset-2">
          All-in fee bench
        </Link>
        <span aria-hidden>·</span>
        <Link href="/benchmarks/bridge-quote-latency" className="hover:text-ink underline underline-offset-2">
          Quote latency bench
        </Link>
      </footer>
    </section>
  );
}

function Kpi({
  label,
  value,
  rank,
  good,
}: {
  label: string;
  value: string;
  rank?: { rank: number; of: number } | null;
  good?: boolean;
}) {
  return (
    <div className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col" style={{ minHeight: 96 }}>
      <p
        className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {label}
      </p>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight" style={{ color: good ? "var(--color-good)" : undefined }}>
        {value}
      </p>
      {rank && (
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          Rank {rank.rank} of {rank.of}
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </p>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`py-2 ${right ? "px-3 text-right" : "pr-3"} text-[10px] uppercase tracking-[0.14em] text-ink-faint font-medium whitespace-nowrap`}>
      {children}
    </th>
  );
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}%`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}
