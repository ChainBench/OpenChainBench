import type { Benchmark } from "@/data/benchmarks";
import { cn } from "@/lib/utils";
import { fmtUnit } from "@/lib/format";

type Props = {
  benchmark: Benchmark;
};

const REGIONS = [
  { key: "us-east", label: "US-East" },
  { key: "eu-west", label: "EU-West" },
  { key: "ap-southeast", label: "AP-Southeast" },
] as const;

/**
 * Per-region p50 grid — Tufte small multiples in a single dense table.
 * Best provider per region is highlighted; gradient bar shows relative pace.
 */
export function RegionGrid({ benchmark }: Props) {
  const { results, unit, extras } = benchmark;
  const leaderSlug = [...results].sort((a, b) => a.ms.p50 - b.ms.p50)[0]?.slug;

  // For each region, find the global max p50 to scale bars consistently.
  const regionMax = new Map<string, number>();
  for (const region of REGIONS) {
    let m = 0;
    for (const r of results) {
      const point = extras.regions[r.slug]?.find((p) => p.region === region.key);
      if (point && point.p50 > m) m = point.p50;
    }
    regionMax.set(region.key, m);
  }

  // For each region, find the leader.
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
          {results.map((r) => (
            <tr key={r.slug} className="border-t border-rule">
              <td className="py-3 pr-3 font-serif text-ink">
                <span
                  className={cn(
                    leaderSlug === r.slug ? "font-semibold" : "font-normal"
                  )}
                >
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
                      —
                    </td>
                  );
                }
                const max = regionMax.get(region.key) ?? 1;
                const pct = Math.max(2, (point.p50 / max) * 100);
                const isLeader = regionLeader.get(region.key) === r.slug;
                return (
                  <td key={region.key} className="py-3 px-2">
                    <div className="flex items-center gap-2">
                      <div className="relative h-3 flex-1 max-w-[12rem] bg-paper-deep">
                        <span
                          className={cn(
                            "absolute inset-y-0 left-0",
                            isLeader ? "bg-ink" : "bg-ink-soft/70"
                          )}
                          style={{
                            width: `${pct}%`,
                            backgroundImage: isLeader
                              ? undefined
                              : "repeating-linear-gradient(135deg, transparent 0 4px, rgba(250,246,238,0.45) 4px 5px)",
                          }}
                        />
                      </div>
                      <span
                        className={cn(
                          "font-mono text-[12px] tabular shrink-0",
                          isLeader ? "font-semibold text-ink" : "text-ink-soft"
                        )}
                      >
                        {fmtUnit(point.p50, unit)}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
