import Link from "next/link";
import Image from "next/image";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

const DESCRIPTION =
  "Perp DEX token valuation: FDV, protocol revenue, and P/E ratio for Hyperliquid, GMX, dYdX, Gains Network and more. Live from DeFiLlama, updated hourly.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/perp-tokens",
  title: "Perp DEX token P/E ratios 2026: Hyperliquid, GMX, dYdX, GNS",
  description: DESCRIPTION,
});

export const revalidate = 3600;

const PROTOCOLS: {
  slug: string;
  name: string;
  token: string;
  llamaSlug: string;
  cgId: string | null;
  logo: string;
  chains: string[];
}[] = [
  {
    slug: "hyperliquid",
    name: "Hyperliquid",
    token: "HYPE",
    llamaSlug: "hyperliquid",
    cgId: "hyperliquid",
    logo: "/logos/hyperliquid-perp.webp",
    chains: ["Hyperliquid L1"],
  },
  {
    slug: "gmx",
    name: "GMX",
    token: "GMX",
    llamaSlug: "gmx",
    cgId: "gmx",
    logo: "/logos/gmx-perp.webp",
    chains: ["Arbitrum", "Avalanche"],
  },
  {
    slug: "gains-network",
    name: "Gains Network",
    token: "GNS",
    llamaSlug: "gains-network",
    cgId: "gains-network",
    logo: "/logos/gains-network-perp.webp",
    chains: ["Arbitrum", "Polygon", "Base"],
  },
  {
    slug: "dydx",
    name: "dYdX",
    token: "DYDX",
    llamaSlug: "dydx",
    cgId: "dydx",
    logo: "/logos/dydx-perp.svg",
    chains: ["dYdX Chain", "Ethereum"],
  },
  {
    slug: "drift",
    name: "Drift Protocol",
    token: "DRIFT",
    llamaSlug: "drift",
    cgId: "drift-protocol",
    logo: "/logos/drift-perp.webp",
    chains: ["Solana"],
  },
  {
    slug: "ostium",
    name: "Ostium",
    token: "OST",
    llamaSlug: "ostium",
    cgId: null,
    logo: "/logos/ostium-perp.webp",
    chains: ["Arbitrum"],
  },
];

type ProtocolRow = {
  slug: string;
  name: string;
  token: string;
  logo: string;
  chains: string[];
  llamaSlug: string;
  fdv: number | null;
  rev30dAvgDay: number | null;
  annualRev: number | null;
  pe: number | null;
  rev24h: number | null;
};

