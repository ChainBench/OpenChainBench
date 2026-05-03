import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBenchmark } from "@/data/benchmarks";
import { buildProviderColors } from "@/lib/series-colors";
import { fmtUnit, fmtValue, unitSuffix } from "@/lib/format";
import type { Benchmark } from "@/types/benchmark";

export const runtime = "nodejs";

const SIZE = { width: 1200, height: 630 };
const PAPER = "#f8f3eb";
const PAPER_SOFT = "#f3eee0";
const INK = "#181614";
const INK_SOFT = "#4a443c";
const INK_MUTED = "#7a7166";
const INK_FAINT = "#a59b87";
const RULE = "rgba(24, 22, 20, 0.12)";
const GOOD = "#3d6d3d";

// ─── Cached assets ─────────────────────────────────────────────────────
let _logoDataUrl: string | null = null;
function getLogoDataUrl() {
  if (!_logoDataUrl) {
    const buf = readFileSync(join(process.cwd(), "public", "logo.png"));
    _logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }
  return _logoDataUrl;
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
}: {
  benchmark: Benchmark;
  showCategory?: boolean;
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
        openchainbench.xyz · № {benchmark.number} · {benchmark.category}
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
}: {
  benchmark: Benchmark;
  accentColor?: string;
  children: React.ReactNode;
  rightText?: string;
  showCategory?: boolean;
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
        <CardHeader benchmark={benchmark} showCategory={showCategory} />
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
  const { slug } = await params;
  const benchmark = await getBenchmark(slug);
  if (!benchmark) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const template = (url.searchParams.get("template") ?? "ranking") as
    | "ranking"
    | "snapshot"
    | "headline"
    | "compare"
    | "leaderboard";

  // ─── Snapshot: multi-select via ?providers=a,b,c ─────────────────────
  const providersParam = url.searchParams.get("providers");
  const providerSlugs = providersParam
    ? providersParam.split(",").filter(Boolean)
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
    [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50)[0];

  // ─── Compare: explicit pair via ?a=slug&b=slug ───────────────────────
  const aSlug = url.searchParams.get("a");
  const bSlug = url.searchParams.get("b");
  const sortedByP50 = [...benchmark.results].sort(
    (a, b) => a.ms.p50 - b.ms.p50
  );
  const compareA =
    benchmark.results.find((r) => r.slug === aSlug) ?? sortedByP50[0];
  const compareB =
    benchmark.results.find((r) => r.slug === bSlug && r.slug !== compareA?.slug) ??
    sortedByP50.find((r) => r.slug !== compareA?.slug) ??
    sortedByP50[1];

  const colors = buildProviderColors(benchmark.results);

  switch (template) {
    case "snapshot":
      return renderSnapshot(filteredSafe, colors);
    case "headline":
      return renderHeadline(benchmark, colors, headlineProvider);
    case "compare":
      return renderCompare(benchmark, colors, compareA, compareB);
    case "leaderboard":
      return renderLeaderboard(benchmark, colors);
    case "ranking":
    default:
      return renderRanking(benchmark, colors);
  }
}

// ─── Ranking · vertical bars ───────────────────────────────────────────
async function renderRanking(
  benchmark: Benchmark,
  colors: Map<string, string>
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const maxP50 = Math.max(...sorted.map((r) => r.ms.p50)) || 1;
  const chartHeight = 280;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark}>
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
              fontSize: 56,
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
            Provider ranking by p50 · ascending. Lower is faster.
          </div>

          <div
            style={{
              display: "flex",
              flex: 1,
              alignItems: "flex-end",
              gap: 22,
              paddingTop: 32,
              paddingBottom: 12,
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
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      fontSize: 26,
                      fontWeight: 700,
                      color: INK,
                      letterSpacing: "-0.02em",
                      gap: 3,
                    }}
                  >
                    {fmtValue(r.ms.p50, benchmark.unit)}
                    <span
                      style={{
                        fontSize: 14,
                        color: INK_MUTED,
                        fontWeight: 500,
                      }}
                    >
                      {unitSuffix(benchmark.unit).trim()}
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
                      fontSize: 18,
                      fontWeight: 600,
                      color: INK,
                      marginTop: 6,
                    }}
                  >
                    {r.name}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      fontSize: 12,
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
  colors: Map<string, string>
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const maxP50 = Math.max(...sorted.map((r) => r.ms.p50)) || 1;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark}>
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
            Ranked by p50 · ascending. Lower is faster.
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
                        alignItems: "baseline",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 24,
                          fontWeight: 700,
                          color: color,
                        }}
                      >
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
                          {unitSuffix(benchmark.unit).trim()}
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
  colors: Map<string, string>
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
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
      <CardShell benchmark={benchmark}>
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
                <div
                  style={{
                    width: 16,
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
  featured?: Benchmark["results"][number]
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const winner = featured ?? sorted[0];
  const winnerColor = colors.get(winner?.slug ?? "") ?? INK;
  const rank = winner
    ? sorted.findIndex((r) => r.slug === winner.slug) + 1
    : 0;
  const isFastest = rank === 1;

  return new ImageResponse(
    (
      <CardShell benchmark={benchmark} accentColor={winnerColor}>
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
              {winner ? fmtValue(winner.ms.p50, benchmark.unit) : "—"}
            </span>
            <span
              style={{
                fontSize: 50,
                fontWeight: 600,
                color: INK_SOFT,
              }}
            >
              {unitSuffix(benchmark.unit).trim()}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              fontWeight: 600,
              color: INK,
              marginTop: 2,
            }}
          >
            by{" "}
            <span style={{ color: winnerColor, marginLeft: 10 }}>
              {winner?.name ?? "—"}
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
              ? `ahead of ${Math.max(0, sorted.length - 1)} other provider${sorted.length === 2 ? "" : "s"}`
              : `${rank} of ${sorted.length} providers · field min ${winner ? fmtUnit(sorted[0].ms.p50, benchmark.unit) : "—"}`}
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
  paneB?: Benchmark["results"][number]
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
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
      <CardShell benchmark={benchmark}>
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
              name={a.name}
              color={aColor}
              p50={fmtValue(a.ms.p50, benchmark.unit)}
              unit={unitSuffix(benchmark.unit).trim()}
              p99={fmtUnit(a.ms.p99, benchmark.unit)}
              successPct={a.successRate}
              n={a.sampleSize ?? 0}
            />
            {/* Center divider */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 10px",
                gap: 4,
                borderLeft: `1px solid ${RULE}`,
                borderRight: `1px solid ${RULE}`,
                background: PAPER,
                minWidth: 110,
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: INK_FAINT,
                  fontWeight: 600,
                }}
              >
                Δ p50
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
                }}
              >
                {deltaPct >= 0 ? "+" : ""}
                {deltaPct.toFixed(0)}%
              </div>
            </div>
            {/* Right */}
            <ComparePane
              rank={bRank}
              name={b.name}
              color={bColor}
              p50={fmtValue(b.ms.p50, benchmark.unit)}
              unit={unitSuffix(benchmark.unit).trim()}
              p99={fmtUnit(b.ms.p99, benchmark.unit)}
              successPct={b.successRate}
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
  name,
  color,
  p50,
  unit,
  p99,
  successPct,
  n,
}: {
  rank: number;
  name: string;
  color: string;
  p50: string;
  unit: string;
  p99: string;
  successPct: number;
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
          fontSize: 44,
          fontWeight: 700,
          color: color,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
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
            SUCCESS
          </span>
          <span>{successPct.toFixed(2)}%</span>
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
