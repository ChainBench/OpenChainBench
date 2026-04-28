export function fmtUnit(value: number, unit: string) {
  if (unit === "bps") {
    if (value >= 100) return `${(value / 100).toFixed(2)}%`;
    return `${value.toFixed(0)} bps`;
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

export function fmtCompact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