async function fetchLlamaRevenue(
  slug: string
): Promise<{ rev24h: number | null; avg30d: number | null }> {
  try {
    const res = await fetch(
      `https://api.llama.fi/summary/fees/${slug}?dataType=dailyRevenue`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return { rev24h: null, avg30d: null };
    const d = await res.json();
    const rev24h: number | null = d.total24h ?? null;
    const chart: [number, number][] = d.totalDataChart ?? [];
    const last30 = chart.slice(-30).map(([, v]) => v).filter(Boolean);
    const avg30d =
      last30.length > 0
        ? last30.reduce((a, b) => a + b, 0) / last30.length
        : null;
    return { rev24h, avg30d };
  } catch {
    return { rev24h: null, avg30d: null };
  }
}

async function fetchCGFdv(cgId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${cgId}&per_page=1&sparkline=false`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const coin = d[0];
    if (!coin) return null;
    return coin.fully_diluted_valuation ?? coin.market_cap ?? null;
  } catch {
    return null;
  }
}

function fmtB(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function fmtPE(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)}x`;
}

export default async function PerpTokensPage() {
  const rows: ProtocolRow[] = await Promise.all(
    PROTOCOLS.map(async (p) => {
      const [{ rev24h, avg30d }, fdv] = await Promise.all([
        fetchLlamaRevenue(p.llamaSlug),
        p.cgId ? fetchCGFdv(p.cgId) : Promise.resolve(null),
      ]);
      const annualRev = avg30d ? avg30d * 365 : null;
      const pe =
        fdv && annualRev && annualRev > 0 ? fdv / annualRev : null;
      return {
        ...p,
        fdv,
        rev30dAvgDay: avg30d,
        annualRev,
        pe,
        rev24h,
      };
    })
  );

  const sorted = [...rows].sort(
    (a, b) => (b.annualRev ?? -1) - (a.annualRev ?? -1)
  );

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Perp DEX tokens", item: `${SITE.url}/perp-tokens` },
    ]),
  };

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(20,184,166,0.05), rgba(20,184,166,0) 320px)",
      }}
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />

      <header className="mb-10">
        <p className="label-mono text-teal-600 mb-2">Perpetuals</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Perp DEX token valuation, live.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          FDV, protocol revenue and P/E ratio for the major perp DEX tokens.
          Revenue from DeFiLlama (30-day trailing average, annualized). FDV from
          CoinGecko. P/E = FDV / annual protocol revenue. Updated hourly.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-[12px]">
          <Link
            href="/perps"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span className="label-mono text-ink-faint text-[10px]">Hub</span>
            <span className="text-ink">Perp DEX execution</span>
          </Link>
          <Link
            href="/benchmarks/perp-fees"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span className="label-mono text-ink-faint text-[10px]">Bench</span>
            <span className="text-ink">perp-fees</span>
          </Link>
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink"
          >
            Methodology
          </Link>
        </div>
      </header>

      <div className="overflow-x-auto rounded-xl border border-ink/8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink/8 bg-surface-2">
              <th className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide">
                Protocol
              </th>
              <th className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide">
                Token
              </th>
              <th className="text-right px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide">
                FDV
              </th>
              <th className="text-right px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap">
                Annual Revenue
                <span className="block text-[10px] font-normal normal-case text-ink-faint">
                  30d avg × 365
                </span>
              </th>
              <th className="text-right px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide">
                P/E
                <span className="block text-[10px] font-normal normal-case text-ink-faint">
                  FDV / annual rev
                </span>
              </th>
              <th className="text-right px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide whitespace-nowrap">
                Rev 24h
              </th>
              <th className="text-left px-4 py-3 font-medium text-ink-muted text-xs uppercase tracking-wide">
                Chains
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={row.slug}
                className={`border-b border-ink/5 hover:bg-surface-2/50 transition-colors ${
                  i % 2 === 0 ? "" : "bg-surface-2/20"
                }`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full overflow-hidden bg-surface-3 flex-shrink-0">
                      <Image
                        src={row.logo}
                        alt={row.name}
                        width={32}
                        height={32}
                        className="w-8 h-8 object-cover"
                        unoptimized
                      />
                    </div>
                    <span className="font-medium text-ink">{row.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="label-mono text-ink-muted text-xs bg-surface-3 px-2 py-0.5 rounded">
                    ${row.token}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-ink">
                  {fmtB(row.fdv)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-ink">
                  {fmtB(row.annualRev)}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.pe !== null ? (
                    <span
                      className={`font-mono font-semibold ${
                        row.pe < 10
                          ? "text-emerald-500"
                          : row.pe < 50
                          ? "text-yellow-500"
                          : "text-red-400"
                      }`}
                    >
                      {fmtPE(row.pe)}
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono text-ink-soft">
                  {fmtB(row.rev24h)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {row.chains.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] label-mono text-ink-muted bg-surface-3 px-1.5 py-0.5 rounded"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="mt-8 text-xs text-ink-faint space-y-1">
        <p>
          Revenue = protocol revenue accruing to the treasury/token holders
          (DeFiLlama <code>dailyRevenue</code>, not total user fees). P/E uses
          30-day trailing daily average annualized. FDV from CoinGecko fully
          diluted valuation.
        </p>
        <p>
          Source:{" "}
          <a
            href="https://defillama.com"
            className="underline hover:text-ink"
            target="_blank"
            rel="noopener noreferrer"
          >
            DeFiLlama
          </a>{" "}
          +{" "}
          <a
            href="https://coingecko.com"
            className="underline hover:text-ink"
            target="_blank"
            rel="noopener noreferrer"
          >
            CoinGecko
          </a>
          . Updated hourly via ISR.
        </p>
      </footer>
    </article>
  );
}
