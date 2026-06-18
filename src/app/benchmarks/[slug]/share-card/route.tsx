import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { getBenchmark } from "@/data/benchmarks";
import { buildProviderColors } from "@/lib/series-colors";
import { fmtUnit, fmtValue, unitSuffix } from "@/lib/format";
import { logoPath } from "@/lib/logo-manifest";
import { chipBackground, chipTextColor, initials } from "@/lib/brand";
import type { Benchmark, ProviderResult } from "@/types/benchmark";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/slug";

/** Best → worst, depending on whether higher numbers are better. Drops
 *  rows with missing `ms` or non-positive p50, mirroring /api/stat. Those
 *  zero-value placeholders blow up the bar layout (NaN heights from a
 *  divide-by-zero maxP50, ratios > 1) which makes Satori reject the JSX
 *  with an opaque "Spread syntax" error mid-stream. */
function sortByP50(b: Benchmark): ProviderResult[] {
  return [...b.results]
    .filter(
      (r): r is ProviderResult =>
        !!r &&
        !!r.ms &&
        Number.isFinite(r.ms.p50) &&
        r.ms.p50 > 0,
    )
    .sort(
      b.higherIsBetter
        ? (a, c) => c.ms.p50 - a.ms.p50
        : (a, c) => a.ms.p50 - c.ms.p50,
    );
}

/** Compact label for the share-card bar chart. Long multi-word names
 * (e.g. "BNB Smart Chain", "Avalanche C-Chain") wrap to two lines,
 * which breaks the bottom-aligned bar layout - the wrapped column gets
 * taller and pushes its top-of-bar value above the others. Use a
 * shortened form here. */
function compactProviderName(name: string): string {
  const map: Record<string, string> = {
    "BNB Smart Chain": "BNB",
    "Avalanche C-Chain": "Avalanche",
    "XRP Ledger": "XRP",
    StellarExpert: "Stellar Exp.",
    WalletExplorer: "Wallet Exp.",
  };
  return map[name] ?? name;
}

/** Direction-aware comparison label for the Compare card centre cell.
 *  delta = b - a, where a is the leader (rank 1).
 *  - Latency / time benches: a is faster, b is "slower by".
 *  - Cost / fee (pct lower is better): a is cheaper, b is "more expensive by".
 *  - Coverage / count (higher is better): a covers more, b "covers less".
 */
function compareLabel(b: Benchmark, delta: number): string {
  const isCost = b.unit === "pct" || b.unit === "bps";
  const isLatency = b.unit === "ms" || b.unit === "s";
  if (b.higherIsBetter) {
    return delta >= 0 ? "Covers less by" : "Covers more by";
  }
  if (isCost) {
    return delta >= 0 ? "More expensive by" : "Cheaper by";
  }
  if (isLatency) {
    return delta >= 0 ? "Slower by" : "Faster by";
  }
  return delta >= 0 ? "Higher by" : "Lower by";
}

export const runtime = "nodejs";

const SIZE = { width: 1200, height: 630 };

// Palette is mutable so the GET handler can swap between light and dark
// per ?theme= query param. Render helpers below reference these by closure
// so they pick up whichever values are active at render time. Each request
// reassigns at the top of GET - single-threaded JS event loop per request
// keeps the swap race-free.
let PAPER = "#ffffff";
let PAPER_SOFT = "#f8fafc";
let INK = "#0f172a";
let INK_SOFT = "#334155";
let INK_MUTED = "#64748b";
let INK_FAINT = "#94a3b8";
let RULE = "rgba(15, 23, 42, 0.10)";
let GOOD = "#10b981";

const LIGHT_PALETTE = {
  PAPER: "#ffffff",
  PAPER_SOFT: "#f8fafc",
  INK: "#0f172a",
  INK_SOFT: "#334155",
  INK_MUTED: "#64748b",
  INK_FAINT: "#94a3b8",
  RULE: "rgba(15, 23, 42, 0.10)",
  GOOD: "#10b981",
};
const DARK_PALETTE = {
  PAPER: "#0a0b0d",
  PAPER_SOFT: "#181a1f",
  INK: "#f8fafc",
  INK_SOFT: "#d6dee8",
  INK_MUTED: "#a3b0c2",
  INK_FAINT: "#8290a3",
  RULE: "rgba(248, 250, 252, 0.10)",
  GOOD: "#34d399",
};

