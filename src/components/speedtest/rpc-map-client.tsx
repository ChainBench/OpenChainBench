"use client";

/**
 * Crowdsourced RPC latency world map. Cells are geohash-4 aggregates of
 * anonymous browser speed tests (see /speedtest-rpc); each dot is the
 * median contributed latency at that location, colored on the same
 * green-amber-red scale as the speed test dial. Pure SVG: no tile
 * server, no map library, zero per-visitor server cost.
 *
 * Interaction model:
 *  - searchable chain picker (same directory as the speed test);
 *  - provider chips are MULTI-select: pick two or three to compare just
 *    them, the dots and the table re-rank on the selected subset;
 *  - the "In view" table follows the current zoom viewport, so zooming
 *    into a region turns the bottom list into that region's ranking;
 *  - labels densify with zoom: city names appear first, then the ms
 *    value of the winning provider.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ProviderLogo } from "@/components/provider-logo";
import { RPC_DIRECTORY } from "@/lib/speedtest/rpc-directory";
import { WORLD_PATH, WORLD_W, WORLD_H } from "@/lib/speedtest/world-path";

type MapCell = {
  gh: string;
  lat: number;
  lon: number;
  city: string;
  country: string;
  providers: { slug: string; p50: number; samples: number }[];
  best: string;
};

type MapData = { chain: string; cells: MapCell[]; total: number };

const FEATURED = ["ethereum", "base", "arbitrum", "bnb", "polygon", "optimism"];

function project(lat: number, lon: number): [number, number] {
  return [((lon + 180) / 360) * WORLD_W, ((90 - lat) / 180) * WORLD_H];
}

function latencyColor(ms: number): string {
  if (ms < 50) return "#10b981";
  if (ms < 120) return "#84cc16";
  if (ms < 200) return "#f59e0b";
  if (ms < 400) return "#f97316";
  return "#ef4444";
}

function providerName(slug: string): string {
  for (const c of RPC_DIRECTORY) {
    const e = c.endpoints.find((x) => x.slug === slug);
    if (e) return e.provider;
  }
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function RpcMapClient() {
  const [chain, setChain] = useState("ethereum");
  const [chainQuery, setChainQuery] = useState("");
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<MapCell | null>(null);
  const [hoverXY, setHoverXY] = useState<[number, number]>([0, 0]);
  // viewBox as [x, y, w, h]; wheel zooms toward the cursor, drag pans.
  const [vb, setVb] = useState<[number, number, number, number]>([0, 0, WORLD_W, WORLD_H]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: typeof vb; moved: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/speedtest/map?chain=${chain}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [chain]);

  // Providers present in the current chain's data, most-sampled first.
  const providersInData = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of data?.cells ?? []) {
      for (const p of c.providers) counts.set(p.slug, (counts.get(p.slug) ?? 0) + p.samples);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([slug]) => slug);
  }, [data]);

  // Apply the provider multi-filter: keep matching providers per cell,
  // drop cells left empty, re-rank on the subset.
  const cells = useMemo(() => {
    const raw = data?.cells ?? [];
    if (selected.size === 0) return raw;
    return raw
      .map((c) => {
        const providers = c.providers.filter((p) => selected.has(p.slug));
        return { ...c, providers, best: providers[0]?.slug ?? "" };
      })
      .filter((c) => c.providers.length > 0);
  }, [data, selected]);

  // Cells inside the current viewport drive the bottom table.
  const inView = useMemo(() => {
    return cells
      .filter((c) => {
        const [x, y] = project(c.lat, c.lon);
        return x >= vb[0] && x <= vb[0] + vb[2] && y >= vb[1] && y <= vb[1] + vb[3];
      })
      .sort(
        (a, b) =>
          b.providers.reduce((s, p) => s + p.samples, 0) -
          a.providers.reduce((s, p) => s + p.samples, 0),
      );
  }, [cells, vb]);

  const chainMatches = useMemo(() => {
    const q = chainQuery.trim().toLowerCase();
    if (!q) return [];
    return RPC_DIRECTORY.filter(
      (c) => c.name.toLowerCase().includes(q) || c.slug.includes(q),
    ).slice(0, 8);
  }, [chainQuery]);

  const toSvgPoint = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const el = svgRef.current;
      if (!el) return [0, 0];
      const r = el.getBoundingClientRect();
      return [
        vb[0] + ((clientX - r.left) / r.width) * vb[2],
        vb[1] + ((clientY - r.top) / r.height) * vb[3],
      ];
    },
    [vb],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      setVb((cur) => {
        const [px, py] = toSvgPoint(e.clientX, e.clientY);
        const w = Math.min(WORLD_W, Math.max(40, cur[2] * factor));
        const h = (w / WORLD_W) * WORLD_H;
        let x = px - ((px - cur[0]) / cur[2]) * w;
        let y = py - ((py - cur[1]) / cur[3]) * h;
        x = Math.max(0, Math.min(WORLD_W - w, x));
        y = Math.max(0, Math.min(WORLD_H - h, y));
        return [x, y, w, h];
      });
    },
    [toSvgPoint],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY, vb, moved: false };
    },
    [vb],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = svgRef.current;
    if (!d || !el) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / r.width) * d.vb[2];
    const dy = ((e.clientY - d.y) / r.height) * d.vb[3];
    const x = Math.max(0, Math.min(WORLD_W - d.vb[2], d.vb[0] - dx));
    const y = Math.max(0, Math.min(WORLD_H - d.vb[3], d.vb[1] - dy));
    setVb([x, y, d.vb[2], d.vb[3]]);
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const zoomed = vb[2] < WORLD_W - 1;
  const zoomRatio = vb[2] / WORLD_W; // 1 = world, small = deep zoom
  const dotR = Math.max(1.6, 5.2 * zoomRatio);
  const showCityLabels = zoomRatio < 0.35;
  const showMsLabels = zoomRatio < 0.16;

  const toggleProvider = (slug: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const pickChain = (slug: string) => {
    setChain(slug);
    setChainQuery("");
    setSelected(new Set());
    setVb([0, 0, WORLD_W, WORLD_H]);
  };

  return (
    <div className="mt-8">
      {/* Chain picker: featured chips + search over all 87 chains */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {FEATURED.map((slug) => {
          const c = RPC_DIRECTORY.find((x) => x.slug === slug);
          if (!c) return null;
          const active = chain === slug;
          return (
            <button
              key={slug}
              type="button"
              onClick={() => pickChain(slug)}
              className={`label-mono text-[11px] rounded-full pl-1.5 pr-3 py-1 border transition-colors inline-flex items-center gap-1.5 ${
                active ? "border-ink" : "border-rule text-ink-soft hover:border-ink/40 hover:text-ink"
              }`}
              style={active ? { background: "var(--color-ink)", color: "var(--color-paper, #fff)" } : undefined}
            >
              <ProviderLogo slug={slug} name={c.name} size={16} />
              {c.name}
            </button>
          );
        })}
        <div className="relative min-w-[220px]">
          <input
            value={chainQuery}
            onChange={(e) => setChainQuery(e.target.value)}
            placeholder={
              FEATURED.includes(chain)
                ? `Search ${RPC_DIRECTORY.length} chains…`
                : `${RPC_DIRECTORY.find((c) => c.slug === chain)?.name ?? chain} · search…`
            }
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-full border border-rule bg-transparent px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint/70 focus:border-ink/50 focus:outline-none"
          />
          {chainMatches.length > 0 && (
            <ul
              className="absolute z-20 mt-1 w-full rounded-md border border-rule shadow-lg overflow-hidden"
              style={{ background: "var(--color-paper, #fff)" }}
            >
              {chainMatches.map((c) => (
                <li key={c.slug}>
                  <button
                    type="button"
                    onClick={() => pickChain(c.slug)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-ink/5 transition-colors"
                  >
                    <ProviderLogo slug={c.slug} name={c.name} size={16} />
                    <span className="flex-1">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Provider multi-filter: compare a chosen subset on the map */}
      {providersInData.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="label-mono text-[10px] text-ink-faint mr-1">Compare:</span>
          {providersInData.map((slug) => {
            const active = selected.has(slug);
            return (
              <button
                key={slug}
                type="button"
                onClick={() => toggleProvider(slug)}
                className={`label-mono text-[10px] rounded-full pl-1 pr-2.5 py-0.5 border transition-colors inline-flex items-center gap-1 ${
                  active ? "border-ink text-ink" : "border-rule text-ink-faint hover:text-ink hover:border-ink/40"
                }`}
                style={active ? { background: "color-mix(in srgb, var(--color-ink) 8%, transparent)" } : undefined}
              >
                <ProviderLogo slug={slug} name={providerName(slug)} size={14} />
                {providerName(slug)}
                {active && <span aria-hidden>×</span>}
              </button>
            );
          })}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="label-mono text-[10px] text-ink-faint hover:text-ink"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Map */}
      <div
        className="relative rounded-xl border border-rule overflow-hidden"
        style={{ background: "var(--color-paper-soft, #faf7f0)" }}
      >
        <svg
          ref={svgRef}
          viewBox={vb.join(" ")}
          className="w-full block touch-none select-none"
          style={{ aspectRatio: `${WORLD_W} / ${WORLD_H * 0.86}`, cursor: "grab" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <path
            d={WORLD_PATH}
            fill="var(--color-rule, #e8e2d6)"
            fillOpacity="0.5"
            stroke="var(--color-ink-faint)"
            strokeOpacity="0.3"
            strokeWidth={Math.max(0.3, 0.6 * zoomRatio)}
          />
          {cells.map((c) => {
            const [x, y] = project(c.lat, c.lon);
            const best = c.providers[0];
            if (!best) return null;
            const n = c.providers.reduce((s, p) => s + p.samples, 0);
            const r = dotR + Math.min(2.5, Math.log2(1 + n) * zoomRatio * 2);
            const color = latencyColor(best.p50);
            return (
              <g key={c.gh}>
                {/* soft halo then crisp dot: reads as data, not sticker */}
                <circle cx={x} cy={y} r={r * 2.1} fill={color} fillOpacity="0.14" />
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={color}
                  stroke="var(--color-paper, #fff)"
                  strokeWidth={r * 0.28}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => {
                    setHover(c);
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (rect) setHoverXY([e.clientX - rect.left, e.clientY - rect.top]);
                  }}
                  onMouseLeave={() => setHover(null)}
                />
                {showCityLabels && (
                  <text
                    x={x + r + 2.5 * zoomRatio * 8}
                    y={y - r * 0.4}
                    fontSize={Math.max(3.4, 11 * zoomRatio)}
                    fill="var(--color-ink)"
                    style={{ pointerEvents: "none", fontFamily: "var(--font-sans, sans-serif)", fontWeight: 600 }}
                  >
                    {c.city}
                  </text>
                )}
                {showMsLabels && (
                  <text
                    x={x + r + 2.5 * zoomRatio * 8}
                    y={y + r + Math.max(3.4, 11 * zoomRatio) * 0.8}
                    fontSize={Math.max(3, 9.5 * zoomRatio)}
                    fill={color}
                    style={{ pointerEvents: "none", fontFamily: "var(--font-mono, monospace)" }}
                  >
                    {providerName(best.slug)} · {Math.round(best.p50)} ms
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="absolute z-10 pointer-events-none rounded-lg border border-rule px-3.5 py-2.5 shadow-lg"
            style={{
              left: Math.min(hoverXY[0] + 14, (svgRef.current?.clientWidth ?? 600) - 220),
              top: hoverXY[1] + 12,
              background: "var(--color-paper, #fff)",
              minWidth: 190,
            }}
          >
            <p className="text-[13px] font-semibold text-ink">
              {hover.city}
              <span className="text-ink-faint font-normal ml-1.5">{hover.country}</span>
            </p>
            <div className="mt-1.5 space-y-1">
              {(selected.size > 0
                ? hover.providers.filter((p) => selected.has(p.slug))
                : hover.providers
              )
                .slice(0, 5)
                .map((p, i) => (
                  <div key={p.slug} className="flex items-center gap-2 text-[12px]">
                    <span className="label-mono text-[10px] text-ink-faint w-3">{i + 1}</span>
                    <ProviderLogo slug={p.slug} name={providerName(p.slug)} size={14} />
                    <span className="text-ink flex-1 truncate">{providerName(p.slug)}</span>
                    <span className="label-mono tabular-nums" style={{ color: latencyColor(p.p50) }}>
                      {Math.round(p.p50)} ms
                    </span>
                  </div>
                ))}
            </div>
            <p className="mt-1.5 label-mono text-[9px] text-ink-faint">
              {hover.providers.reduce((s, p) => s + p.samples, 0)} samples in this area
            </p>
          </div>
        )}

        {/* Reset zoom floating control */}
        {zoomed && (
          <button
            type="button"
            onClick={() => setVb([0, 0, WORLD_W, WORLD_H])}
            className="absolute top-3 right-3 z-10 label-mono text-[10px] rounded-full border border-rule px-3 py-1 text-ink-soft hover:text-ink"
            style={{ background: "var(--color-paper, #fff)" }}
          >
            ⌂ World view
          </button>
        )}

        {/* Empty / loading states */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="label-mono text-[11px] text-ink-faint">Loading map…</p>
          </div>
        )}
        {!loading && cells.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
            <p className="text-sm text-ink-soft max-w-md">
              {selected.size > 0
                ? "No samples for this provider selection here yet. Clear the filter or run a test with these providers."
                : "No community samples for this chain yet. The map fills up as people run the speed test: every completed test adds one anonymous point to its city."}
            </p>
            <Link href="/speedtest-rpc" className="lnk text-sm font-semibold">
              Run a test for this chain →
            </Link>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 label-mono text-[10px] text-ink-faint">
        <span>Median latency:</span>
        {[
          ["under 50 ms", "#10b981"],
          ["50-120", "#84cc16"],
          ["120-200", "#f59e0b"],
          ["200-400", "#f97316"],
          ["over 400", "#ef4444"],
        ].map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="ml-auto">
          scroll to zoom · drag to pan
          {data ? ` · ${data.total} tests contributed` : ""}
        </span>
      </div>

      {/* Viewport-driven ranking: zoom into a region and this becomes
          that region's leaderboard. */}
      {inView.length > 0 && (
        <div className="mt-10">
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <h2 className="display text-xl text-ink">
              {zoomed ? "In the area you are viewing" : "Busiest areas"}
            </h2>
            <span className="label-mono text-[10px] text-ink-faint">
              {inView.length} area{inView.length > 1 ? "s" : ""}
              {selected.size > 0 ? ` · ${selected.size} provider${selected.size > 1 ? "s" : ""} compared` : ""}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="label-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint text-left border-b-2 border-ink">
                  <th className="py-2 pr-4">Area</th>
                  <th className="py-2 pr-4">Fastest provider</th>
                  <th className="py-2 pr-4 text-right">Median</th>
                  <th className="py-2 pr-4 text-right hidden sm:table-cell">Runner-up</th>
                  <th className="py-2 text-right">Samples</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {inView.slice(0, 15).map((c) => {
                  const best = c.providers[0];
                  const second = c.providers[1];
                  return (
                    <tr key={c.gh}>
                      <td className="py-2.5 pr-4 text-ink">
                        {c.city}, {c.country}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="inline-flex items-center gap-1.5 text-ink">
                          <ProviderLogo slug={best.slug} name={providerName(best.slug)} size={16} />
                          {providerName(best.slug)}
                        </span>
                      </td>
                      <td
                        className="py-2.5 pr-4 text-right label-mono tabular-nums"
                        style={{ color: latencyColor(best.p50) }}
                      >
                        {Math.round(best.p50)} ms
                      </td>
                      <td className="py-2.5 pr-4 text-right text-ink-faint text-[12px] hidden sm:table-cell">
                        {second ? `${providerName(second.slug)} · ${Math.round(second.p50)} ms` : "-"}
                      </td>
                      <td className="py-2.5 text-right label-mono tabular-nums text-ink-faint">
                        {c.providers.reduce((s, p) => s + p.samples, 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
