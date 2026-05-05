export function fmtUnit(value: number, unit: string) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "pct") return formatPercent(value);
  if (unit === "bps") {
    // Legacy: bps stored. Convert to percent for display.
    return formatPercent(value / 100);
  }
  if (unit === "s") {
    const s = value / 1000;
    if (s >= 60) return `${(s / 60).toFixed(1)} min`;
    return `${s.toFixed(1)} s`;
  }
  if (unit === "count") return value.toLocaleString();
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(0)} ms`;
}

/** Just the unit suffix, with a leading space — used by BigNumber. */
export function unitSuffix(unit: string) {
  if (unit === "pct" || unit === "bps") return " %";
  if (unit === "s") return " s";
  if (unit === "count") return "";
  return " ms";
}

/** Just the formatted number (no unit) — used by BigNumber where the unit
 * is rendered separately for typography. */
export function fmtValue(value: number, unit: string): string {
  return fmtUnit(value, unit).replace(/\s*(ms|s|min|%)$/, "");
}

/** Smart-precision percent formatter — picks decimals based on magnitude
 * so both small fees (0.033%) and large fees (12.50%) read cleanly. */
function formatPercent(pct: number): string {
  const abs = Math.abs(pct);
  if (abs >= 10) return `${pct.toFixed(1)}%`;
  if (abs >= 1) return `${pct.toFixed(2)}%`;
  if (abs >= 0.1) return `${pct.toFixed(2)}%`;
  if (abs >= 0.01) return `${pct.toFixed(3)}%`;
  if (abs >= 0.001) return `${pct.toFixed(4)}%`;
  return `${pct.toFixed(5)}%`;
}
