"use client";

import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

type Props = { benchmark: Benchmark };

const REGIONS = [
  { key: "us-east", label: "US-East" },
  { key: "eu-west", label: "EU-West" },
  { key: "ap-southeast", label: "AP-Southeast" },
] as const;

export function RegionGrid({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  if (!results.length) return null;

  const colors = buildProviderColors(results);

  const regionMax = new Map<string, number>();
  for (const region of REGIONS) {
    let m = 0;
    for (const r of results) {
      const point = extras.regions[r.slug]?.find((p) => p.region === region.key);
      if (point && point.p50 > m) m = point.p50;
    }
    regionMax.set(region.key, m);
  }

  return (
    <div className="border-y-2 border-ink py-2">
      <table className="w-full border-collapse text-sm tabular">
        <thead>
          <tr className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-soft">
            <th className="py-2 pr-3 text-left font-medium w-44">Provider</th>
            {REGIONS.map((region) => (
              <th key={region.key} className="py-2 px-2 text-left font-medium">
                {region.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {results.map((r) => {
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            return (
              <tr key={r.slug} className="border-t border-rule transition-colors hover:bg-paper-soft/50">
                <td className="py-3 pr-3 font-serif text-ink">
                  <span className="font-semibold" style={{ color }}>
                    {r.name}
                  </span>
                </td>
                {REGIONS.map((region) => {
                  const point = extras.regions[r.slug]?.find(
                    (p) => p.region === region.key
                  );
                  if (!point) {
                    return (
                      <td key={region.key} className="py-3 px-2 text-ink-faint">
                        -
                      </td>
                    );
                  }
                  const max = regionMax.get(region.key) ?? 1;
                  const pct = Math.max(2, (point.p50 / max) * 100);
                  return (
                    <td key={region.key} className="py-3 px-2">
                      <div className="grid grid-cols-[1fr_5rem] items-center gap-3">
                        <div
                          className="relative h-3 rounded-sm overflow-hidden"
                          style={{ background: `${color}14` /* 8% */ }}
                        >
                          <span
                            className="absolute inset-y-0 left-0 rounded-sm"
                            style={{
                              width: `${pct}%`,
                              background: color,
                              opacity: 0.85,
                            }}
                          />
                        </div>
                        <span
                          className="font-mono text-[12px] tabular text-right whitespace-nowrap"
                          style={{ color }}
                        >
                          {fmtUnit(point.p50, unit)}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
