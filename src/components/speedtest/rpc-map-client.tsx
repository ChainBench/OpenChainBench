"use client";

/**
 * Crowdsourced RPC latency world map. Cells are geohash-4 aggregates of
 * anonymous browser speed tests (see /speedtest-rpc); each dot is the
 * median contributed latency at that location, colored on the same
 * green-amber-red scale as the speed test dial. Pure SVG: no tile
 * server, no map library, zero per-visitor server cost.
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
  const [data, setData] = useState<MapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<MapCell | null>(null);
  const [hoverXY, setHoverXY] = useState<[number, number]>([0, 0]);
  // viewBox as [x, y, w, h]; wheel zooms toward the cursor, drag pans.
  const [vb, setVb] = useState<[number, number, number, number]>([0, 0, WORLD_W, WORLD_H]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; vb: typeof vb } | null>(null);

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

  const cells = useMemo(() => data?.cells ?? [], [data]);

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
        let w = Math.min(WORLD_W, Math.max(60, cur[2] * factor));
        let h = (w / WORLD_W) * WORLD_H;
        let x = px - ((px - cur[0]) / cur[2]) * w;
        let y = py - ((py - cur[1]) / cur[3]) * h;
        x = Math.max(0, Math.min(WORLD_W - w, x));
        y = Math.max(0, Math.min(WORLD_H - h, y));
        return [x, y, w, h];
      });
    },
    [toSvgPoint],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, vb };
  }, [vb]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = svgRef.current;
    if (!d || !el) return;
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
  const dotR = Math.max(3, 7 * (vb[2] / WORLD_W));

  return (
    <div className="mt-8">
      {/* Chain picker */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {FEATURED.map((slug) => {
          const c = RPC_DIRECTORY.find((x) => x.slug === slug);
          if (!c) return null;
          const active = chain === slug;
          return (
            <button
              key={slug}
              type="button"
              onClick={() => setChain(slug)}
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
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          className="label-mono text-[11px] rounded-md border border-rule bg-transparent px-2 py-1.5 text-ink-soft"
          aria-label="All chains"
        >
          {RPC_DIRECTORY.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        {zoomed && (
          <button
            type="button"
            onClick={() => setVb([0, 0, WORLD_W, WORLD_H])}
            className="label-mono text-[11px] text-ink-faint hover:text-ink ml-auto"
          >
            Reset zoom
          </button>
        )}
      </div>

      {/* Map */}
      <div className="relative rounded-xl border border-rule overflow-hidden" style={{ background: "var(--color-paper-soft, #faf7f0)" }}>
        <svg
          ref={svgRef}
          viewBox={vb.join(" ")}
          className="w-full block touch-none"
          style={{ aspectRatio: `${WORLD_W} / ${WORLD_H * 0.86}`, cursor: dragRef.current ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <path d={WORLD_PATH} fill="var(--color-rule, #e8e2d6)" fillOpacity="0.55" stroke="var(--color-ink-faint)" strokeOpacity="0.25" strokeWidth="0.5" />
          {cells.map((c) => {
            const [x, y] = project(c.lat, c.lon);
            const best = c.providers[0];
            if (!best) return null;
            const n = c.providers.reduce((s, p) => s + p.samples, 0);
            return (
              <g key={c.gh}>
                <circle
                  cx={x}
                  cy={y}
                  r={dotR + Math.min(3, Math.log2(1 + n))}
                  fill={latencyColor(best.p50)}
                  fillOpacity="0.85"
                  stroke="#fff"
                  strokeWidth={dotR * 0.25}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => {
                    setHover(c);
                    const r = svgRef.current?.getBoundingClientRect();
                    if (r) setHoverXY([e.clientX - r.left, e.clientY - r.top]);
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="absolute z-10 pointer-events-none rounded-lg border border-rule bg-paper px-3.5 py-2.5 shadow-lg"
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
              {hover.providers.slice(0, 5).map((p, i) => (
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

        {/* Empty / loading states */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="label-mono text-[11px] text-ink-faint">Loading map…</p>
          </div>
        )}
        {!loading && cells.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
            <p className="text-sm text-ink-soft max-w-md">
              No community samples for this chain yet. The map fills up as
              people run the speed test: every completed test adds one
              anonymous point to its city.
            </p>
            <Link href="/speedtest-rpc" className="lnk text-sm font-semibold">
              Run the first test for this chain →
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

      {/* Crawlable table of the busiest areas */}
      {cells.length > 0 && (
        <div className="mt-10">
          <h2 className="display text-xl text-ink mb-4">Busiest areas</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="label-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint text-left border-b-2 border-ink">
                  <th className="py-2 pr-4">Area</th>
                  <th className="py-2 pr-4">Fastest provider</th>
                  <th className="py-2 pr-4 text-right">Median</th>
                  <th className="py-2 text-right">Samples</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {cells.slice(0, 12).map((c) => {
                  const best = c.providers[0];
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
                      <td className="py-2.5 pr-4 text-right label-mono tabular-nums" style={{ color: latencyColor(best.p50) }}>
                        {Math.round(best.p50)} ms
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
