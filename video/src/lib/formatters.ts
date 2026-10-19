/**
 * Display formatters shared across every composition. Single source of
 * truth for how each metric unit renders, so a tweak to ms precision
 * propagates everywhere at once.
 */

export function formatValue(value: number, unit: string): string {
  // NaN / Infinity slip in when a lerp interpolates against undefined or
  // when a rank computation picks an out-of-range index. Always render a
  // placeholder rather than the literal "NaN".
  if (!Number.isFinite(value)) return "—";
  if (unit === "ms" || unit === "s") {
    // The payload comes from OCB's /api/series without ?raw=1, which
    // converts "s" benches to seconds (site #1694, 2026-07-29). This
    // function still divided by 1000 as if it got milliseconds, so every
    // seconds bench rendered "0 ms" or "0.0 s" (aggregator-head-lag: six
    // providers between 0.3 s and 26 s, all printed as zero).
    if (unit === "s") {
      const s = value;
      if (s >= 60) return `${(s / 60).toFixed(1)} min`;
      if (s === 0) return "0 s";
      if (s < 0.1) return `${(s * 1000).toFixed(0)} ms`;
      // Two decimals under a second: 0.31 s and 0.32 s are a ranking,
      // one decimal printed both as 0.3.
      if (s < 1) return `${s.toFixed(2)} s`;
      if (s < 10) return `${s.toFixed(1)} s`;
      return `${s.toFixed(0)} s`;
    }
    const ms = value;
    // ms — same auto-scaling we had before.
    if (ms >= 60_000)
      return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${ms.toFixed(0)} ms`;
  }
  if (unit === "usd") {
    // Sub-cent values (Stellar fees ~ $0.0000018) keep two significant
    // digits in plain decimals: "$1.76e-6" is not something a viewer
    // reads in the second a label is on screen.
    if (value > 0 && value < 0.0001) {
      if (value < 1e-8) return "<$0.00000001";
      return `$${value.toFixed(Math.ceil(-Math.log10(value)) + 1)}`;
    }
    if (value < 0.01) return `$${value.toFixed(4)}`;
    if (value < 1) return `$${value.toFixed(3)}`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value.toFixed(2)}`;
  }
  if (unit === "count") {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value.toFixed(0);
  }
  if (unit === "bps") return `${value.toFixed(1)} bps`;
  if (unit === "pct" || unit === "%") return `${value.toFixed(2)}%`;
  if (unit === "slots") return `${value.toFixed(1)} slots`;
  return value.toFixed(2);
}

/** Axis tick variant — shorter, for crowded chart edges. */
export function formatTick(value: number, unit: string): string {
  if (unit === "ms" || unit === "s") {
    // Same convention as formatValue: "s" payloads are seconds.
    const ms = unit === "s" ? value * 1000 : value;
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(ms >= 600_000 ? 0 : 1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
    return `${Math.round(ms)}ms`;
  }
  if (unit === "count") return Math.round(value).toString();
  if (unit === "usd") {
    if (value > 0 && value < 0.01) return formatValue(value, "usd");
    if (value < 1) return `$${value.toFixed(2)}`;
    if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`;
    return `$${value.toFixed(0)}`;
  }
  if (unit === "pct" || unit === "%") return `${value.toFixed(value < 10 ? 1 : 0)}%`;
  if (unit === "bps") return `${value.toFixed(0)}bps`;
  if (unit === "slots") return value.toFixed(0);
  return value.toFixed(1);
}

/** What the Y-axis numbers measure — shown as a small axis caption. */
export function unitAxisLabel(unit: string): string {
  if (unit === "ms") return "milliseconds";
  if (unit === "s") return "seconds";
  if (unit === "usd") return "price (USD)";
  if (unit === "pct" || unit === "%") return "percent";
  if (unit === "count") return "count";
  if (unit === "bps") return "basis points";
  if (unit === "slots") return "slots";
  return unit;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "04 Jun" — the big date-ticker face. */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate().toString().padStart(2, "0")} ${MONTHS[d.getUTCMonth()]}`;
}

/** "4 Jun" — axis tick variant, no zero-padding. */
export function formatDateShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "4 Jun, 14:30" — finer-grained tick for ≤24 h windows. */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:${mm}`;
}

/**
 * "Nice" axis ticks within [min, max]. Rounds the step to a power-of-10
 * × {1, 2, 2.5, 5} candidate so labels are 200ms / 500ms / 1s / 2s, not
 * 173ms / 412ms.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const rawStep = range / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step =
    candidates.find((s) => range / s <= target * 1.4) ?? candidates[candidates.length - 1];
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

/** N evenly-spaced timestamps from the array, for X-axis ticks. */
export function dateTicks(
  timestamps: number[],
  target = 5,
): { ts: number; frac: number }[] {
  if (timestamps.length === 0) return [];
  const out: { ts: number; frac: number }[] = [];
  for (let i = 0; i < target; i++) {
    const frac = i / (target - 1);
    const idx = Math.round(frac * (timestamps.length - 1));
    out.push({ ts: timestamps[idx], frac });
  }
  return out;
}
