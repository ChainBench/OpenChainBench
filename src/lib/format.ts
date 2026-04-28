export function fmtUnit(value: number, unit: string) {
  if (unit === "bps") {
    if (!Number.isFinite(value)) return "—";
    if (value >= 10) return `${Math.round(value)} bps`;
    if (value >= 1) return `${value.toFixed(1)} bps`;
    return `${value.toFixed(2)} bps`;
  }
  if (unit === "s") {
    const s = value / 1000;
    if (s >= 60) return `${(s / 60).toFixed(1)} min`;
    return `${s.toFixed(1)} s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(0)} ms`;
}

/** Just the unit suffix, with a leading space — used by BigNumber. */
export function unitSuffix(unit: string) {
  if (unit === "bps") return " bps";
  if (unit === "s") return " s";
  return " ms";
}

/** Just the formatted number (no unit) — used by BigNumber where the unit
 * is rendered separately for typography. */
export function fmtValue(value: number, unit: string): string {
  return fmtUnit(value, unit).replace(/\s+(ms|s|bps|min|%)$/, "");
}