function applyTheme(theme: "light" | "dark") {
  const p = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  PAPER = p.PAPER;
  PAPER_SOFT = p.PAPER_SOFT;
  INK = p.INK;
  INK_SOFT = p.INK_SOFT;
  INK_MUTED = p.INK_MUTED;
  INK_FAINT = p.INK_FAINT;
  RULE = p.RULE;
  GOOD = p.GOOD;
}

// ─── Cached assets ─────────────────────────────────────────────────────
let _logoDataUrl: string | null = null;
function getLogoDataUrl() {
  if (!_logoDataUrl) {
    const buf = readFileSync(join(process.cwd(), "public", "logo.png"));
    _logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }
  return _logoDataUrl;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const _providerLogoCache = new Map<string, string | null>();
/** Returns a data URL for the registered logo file, or null if missing.
 * Result is cached per slug to avoid hitting the filesystem on every
 * render of the share-card. */
function getProviderLogoDataUrl(slug: string): string | null {
  if (_providerLogoCache.has(slug)) return _providerLogoCache.get(slug) ?? null;
  const rel = logoPath(slug); // e.g. "/logos/ethereum.png"
  if (!rel) {
    _providerLogoCache.set(slug, null);
    return null;
  }
  try {
    const buf = readFileSync(join(process.cwd(), "public", rel));
    const mime = MIME[extname(rel).toLowerCase()] ?? "image/png";
    const url = `data:${mime};base64,${buf.toString("base64")}`;
    _providerLogoCache.set(slug, url);
    return url;
  } catch {
    _providerLogoCache.set(slug, null);
    return null;
  }
}

/** Share-card variant of <ProviderLogo> - server-rendered, embedded as a
 * data URL when a logo file exists, otherwise a brand-colored chip with
 * the provider's initials. */
function CardProviderLogo({
  slug,
  name,
  size,
}: {
  slug: string;
  name: string;
  size: number;
}) {
  const dataUrl = getProviderLogoDataUrl(slug);
  if (dataUrl) {
    return (
      <div
        style={{
          display: "flex",
          width: size,
          height: size,
          borderRadius: "50%",
          background: PAPER,
          overflow: "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dataUrl}
          alt={`${name} logo`}
          width={size}
          height={size}
          style={{ objectFit: "contain" }}
        />
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        width: size,
        height: size,
        borderRadius: "50%",
        background: chipBackground(slug),
        color: chipTextColor(slug),
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
      }}
    >
      {initials(name)}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${date} · ${time} UTC`;
}

// ─── Reusable chrome ───────────────────────────────────────────────────
function Logo({ size = 36 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={getLogoDataUrl()}
        alt="OpenChainBench"
        width={size}
        height={size}
        style={{ objectFit: "contain" }}
      />
      <div
        style={{
          display: "flex",
          fontSize: 18,
          fontWeight: 700,
          color: INK,
          letterSpacing: "-0.005em",
        }}
      >
        OpenChainBench
      </div>
    </div>
  );
}

function LivePill() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "rgba(61, 109, 61, 0.12)",
        border: `1px solid rgba(61, 109, 61, 0.35)`,
        color: GOOD,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontWeight: 700,
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: GOOD,
        }}
      />
      LIVE · 24H
    </div>
  );
}

function CategoryPill({ children }: { children: string }) {
  return (
    <div
      style={{
        display: "flex",
        background: "rgba(24, 22, 20, 0.05)",
        border: `1px solid ${RULE}`,
        color: INK_SOFT,
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({
  benchmark,
  showCategory = true,
  chainLabel,
}: {
  benchmark: Benchmark;
  showCategory?: boolean;
  chainLabel?: string | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Logo />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <LivePill />
        {showCategory && <CategoryPill>{benchmark.category}</CategoryPill>}
        {chainLabel && <ChainPill>{chainLabel}</ChainPill>}
        <div
          style={{
            display: "flex",
            fontSize: 12,
            color: INK_MUTED,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontWeight: 500,
            fontFamily: "monospace",
          }}
        >
          {formatTimestamp(benchmark.lastRunAt)}
        </div>
      </div>
    </div>
  );
}

function ChainPill({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 999,
        background: PAPER_SOFT,
        border: `1px solid ${RULE}`,
        fontSize: 11,
        color: INK,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        fontWeight: 600,
        fontFamily: "monospace",
      }}
    >
      <span style={{ color: INK_FAINT, fontSize: 10 }}>CHAIN</span>
      {children}
    </div>
  );
}

function CardFooter({
  benchmark,
  rightText,
}: {
  benchmark: Benchmark;
  rightText?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderTop: `2px solid ${INK}`,
        paddingTop: 14,
        fontSize: 12,
        color: INK,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      <span>
        openchainbench.com · № {benchmark.number} · {benchmark.category}
      </span>
      <span
        style={{
          color: INK_MUTED,
          fontFamily: "monospace",
          letterSpacing: "0.1em",
        }}
      >
        {rightText ??
          `${benchmark.results.length} providers · ${Math.round(
            benchmark.sampleSize
          ).toLocaleString()} samples`}
      </span>
    </div>
  );
}

/** Wraps any inner content with the consistent card chrome. */
function CardShell({
  benchmark,
  accentColor,
  children,
  rightText,
  showCategory = true,
  chainLabel,
}: {
  benchmark: Benchmark;
  accentColor?: string;
  children: React.ReactNode;
  rightText?: string;
  showCategory?: boolean;
  chainLabel?: string | null;
}) {
  return (
    <div
      style={{
        width: SIZE.width,
        height: SIZE.height,
        background: PAPER,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
        position: "relative",
      }}
    >
      {accentColor && (
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 8,
            background: accentColor,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "32px 56px 24px",
          gap: 18,
        }}
      >
        <CardHeader
          benchmark={benchmark}
          showCategory={showCategory}
          chainLabel={chainLabel}
        />
        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
          }}
        >
          {children}
        </div>
        <CardFooter benchmark={benchmark} rightText={rightText} />
      </div>
    </div>
  );
}


// ─── GET ───────────────────────────────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  // Rate-limit per IP - share-card renders 5 templates and runs full
  // benchmark loaders, each render is 50-200ms CPU. Without this an
  // attacker hitting random query-string variants would burn function
  // CPU even for unknown slugs.
  const rl = rateLimit(clientKey(request, "share-card"), 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) {
    return new Response("bad_slug", {
      status: 400,
      headers: { "cache-control": "public, s-maxage=3600" },
    });
  }
  const url = new URL(request.url);
  // Theme switch - defaults to light. The share-section UI reads the
  // current `<html class="dark">` state and appends `?theme=dark` so the
  // exported PNG matches what the user is looking at.
  applyTheme(url.searchParams.get("theme") === "dark" ? "dark" : "light");

  // Validate `?chain=` against the spec-declared dimension before passing
  // it to the loader - same pattern as the bench detail page.
  const aggregate = await getBenchmark(slug);
  if (!aggregate || aggregate.editorialStatus !== "live") {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "public, s-maxage=60" },
    });
  }
  const chainParam = url.searchParams.get("chain");
  const chainOptions = aggregate.dimensions?.chain ?? [];
  // `all` is a synthetic option meaning "no chain filter" - same exception
  // as the bench detail page. Don't pass it down to the Prom loader or the
  // query labels won't match anything and every value reads 0.
  const isAll = chainParam === "all";
  const chainOption = isAll
    ? null
    : chainOptions.find((c) => c.value === chainParam) ?? null;
  const benchmark = chainOption
    ? (await getBenchmark(slug, { chain: chainOption.value })) ?? aggregate
    : aggregate;
  // No pill for `all` either - it's the unfiltered default view, calling
  // it out as a "chain" reads awkward.
  const chainLabel = chainOption?.label ?? null;

  const rawTemplate = url.searchParams.get("template");
  const template: "ranking" | "snapshot" | "headline" | "compare" | "leaderboard" =
    rawTemplate === "snapshot" ||
    rawTemplate === "headline" ||
    rawTemplate === "compare" ||
    rawTemplate === "leaderboard"
      ? rawTemplate
      : "ranking";

  // ─── Snapshot: multi-select via ?providers=a,b,c ─────────────────────
  // Cap both raw length and result count so a 50KB `?providers=` cannot
  // amplify the in-memory filter pass beyond what a normal share-card
  // request needs. 16 providers is more than any current bench has.
  const providersParam = url.searchParams.get("providers");
  const providerSlugs = providersParam
    ? providersParam.slice(0, 1024).split(",").filter(Boolean).slice(0, 16)
    : null;
  const filtered =
    providerSlugs && providerSlugs.length > 0
      ? {
          ...benchmark,
          results: benchmark.results.filter((r) =>
            providerSlugs.includes(r.slug)
          ),
        }
      : benchmark;
  const filteredSafe = filtered.results.length > 0 ? filtered : benchmark;

  // ─── Headline: single-pick via ?provider=slug ────────────────────────
  const headlineSlug = url.searchParams.get("provider");
  const headlineProvider =
    benchmark.results.find((r) => r.slug === headlineSlug) ??
    sortByP50(benchmark)[0];

  // ─── Compare: explicit pair via ?a=slug&b=slug ───────────────────────
  const aSlug = url.searchParams.get("a");
  const bSlug = url.searchParams.get("b");
  const sortedByP50 = sortByP50(benchmark);
  const compareA =
    benchmark.results.find((r) => r.slug === aSlug) ?? sortedByP50[0];
  const compareB =
    benchmark.results.find((r) => r.slug === bSlug && r.slug !== compareA?.slug) ??
    sortedByP50.find((r) => r.slug !== compareA?.slug) ??
    sortedByP50[1];

  const colors = buildProviderColors(benchmark.results);

  switch (template) {
    case "snapshot":
      return renderSnapshot(filteredSafe, colors, chainLabel);
    case "headline":
      return renderHeadline(benchmark, colors, headlineProvider, chainLabel);
    case "compare":
      return renderCompare(benchmark, colors, compareA, compareB, chainLabel);
    case "leaderboard":
      return renderLeaderboard(benchmark, colors, chainLabel);
    case "ranking":
    default:
      return renderRanking(benchmark, colors, chainLabel);
  }
}

// ─── Ranking · vertical bars ───────────────────────────────────────────
async function renderRanking(
  benchmark: Benchmark,
  colors: Map<string, string>,
  chainLabel?: string | null
) {
  const sorted = sortByP50(benchmark);
  const maxP50 = Math.max(...sorted.map((r) => r.ms.p50)) || 1;
  const count = sorted.length;
  // Scale type sizes down when the bench has many providers, otherwise
  // the long names (StellarExpert, WalletExplorer, …) collide.
  const dense = count >= 7;
  const titleSize = dense ? 44 : 56;
  const valueSize = dense ? 22 : 26;
  const nameSize = dense ? 15 : 18;
  const captionSize = dense ? 11 : 12;
  const barGap = dense ? 14 : 22;
  // Tallest bar reserves enough space ABOVE for its value label and BELOW
  // for the name + p99 caption. 220px keeps everything inside the 630px
  // ImageResponse canvas regardless of how the title wraps.
  const chartHeight = dense ? 200 : 220;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} chainLabel={chainLabel}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: titleSize,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {benchmark.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 18,
              color: INK_SOFT,
              lineHeight: 1.3,
              maxWidth: 980,
            }}
          >
            Product ranking by p50 · {benchmark.metric}.
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: barGap,
              paddingTop: 40,
              paddingBottom: 12,
              height: chartHeight + 100,
            }}
          >
            {sorted.map((r) => {
              const heightPx = Math.max(28, (r.ms.p50 / maxP50) * chartHeight);
              const color = colors.get(r.slug) ?? INK_SOFT;
              return (
                <div
                  key={r.slug}
                  style={{
                    display: "flex",
                    flex: 1,
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      fontSize: valueSize,
                      fontWeight: 700,
                      color: INK,
                      letterSpacing: "-0.02em",
                      gap: 3,
                    }}
                  >
                    {fmtValue(r.ms.p50, benchmark.unit)}
                    <span
                      style={{
                        fontSize: Math.round(valueSize * 0.55),
                        color: INK_MUTED,
                        fontWeight: 500,
                      }}
                    >
                      {unitSuffix(benchmark.unit, r.ms.p50).trim()}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      width: "100%",
                      height: heightPx,
                      background: color,
                      borderRadius: "4px 4px 0 0",
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: nameSize,
                      fontWeight: 600,
                      color: INK,
                      marginTop: 6,
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                      overflow: "hidden",
                    }}
                  >
                    <CardProviderLogo
                      slug={r.slug}
                      name={r.name}
                      size={Math.round(nameSize * 1.15)}
                    />
                    {compactProviderName(r.name)}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      fontSize: captionSize,
                      color: INK_FAINT,
                      fontFamily: "monospace",
                      letterSpacing: "0.08em",
                    }}
                  >
                    p99 {fmtUnit(r.ms.p99, benchmark.unit)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardShell>
    ),
    { ...SIZE }
  );
}

// ─── Leaderboard · ranked rows ─────────────────────────────────────────
async function renderLeaderboard(
  benchmark: Benchmark,
  colors: Map<string, string>,
  chainLabel?: string | null
) {
  const sorted = sortByP50(benchmark);
  const maxP50 = Math.max(...sorted.map((r) => r.ms.p50)) || 1;
  const subtitleLB = `Ranked by p50 · ${benchmark.metric}.`;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} chainLabel={chainLabel}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 50,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {benchmark.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 16,
              color: INK_SOFT,
              marginTop: 2,
            }}
          >
            {subtitleLB}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              justifyContent: "center",
              gap: 14,
              marginTop: 18,
            }}
          >
            {sorted.map((r, i) => {
              const color = colors.get(r.slug) ?? INK_SOFT;
              const widthPct = Math.max(8, (r.ms.p50 / maxP50) * 100);
              return (
                <div
                  key={r.slug}
                  style={{ display: "flex", alignItems: "center", gap: 24 }}
                >
                  <div
                    style={{
                      display: "flex",
                      fontSize: 24,
                      fontFamily: "monospace",
                      color: INK_FAINT,
                      width: 36,
                      letterSpacing: "0.05em",
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      flex: 1,
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          fontSize: 24,
                          fontWeight: 700,
                          color: color,
                        }}
                      >
                        <CardProviderLogo
                          slug={r.slug}
                          name={r.name}
                          size={28}
                        />
                        {r.name}
                      </span>
                      <span
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 4,
                          fontFamily: "monospace",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 28,
                            fontWeight: 700,
                            color: INK,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          {fmtValue(r.ms.p50, benchmark.unit)}
                        </span>
                        <span style={{ fontSize: 16, color: INK_MUTED }}>
                          {unitSuffix(benchmark.unit, r.ms.p50).trim()}
                        </span>
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        width: "100%",
                        height: 8,
                        background: `${color}22`,
                        borderRadius: 4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          width: `${widthPct}%`,
                          height: 8,
                          background: color,
                          borderRadius: 4,
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardShell>
    ),
    { ...SIZE }
  );
}

// ─── Snapshot · 24h multi-line ─────────────────────────────────────────
async function renderSnapshot(
  benchmark: Benchmark,
  colors: Map<string, string>,
  chainLabel?: string | null
) {
  const sorted = sortByP50(benchmark);
  const seriesList = sorted
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      values: benchmark.extras.series24h[r.slug] ?? [],
      color: colors.get(r.slug) ?? INK_SOFT,
      p50: r.ms.p50,
    }))
    .filter((s) => s.values.length > 1);

  const chartW = 1086;
  const chartH = 280;
  const all = seriesList.flatMap((s) => s.values);
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 1;
  const range = max - min || 1;
  const maxLen = Math.max(...seriesList.map((s) => s.values.length), 1);

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} chainLabel={chainLabel}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 48,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {benchmark.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 16,
              color: INK_SOFT,
              maxWidth: 980,
            }}
          >
            {benchmark.subtitle}
          </div>

          {/* Chart with subtle bg */}
          <div
            style={{
              display: "flex",
              marginTop: 18,
              height: chartH,
              background: PAPER_SOFT,
              borderRadius: 6,
              border: `1px solid ${RULE}`,
              position: "relative",
            }}
          >
            {/* Y-axis labels */}
            <div
              style={{
                position: "absolute",
                left: 8,
                top: 6,
                display: "flex",
                fontSize: 11,
                fontFamily: "monospace",
                color: INK_FAINT,
                letterSpacing: "0.06em",
              }}
            >
              max {fmtUnit(max, benchmark.unit)}
            </div>
            <div
              style={{
                position: "absolute",
                left: 8,
                bottom: 6,
                display: "flex",
                fontSize: 11,
                fontFamily: "monospace",
                color: INK_FAINT,
                letterSpacing: "0.06em",
              }}
            >
              min {fmtUnit(min, benchmark.unit)}
            </div>

            <svg
              width={chartW}
              height={chartH}
              viewBox={`0 0 ${chartW} ${chartH}`}
              style={{ width: "100%", height: "100%" }}
            >
              {seriesList.map(({ slug, values, color }) => {
                const points = values
                  .map((v, i) => {
                    const x = (i / Math.max(1, maxLen - 1)) * chartW;
                    const y =
                      chartH - ((v - min) / range) * (chartH - 16) - 8;
                    return `${x.toFixed(2)},${y.toFixed(2)}`;
                  })
                  .join(" ");
                const last = values[values.length - 1];
                const lastX =
                  ((values.length - 1) / Math.max(1, maxLen - 1)) * chartW;
                const lastY =
                  chartH - ((last - min) / range) * (chartH - 16) - 8;
                return (
                  <g key={slug}>
                    <polyline
                      fill="none"
                      stroke={color}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={points}
                    />
                    <circle cx={lastX} cy={lastY} r={5} fill={color} />
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Legend */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 20,
              marginTop: 14,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {seriesList.map((s) => (
              <div
                key={s.slug}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <CardProviderLogo slug={s.slug} name={s.name} size={20} />
                <div
                  style={{
                    width: 14,
                    height: 4,
                    borderRadius: 2,
                    background: s.color,
                  }}
                />
                <span style={{ color: s.color }}>{s.name}</span>
                <span
                  style={{
                    color: INK_FAINT,
                    fontFamily: "monospace",
                    fontWeight: 400,
                    fontSize: 14,
                  }}
                >
                  {fmtUnit(s.p50, benchmark.unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardShell>
    ),
    { ...SIZE }
  );
}

// ─── Headline · big-number poster ──────────────────────────────────────
async function renderHeadline(
  benchmark: Benchmark,
  colors: Map<string, string>,
  featured?: Benchmark["results"][number],
  chainLabel?: string | null
) {
  const sorted = sortByP50(benchmark);
  const winner = featured ?? sorted[0];
  const winnerColor = colors.get(winner?.slug ?? "") ?? INK;
  const rank = winner
    ? sorted.findIndex((r) => r.slug === winner.slug) + 1
    : 0;
  const isFastest = rank === 1;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} accentColor={winnerColor} chainLabel={chainLabel}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 18,
              color: INK_MUTED,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {benchmark.title}
            {isFastest
              ? " · field min p50"
              : rank > 0
                ? ` · rank ${String(rank).padStart(2, "0")} · p50`
                : " · p50"}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              color: winnerColor,
            }}
          >
            <span
              style={{
                fontSize: 200,
                fontWeight: 800,
                letterSpacing: "-0.04em",
                lineHeight: 1,
              }}
            >
              {winner ? fmtValue(winner.ms.p50, benchmark.unit) : "-"}
            </span>
            <span
              style={{
                fontSize: 50,
                fontWeight: 600,
                color: INK_SOFT,
              }}
            >
              {unitSuffix(benchmark.unit, winner?.ms.p50).trim()}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 28,
              fontWeight: 600,
              color: INK,
              marginTop: 2,
            }}
          >
            by
            {winner && (
              <CardProviderLogo
                slug={winner.slug}
                name={winner.name}
                size={36}
              />
            )}
            <span style={{ color: winnerColor }}>
              {winner?.name ?? "-"}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 14,
              color: INK_FAINT,
              fontFamily: "monospace",
              letterSpacing: "0.08em",
            }}
          >
            {isFastest
              ? `ahead of ${Math.max(0, sorted.length - 1)} other product${sorted.length === 2 ? "" : "s"}`
              : `${rank} of ${sorted.length} providers · field min ${winner ? fmtUnit(sorted[0].ms.p50, benchmark.unit) : "-"}`}
            {winner && ` · p99 ${fmtUnit(winner.ms.p99, benchmark.unit)}`}
          </div>
        </div>
      </CardShell>
    ),
    { ...SIZE }
  );
}

// ─── Compare · top-2 head-to-head ──────────────────────────────────────
async function renderCompare(
  benchmark: Benchmark,
  colors: Map<string, string>,
  paneA?: Benchmark["results"][number],
  paneB?: Benchmark["results"][number],
  chainLabel?: string | null
) {
  const sorted = sortByP50(benchmark);
  const a = paneA ?? sorted[0];
  const b =
    paneB && paneB.slug !== a?.slug
      ? paneB
      : sorted.find((r) => r.slug !== a?.slug);
  if (!a || !b) return renderHeadline(benchmark, colors, a);

  const aColor = colors.get(a.slug) ?? INK_SOFT;
  const bColor = colors.get(b.slug) ?? INK_SOFT;

  const aRank = sorted.findIndex((r) => r.slug === a.slug) + 1;
  const bRank = sorted.findIndex((r) => r.slug === b.slug) + 1;

  const delta = b.ms.p50 - a.ms.p50;
  const deltaPct = a.ms.p50 > 0 ? (delta / a.ms.p50) * 100 : 0;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} chainLabel={chainLabel}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 36,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {benchmark.title} · top 2
          </div>

          <div
            style={{
              display: "flex",
              flex: 1,
              marginTop: 14,
              border: `1px solid ${RULE}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* Left */}
            <ComparePane
              rank={aRank}
              slug={a.slug}
              name={a.name}
              color={aColor}
              p50={fmtValue(a.ms.p50, benchmark.unit)}
              unit={unitSuffix(benchmark.unit, a.ms.p50).trim()}
              p99={fmtUnit(a.ms.p99, benchmark.unit)}
              n={a.sampleSize ?? 0}
            />
            {/* Center divider */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 14px",
                gap: 6,
                borderLeft: `1px solid ${RULE}`,
                borderRight: `1px solid ${RULE}`,
                background: PAPER,
                minWidth: 130,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 28,
                  fontWeight: 700,
                  color: INK_FAINT,
                  letterSpacing: "-0.02em",
                  fontStyle: "italic",
                }}
              >
                vs
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 14,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: INK_MUTED,
                  fontWeight: 600,
                }}
              >
                {compareLabel(benchmark, delta)}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 26,
                  fontWeight: 700,
                  color: INK,
                  letterSpacing: "-0.02em",
                }}
              >
                {fmtUnit(Math.abs(delta), benchmark.unit)}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 13,
                  color: INK_MUTED,
                  fontFamily: "monospace",
                  letterSpacing: "0.04em",
                }}
              >
                {deltaPct >= 0 ? "+" : "−"}
                {Math.abs(deltaPct).toFixed(0)}%
              </div>
            </div>
            {/* Right */}
            <ComparePane
              rank={bRank}
              slug={b.slug}
              name={b.name}
              color={bColor}
              p50={fmtValue(b.ms.p50, benchmark.unit)}
              unit={unitSuffix(benchmark.unit, b.ms.p50).trim()}
              p99={fmtUnit(b.ms.p99, benchmark.unit)}
              n={b.sampleSize ?? 0}
            />
          </div>
        </div>
      </CardShell>
    ),
    { ...SIZE }
  );
}

