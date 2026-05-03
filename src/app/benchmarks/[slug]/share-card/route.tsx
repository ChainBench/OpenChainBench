import { ImageResponse } from "next/og";
import { getBenchmark } from "@/data/benchmarks";
import { buildProviderColors } from "@/lib/series-colors";
import { fmtUnit, fmtValue, unitSuffix } from "@/lib/format";

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
    | "snapshot";

  if (template === "snapshot") {
    return renderSnapshot(benchmark);
  }
  return renderRanking(benchmark);
}

async function renderRanking(
  benchmark: NonNullable<Awaited<ReturnType<typeof getBenchmark>>>
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const colors = buildProviderColors(benchmark.results);
  const maxP50 = Math.max(...sorted.map((r) => r.ms.p50)) || 1;

  // Chart geometry
  const chartHeight = 320;
  const barAreaPaddingTop = 60;

  return new ImageResponse(
    (
      <div
        style={{
          width: SIZE.width,
          height: SIZE.height,
          background: PAPER,
          display: "flex",
          flexDirection: "column",
          padding: "60px 70px 50px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 16,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: INK_MUTED,
              fontWeight: 500,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(61, 109, 61, 0.1)",
                border: `1px solid rgba(61, 109, 61, 0.4)`,
                color: GOOD,
                padding: "3px 12px",
                borderRadius: 999,
                fontSize: 14,
                letterSpacing: "0.14em",
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
              LIVE
            </div>
            <div
              style={{
                background: "rgba(24, 22, 20, 0.04)",
                border: `1px solid ${RULE}`,
                color: INK_SOFT,
                padding: "3px 12px",
                borderRadius: 999,
                fontSize: 14,
                letterSpacing: "0.14em",
              }}
            >
              {benchmark.category.toUpperCase()}
            </div>
            <div style={{ display: "flex", color: INK_FAINT, fontSize: 14 }}>
              № {benchmark.number} · 24h
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 64,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              marginTop: 6,
            }}
          >
            {benchmark.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              color: INK_SOFT,
              lineHeight: 1.3,
              marginTop: 8,
              maxWidth: 980,
            }}
          >
            Provider ranking by p50 · ascending. Lower is faster.
          </div>
        </div>

        {/* Bars */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "flex-end",
            gap: 24,
            marginTop: barAreaPaddingTop,
            paddingBottom: 40,
            position: "relative",
          }}
        >
          {sorted.map((r) => {
            const heightPx = Math.max(
              28,
              (r.ms.p50 / maxP50) * chartHeight
            );
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
                    fontSize: 24,
                    fontWeight: 700,
                    color: INK,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {fmtValue(r.ms.p50, benchmark.unit)}
                  <span
                    style={{
                      fontSize: 16,
                      color: INK_MUTED,
                      fontWeight: 500,
                      marginLeft: 4,
                      alignSelf: "flex-end",
                      paddingBottom: 4,
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
                    marginTop: 8,
                  }}
                >
                  {r.name}
                </div>
                <div
                  style={{
                    display: "flex",
                    fontSize: 13,
                    color: INK_FAINT,
                    fontFamily: "monospace",
                  }}
                >
                  p99 {fmtUnit(r.ms.p99, benchmark.unit)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `2px solid ${INK}`,
            paddingTop: 20,
            fontSize: 16,
            color: INK,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          <span>openchainbench.xyz</span>
          <span style={{ color: INK_MUTED }}>
            {benchmark.results.length} providers ·{" "}
            {Math.round(benchmark.sampleSize).toLocaleString()} samples
          </span>
        </div>
      </div>
    ),
    { ...SIZE }
  );
}

async function renderSnapshot(
  benchmark: NonNullable<Awaited<ReturnType<typeof getBenchmark>>>
) {
  const sorted = [...benchmark.results].sort((a, b) => a.ms.p50 - b.ms.p50);
  const colors = buildProviderColors(benchmark.results);

  const seriesList = sorted
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      values: benchmark.extras.series24h[r.slug] ?? [],
      color: colors.get(r.slug) ?? INK_SOFT,
      p50: r.ms.p50,
    }))
    .filter((s) => s.values.length > 1);

  // Chart geometry — internal SVG-style coordinate space
  const chartW = 1060;
  const chartH = 320;
  const chartTop = 240;
  const chartLeft = 70;

  const all = seriesList.flatMap((s) => s.values);
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 1;
  const range = max - min || 1;
  const maxLen = Math.max(...seriesList.map((s) => s.values.length), 1);

  return new ImageResponse(
    (
      <div
        style={{
          width: SIZE.width,
          height: SIZE.height,
          background: PAPER,
          display: "flex",
          flexDirection: "column",
          padding: "60px 70px 50px",
          fontFamily: "system-ui, -apple-system, sans-serif",
          position: "relative",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 14,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: INK_MUTED,
              fontWeight: 500,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(61, 109, 61, 0.1)",
                border: `1px solid rgba(61, 109, 61, 0.4)`,
                color: GOOD,
                padding: "3px 12px",
                borderRadius: 999,
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
            <div
              style={{
                background: "rgba(24, 22, 20, 0.04)",
                border: `1px solid ${RULE}`,
                color: INK_SOFT,
                padding: "3px 12px",
                borderRadius: 999,
              }}
            >
              {benchmark.category.toUpperCase()}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 60,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
              marginTop: 6,
            }}
          >
            {benchmark.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              color: INK_SOFT,
              lineHeight: 1.3,
              marginTop: 8,
              maxWidth: 980,
            }}
          >
            {benchmark.subtitle}
          </div>
        </div>

        {/* Chart background */}
        <div
          style={{
            position: "absolute",
            left: chartLeft,
            top: chartTop,
            width: chartW,
            height: chartH,
            background: PAPER_SOFT,
            borderRadius: 6,
            border: `1px solid ${RULE}`,
            display: "flex",
          }}
        />

        {/* Lines (rendered via SVG) */}
        <svg
          width={chartW}
          height={chartH}
          viewBox={`0 0 ${chartW} ${chartH}`}
          style={{
            position: "absolute",
            left: chartLeft,
            top: chartTop,
          }}
        >
          {seriesList.map(({ slug, values, color }) => {
            const points = values
              .map((v, i) => {
                const x = (i / Math.max(1, maxLen - 1)) * chartW;
                const y =
                  chartH - ((v - min) / range) * (chartH - 12) - 6;
                return `${x.toFixed(2)},${y.toFixed(2)}`;
              })
              .join(" ");
            const last = values[values.length - 1];
            const lastX =
              ((values.length - 1) / Math.max(1, maxLen - 1)) * chartW;
            const lastY = chartH - ((last - min) / range) * (chartH - 12) - 6;
            return (
              <g key={slug}>
                <polyline
                  fill="none"
                  stroke={color}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={points}
                />
                <circle cx={lastX} cy={lastY} r={5} fill={color} />
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div
          style={{
            position: "absolute",
            left: chartLeft,
            top: chartTop + chartH + 18,
            width: chartW,
            display: "flex",
            flexWrap: "wrap",
            gap: 22,
            fontSize: 18,
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
                }}
              >
                {fmtUnit(s.p50, benchmark.unit)}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            position: "absolute",
            bottom: 50,
            left: 70,
            right: 70,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `2px solid ${INK}`,
            paddingTop: 18,
            fontSize: 14,
            color: INK,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          <span>openchainbench.xyz</span>
          <span style={{ color: INK_MUTED }}>
            {Math.round(benchmark.sampleSize).toLocaleString()} samples · 24h
          </span>
        </div>
      </div>
    ),
    { ...SIZE }
  );
}
