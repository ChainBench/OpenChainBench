import type { Benchmark } from "@/types/benchmark";
import { cn } from "@/lib/utils";
import { fmtUnit } from "@/lib/format";
import { providerColor } from "@/lib/colors";

type Props = { benchmark: Benchmark };

const REGIONS = [
  { key: "us-east", label: "US-East" },
  { key: "eu-west", label: "EU-West" },
  { key: "ap-southeast", label: "AP-Southeast" },
] as const;

export function RegionGrid({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  if (!results.length) return null;

  const regionMax = new Map<string, number>();
  for (const region of REGIONS) {
    let m = 0;
    for (const r of results) {
      const point = extras.regions[r.slug]?.find((p) => p.region === region.key);
      if (point && point.p50 > m) m = point.p50;
    }
    regionMax.set(region.key, m);
  }

  const regionLeader = new Map<string, string>();
  for (const region of REGIONS) {
    let leader = "";
    let best = Infinity;
    for (const r of results) {
      const point = extras.regions[r.slug]?.find((p) => p.region === region.key);
      if (point && point.p50 < best) {
        best = point.p50;
        leader = r.slug;
      }
    }
    regionLeader.set(region.key, leader);
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-rule bg-bg-soft text-[11px] uppercase tracking-[0.1em] text-ink-muted">
            <th className="py-3 px-5 text-left font-medium w-44">Provider</th>
            {REGIONS.map((region) => (
              <th key={region.key} className="py-3 px-3 text-left font-medium">
                {region.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const color = providerColor(r.slug);
            return (
              <tr key={r.slug} className="border-b border-rule last:border-b-0">
                <td className="py-3 px-5">
                  <span className="text-sm font-semibold" style={{ color }}>
                    {r.name}
                  </span>
                </td>
                {REGIONS.map((region) => {
                  const point = extras.regions[r.slug]?.find(
                    (p) => p.region === region.key
                  );
                  if (!point) {
                    return (
                      <td key={region.key} className="py-3 px-3 text-ink-faint">
                        —
                      </td>
                    );
                  }
                  const max = regionMax.get(region.key) ?? 1;
                  const pct = Math.max(2, (point.p50 / max) * 100);
                  const isLeader = regionLeader.get(region.key) === r.slug;
                  return (
                    <td key={region.key} className="py-3 px-3">
                      <div className="grid grid-cols-[1fr_5rem] items-center gap-3">
                        <div className="relative h-3 rounded-md bg-bg-soft">
                          <span
                            className="absolute inset-y-0 left-0 rounded-md"
                            style={{
                              width: `${pct}%`,
                              background: `${color}33`,
                            }}
                          />
                          <span
                            className="absolute inset-y-0 left-0 rounded-md"
                            style={{
                              width: `${pct * 0.5}%`,
                              background: color,
                              opacity: isLeader ? 1 : 0.5,
                            }}
                          />
                        </div>
                        <span
                          className={cn(
                            "font-mono text-[12px] tabular text-right whitespace-nowrap",
                            isLeader ? "font-semibold" : "text-ink-soft"
                          )}
                          style={isLeader ? { color } : undefined}
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
