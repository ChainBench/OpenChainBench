/** Convert a stored value into the bench's declared unit for machine
 *  readable payloads. Latency benches with unit "s" store milliseconds
 *  by convention (see fmtUnit below, which divides by 1000 before
 *  rendering). That convention must not leak into public JSON where
 *  agents read `value` + `unit` literally: aggregator-head-lag shipped
 *  {"value":645,"unit":"s"} while the headline said "0.6 s". Every
 *  other unit stores exactly what it declares. */
export function valueInDeclaredUnit(value: number, unit: string): number {
  return unit === "s" ? value / 1000 : value;
}

/** "2026-07-06 14:00 UTC" from an ISO timestamp. Fixed UTC rendering so
 *  server and client HTML agree (no hydration drift) and answer engines
 *  get an unambiguous freshness stamp. Shared by benchmark-body and the
 *  answers pages so the dated line reads identically everywhere. */
export function fmtAsOfUtc(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function fmtUnit(value: number, unit: string) {
  if (!Number.isFinite(value)) return "-";
  if (unit === "pct") return formatPercent(value);
  if (unit === "bps") {
    // Legacy: bps stored. Convert to percent for display.
    return formatPercent(value / 100);
  }
  if (unit === "bp") {
    // Basis points displayed AS basis points (signed). Funding-style
    // figures (fractions of a bp per day) become unreadable through the
    // bps->percent conversion above: -0.74 bp rendered "-0.0074%".
    const abs = Math.abs(value);
    if (value === 0) return "0 bps";
    if (abs < 0.005) return "~0 bps";
    if (abs < 10) return `${value.toFixed(2)} bps`;
    if (abs < 100) return `${value.toFixed(1)} bps`;
    return `${value.toFixed(0)} bps`;
  }
  if (unit === "sec") {
    // True seconds (unlike "s", whose input is ms by latency-bench
    // convention). Used by gauges like hl_*_last_fill_age_seconds.
    const s = value;
    if (s >= 172800) return `${(s / 86400).toFixed(1)} d`;
    if (s >= 3600) return `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)} h`;
    if (s >= 60) return `${(s / 60).toFixed(1)} min`;
    if (s > 0 && s < 0.1) return "<0.1 s";
    return `${s.toFixed(1)} s`;
  }
  if (unit === "s") {
    const ms = value;
    const s = ms / 1000;
    if (s >= 60) return `${(s / 60).toFixed(1)} min`;
    if (ms === 0) return "<1 s";
    // Sub-10s: render as "X.Y s" so all chains in the same ballpark
    // read with the same units (avoids "1 s" next to "1096 ms" for
    // values 100ms apart). Sub-second precision is preserved as 0.1 s
    // rather than ms - fine grain enough for finality comparison.
    if (s < 10) return `${s.toFixed(1)} s`;
    return `${s.toFixed(0)} s`;
  }
  if (unit === "slots") {
    // Solana slot delta. integer-ish (gauge stores last observed slot
    // delta, p50 over 7d may be fractional e.g. 1.5). Show 1 decimal for
    // sub-10, integer for larger. Suffix is " slot" or " slots".
    if (value === 0) return "0 slots";
    if (value < 10) {
      const formatted = value.toFixed(1);
      return `${formatted} ${formatted === "1.0" ? "slot" : "slots"}`;
    }
    return `${value.toFixed(0)} slots`;
  }
  if (unit === "count") {
    // Sub-unit values are common when a "count" bench is measuring an
    // error or gap that converges toward zero (e.g. gas-oracle prediction
    // error in gwei — PublicNode feeHistory's p50 sits around 1e-9,
    // mathematically perfect). Default toLocaleString silently rounds
    // those to "0", so the headline card reads as "no data" instead of
    // "essentially zero".
    if (value > 0 && value < 0.01) return "~0";
    if (value > 0 && value < 1) return value.toFixed(3);
    return formatCompactCount(value);
  }
  if (unit === "gwei") {
    // Same near-zero semantics as count (gas-estimation gaps converge
    // toward zero), but the unit is carried so API consumers and the
    // ledger say gwei instead of a bare number.
    if (value > 0 && value < 0.01) return "~0 gwei";
    if (value > 0 && value < 1) return `${value.toFixed(3)} gwei`;
    return `${formatCompactCount(value)} gwei`;
  }
  if (unit === "usd") {
    if (value === 0) return "$0";
    const abs = Math.abs(value);
    // Fee-grade precision: network fees can be 6 decimals deep
    // ($0.000001 Avalanche transfer), so we can't collapse anything
    // sub-cent to "~$0". Pick decimals by magnitude so the digit count
    // stays readable.
    if (abs < 0.000001) return `$${value.toExponential(2)}`;
    if (abs < 0.0001) return `$${value.toFixed(7)}`;
    if (abs < 0.001) return `$${value.toFixed(6)}`;
    if (abs < 0.01) return `$${value.toFixed(5)}`;
    if (abs < 1) return `$${value.toFixed(4)}`;
    if (abs < 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    return `$${formatCompactCount(value)}`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  // Sub-millisecond values keep one decimal: pm-data-freshness's 0.5 ms
  // anchor rendered "1 ms", contradicting the 0.5 published by the
  // citable API (2x apart, flagged by the coherence audit).
  if (value > 0 && value < 1) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(0)} ms`;
}

/** Just the unit suffix, with a leading space. used by BigNumber.
 *
 * Accepts an optional `value` so callers that split number and suffix
 * (e.g. share cards rendering the number in display size and the unit
 * as a subscript) can mirror the auto-conversion `fmtUnit` already does.
 * Without the value, sub-60s readings of seconds-unit benches will
 * still render as "s" while `fmtUnit` flipped the number to minutes,
 * producing nonsense like "15.9 s" for an Ethereum p50 that is actually
 * 15.9 minutes.
 */
export function unitSuffix(unit: string, value?: number): string {
  if (unit === "pct" || unit === "bps") return " %";
  if (unit === "bp") return " bps";
  if (unit === "sec") {
    if (value !== undefined && Number.isFinite(value)) {
      if (value >= 172800) return " d";
      if (value >= 3600) return " h";
      if (value >= 60) return " min";
    }
    return " s";
  }
  if (unit === "s") {
    // Mirror fmtUnit: ms → s, with auto-flip to minutes at 60s.
    if (value !== undefined && Number.isFinite(value)) {
      const s = value / 1000;
      if (s >= 60) return " min";
    }
    return " s";
  }
  if (unit === "ms") {
    // Mirror fmtUnit's fallback: ms-in, auto-flip to s at 1000 and min
    // at 60000. Without this, share cards on benches like l2-block-time
    // render "2.00 ms" for a 2000ms p50 because fmtValue strips the "s"
    // that fmtUnit added and unitSuffix slapped " ms" back on.
    if (value !== undefined && Number.isFinite(value)) {
      if (value >= 60000) return " min";
      if (value >= 1000) return " s";
    }
    return " ms";
  }
  if (unit === "slots") return " slots";
  if (unit === "count") return "";
  if (unit === "gwei") return " gwei";
  if (unit === "usd") return "";
  return " ms";
}

/** Just the formatted number (no unit). used by BigNumber where the unit
 * is rendered separately for typography. */
export function fmtValue(value: number, unit: string): string {
  // Keep K/M/B suffixes and $ prefix — they are part of the number, not a
  // unit. Only strip trailing unit words that the caller renders separately.
  return fmtUnit(value, unit).replace(/\s+(ms|s|min|h|d|bps|slots?)$/, "").replace(/\s*%$/, "");
}

/** Compact short-form for large counts so the home table's narrow value
 * column doesn't overflow (e.g. solana-tx-landing market share ~11M txs
 * would render as `11,146,337.253` at ~250 px and bust the 9 rem grid
 * cell). Thresholds picked so anything below 10k stays in full
 * locale-formatted form (still useful for low-volume benches), and 10k+
 * collapses to K / M / B with 1-2 significant decimals. */
function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  // Locale pinned: rendered both server-side and client-side ("use client"
  // ledger). Browser-default locale produced "5 560,409" on fr-FR machines.
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Smart-precision percent formatter. picks decimals based on magnitude
 * so both small fees (0.033%) and large fees (12.50%) read cleanly. */
function formatPercent(pct: number): string {
  if (pct === 0) return "0%";
  const abs = Math.abs(pct);
  if (abs >= 10) return `${pct.toFixed(1)}%`;
  if (abs >= 1) return `${pct.toFixed(2)}%`;
  if (abs >= 0.1) return `${pct.toFixed(2)}%`;
  if (abs >= 0.01) return `${pct.toFixed(3)}%`;
  if (abs >= 0.001) return `${pct.toFixed(4)}%`;
  return `${pct.toFixed(5)}%`;
}
