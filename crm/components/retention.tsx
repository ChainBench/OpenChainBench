import { fmtInt, fmtPct } from "@/components/ui";
import type { FrequencyRow, RetentionRow } from "@/lib/traffic";

/**
 * Do visitors come back, and how often.
 *
 * The dashboard could only say new vs returning in the last 7 days,
 * which counts someone who came back once and someone who comes back
 * every week as the same thing. Two views instead:
 *
 *  - the cohort grid, which follows each week's arrivals forward and so
 *    answers whether retention is improving or the site is just buying
 *    new traffic;
 *  - the frequency histogram, which answers how sticky the people who do
 *    come back actually are.
 *
 * A cohort is the week a device was first seen EVER, not the first week
 * of the window, so the top-left is genuinely new arrivals.
 *
 * Week 0 is the cohort itself and is always 100%, so it is printed as
 * the cohort size rather than as a percentage nobody needs.
 */
export function RetentionGrid({ rows, firstDay }: { rows: RetentionRow[]; firstDay: string | null }) {
  if (rows.length === 0) return null;

  const cohorts = [...new Set(rows.map((r) => r.cohort))].sort();
  const maxWeek = Math.max(...rows.map((r) => r.week));
  const at = new Map(rows.map((r) => [`${r.cohort}:${r.week}`, r.visitors]));
  const size = (c: string) => at.get(`${c}:0`) ?? 0;

  // A cohort that has not had n weeks to come back yet must read as blank,
  // not as 0%: an empty cell and a cell of zero say opposite things.
  const weeksElapsed = (c: string) =>
    Math.floor((Date.now() - new Date(`${c}T00:00:00Z`).getTime()) / (7 * 864e5));

  const shade = (pct: number) => {
    if (!Number.isFinite(pct) || pct <= 0) return "transparent";
    // One hue, opacity carries the value; a rainbow scale would imply
    // categories where there is only magnitude.
    return `color-mix(in srgb, var(--accent) ${Math.min(100, 12 + pct * 88).toFixed(0)}%, transparent)`;
  };

  return (
    <div className="panel px-4 py-3">
      <p className="label">Weekly retention, by the week a visitor first arrived</p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        Each row is the visitors who first appeared that week; each column is
        how many of them came back n weeks later. Blank means the cohort has
        not reached that week yet.
        {firstDay ? ` Events begin ${firstDay}, so earlier cohorts are short.` : ""}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="label px-2 py-1 text-left">Cohort</th>
              <th className="label px-2 py-1 text-right">Visitors</th>
              {Array.from({ length: maxWeek }, (_, i) => (
                <th key={i + 1} className="label px-2 py-1 text-right">
                  +{i + 1}w
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => {
              const n0 = size(c);
              const elapsed = weeksElapsed(c);
              return (
                <tr key={c}>
                  <td className="mono px-2 py-1 whitespace-nowrap">{c}</td>
                  <td className="mono px-2 py-1 text-right">{fmtInt(n0)}</td>
                  {Array.from({ length: maxWeek }, (_, i) => {
                    const w = i + 1;
                    if (w > elapsed) return <td key={w} className="px-2 py-1" />;
                    const v = at.get(`${c}:${w}`) ?? 0;
                    const pct = n0 > 0 ? v / n0 : 0;
                    return (
                      <td
                        key={w}
                        className="mono px-2 py-1 text-right"
                        style={{ background: shade(pct) }}
                        title={`${fmtInt(v)} of ${fmtInt(n0)} came back in week +${w}`}
                      >
                        {n0 > 0 ? fmtPct(pct) : "–"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** How many distinct days each visitor was active over 28 days. */
export function FrequencyPanel({ rows }: { rows: FrequencyRow[] }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((t, r) => t + r.visitors, 0);
  if (total === 0) return null;

  // Buckets, because a 28-column histogram of a long tail reads as noise.
  const buckets = [
    { label: "1 day", test: (d: number) => d === 1 },
    { label: "2 to 3 days", test: (d: number) => d >= 2 && d <= 3 },
    { label: "4 to 7 days", test: (d: number) => d >= 4 && d <= 7 },
    { label: "8 to 14 days", test: (d: number) => d >= 8 && d <= 14 },
    { label: "15 days or more", test: (d: number) => d >= 15 },
  ].map((b) => ({ label: b.label, visitors: rows.filter((r) => b.test(r.days)).reduce((t, r) => t + r.visitors, 0) }));

  const returning = total - (buckets[0]?.visitors ?? 0);
  const max = Math.max(1, ...buckets.map((b) => b.visitors));

  return (
    <div className="panel px-4 py-3">
      <p className="label">How often a visitor comes back, 28 d</p>
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        {fmtInt(returning)} of {fmtInt(total)} visitors ({fmtPct(returning / total)}) came
        back on a second day. Days are UTC, and a visitor is a device.
      </p>
      <ul className="mt-3 space-y-1.5">
        {buckets.map((b) => (
          <li key={b.label} className="grid grid-cols-[minmax(0,1fr)_3fr_auto] items-center gap-2 text-xs">
            <span className="truncate">{b.label}</span>
            <span className="h-2 rounded-sm" style={{ background: "var(--line)" }}>
              <span
                className="block h-2 rounded-sm"
                style={{ width: `${(b.visitors / max) * 100}%`, background: "var(--accent)" }}
              />
            </span>
            <span className="mono" style={{ color: "var(--muted)" }}>
              {fmtInt(b.visitors)} · {fmtPct(b.visitors / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
