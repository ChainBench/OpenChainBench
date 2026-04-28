import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";

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
              <td className="py-3 pr-3 font-serif text-ink">{r.name}</td>
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
                return (
                  <td key={region.key} className="py-3 px-2">
                    <div className="grid grid-cols-[1fr_5rem] items-center gap-3">
                      <div className="relative h-3 bg-paper-deep">
                        <span
                          className="absolute inset-y-0 left-0 bg-ink-soft/70"
                          style={{
                            width: `${pct}%`,
                            backgroundImage:
                              "repeating-linear-gradient(135deg, transparent 0 4px, rgba(250,246,238,0.45) 4px 5px)",
                          }}
                        />
                      </div>
                      <span className="font-mono text-[12px] tabular text-right whitespace-nowrap text-ink-soft">
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
