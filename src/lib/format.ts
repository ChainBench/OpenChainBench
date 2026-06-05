export function fmtUnit(value: number, unit: string) {
  if (!Number.isFinite(value)) return "-";
  if (unit === "pct") return formatPercent(value);
  if (unit === "bps") {
    // Legacy: bps stored. Convert to percent for display.
    return formatPercent(value / 100);
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
    // error in gwei — Blocknative's p50 sits around 1e-9, mathematically
    // perfect). Default toLocaleString silently rounds those to "0", so
    // the headline card reads as "no data" instead of "essentially zero".
    if (value > 0 && value < 0.01) return "~0";
    if (value > 0 && value < 1) return value.toFixed(3);
    return formatCompactCount(value);
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
    if (abs < 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    return `$${formatCompactCount(value)}`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(0)} ms`;
}

/** Just the unit suffix, with a leading space. used by BigNumber. */
export function unitSuffix(unit: string) {
  if (unit === "pct" || unit === "bps") return " %";
  if (unit === "s") return " s";
  if (unit === "slots") return " slots";
  if (unit === "count") return "";
  if (unit === "usd") return "";
  return " ms";
}

/** Just the formatted number (no unit). used by BigNumber where the unit
 * is rendered separately for typography. */
export function fmtValue(value: number, unit: string): string {
  // Keep K/M/B suffixes and $ prefix — they are part of the number, not a
  // unit. Only strip trailing unit words that the caller renders separately.
  return fmtUnit(value, unit).replace(/\s+(ms|s|min|slots?)$/, "").replace(/\s*%$/, "");
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
  return value.toLocaleString();
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
