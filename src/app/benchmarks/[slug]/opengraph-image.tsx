import { ogResponse } from "@/lib/og-response";
import { getBenchmark } from "@/data/benchmarks";
import { leader } from "@/lib/citation";
import { OgClaimSentence } from "@/lib/og-claim";
import { fmtUnit } from "@/lib/format";
import { CATEGORY_COLOR } from "@/lib/category-colors";
import { matchesChainSlug } from "@/lib/chain-aliases";
import { loadBenchmark } from "@/lib/spec";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const alt = "OpenChainBench. Open benchmarks for crypto infrastructure";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// On demand only. Returning slugs here feeds static params to the whole
// [slug] segment, so the PAGE gets prerendered at build too (240s+
// timeouts on heavy benches killed deploys on 2026-06-11) even though
// page.tsx itself returns [].
export async function generateStaticParams() {
  return [];
}

// Emit a SINGLE OG image for the aggregate bench page. Previously we
// fanned out one entry per chain variant so `/benchmarks/{slug}?chain=X`
// social shares could render a chain-honest card, but Next hoists every
// generateImageMetadata entry into a separate <meta property="og:image">
// on the parent page — X, LinkedIn, Slack pick nondeterministically
// among them, so a share of `?chain=solana` might render the `robinhood`
// card. Chain-scoped pages live at `/benchmarks/[slug]/[chain]` and can
// carry their own opengraph-image handler if per-chain cards become a
// priority; today they inherit the site-wide default OG.
export async function generateImageMetadata() {
  return [{ id: "default", alt, size, contentType }];
}

export default async function OG({
  params,
  id,
}: {
  params: Promise<{ slug: string }>;
  id: Promise<string | number>;
}) {
  const { slug } = await params;
  const rawId = await id;
  const chainId = typeof rawId === "string" && rawId !== "default" ? rawId : null;
  // Fetch the chain-filtered bench when a chain id is present so the
  // leader (and the headline sentence) reflect that chain's measured
  // baseline. Falls back to the unfiltered fetch when the chain is
  // missing or unknown — that mirrors the page-level behaviour.
  const b = chainId
    ? (await loadBenchmark(slug, { chain: chainId })) ?? (await getBenchmark(slug))
    : await getBenchmark(slug);
  if (!b) return ogResponse(<div />, { ...size });

  const top = leader(b);
  const headline = top ? `${top.name} leads at ${fmtUnit(top.value, b.unit)}` : "Awaiting first run";
  const catColor = CATEGORY_COLOR[b.category] ?? "#7a2e1f";
  const chainLabel = chainId
    ? b.dimensions?.chain?.find((c) => matchesChainSlug(c.value, chainId))
        ?.label ?? chainId
    : null;
  const titleText = chainLabel ? `${b.title} on ${chainLabel}` : b.title;

  return ogResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8f3eb",
          color: "#1c1a17",
          padding: 60,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "Georgia, serif",
          backgroundImage:
            "radial-gradient(rgba(28,26,23,0.06) 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#7a7166",
          }}
        >
          <span>OpenChainBench · Bench № {b.number}</span>
          <span style={{ color: catColor }}>{b.category}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: catColor,
              marginBottom: 14,
            }}
          >
            {b.metric}
            {chainLabel ? ` · ${chainLabel}` : ""}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: titleText.length > 38 ? 76 : 92,
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: -2,
              maxWidth: 1080,
            }}
          >
            {titleText}
          </div>
          <OgClaimSentence benchmark={b} fallback={b.subtitle} />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "2px solid #1c1a17",
            paddingTop: 20,
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#1c1a17",
          }}
        >
          <span>openchainbench.com/benchmarks/{b.slug}</span>
          <span style={{ fontFamily: "Georgia, serif", letterSpacing: 2 }}>
            {headline}
          </span>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800" } }
  );
}