function ComparePane({
  rank,
  slug,
  name,
  color,
  p50,
  unit,
  p99,
  n,
}: {
  rank: number;
  slug: string;
  name: string;
  color: string;
  p50: string;
  unit: string;
  p99: string;
  n: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        padding: "26px 32px",
        background: `${color}10`,
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 14,
          color: INK_FAINT,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        Rank {String(rank).padStart(2, "0")}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 44,
          fontWeight: 700,
          color: color,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        <CardProviderLogo slug={slug} name={name} size={52} />
        {name}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          marginTop: 4,
        }}
      >
        <span
          style={{
            fontSize: 78,
            fontWeight: 800,
            color: INK,
            letterSpacing: "-0.03em",
            lineHeight: 1,
          }}
        >
          {p50}
        </span>
        <span style={{ fontSize: 26, color: INK_MUTED, fontWeight: 600 }}>
          {unit}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 13,
          color: INK_MUTED,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        p50
      </div>

      <div
        style={{
          display: "flex",
          gap: 22,
          marginTop: 14,
          fontFamily: "monospace",
          fontSize: 14,
          color: INK_SOFT,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              color: INK_FAINT,
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            P99
          </span>
          <span>{p99}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              color: INK_FAINT,
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            N · 24H
          </span>
          <span>{Math.round(n).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
