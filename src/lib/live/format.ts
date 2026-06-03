/**
 * Compact formatting helpers shared across the live dashboard. Kept here
 * so they're easy to find when adjusting precision rules.
 */

export function fmtMoney(n: number | undefined): string {
  if (n == null || n <= 0) return "-";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Full-number variants used by the live ticker so every digit is visible
 *  and the value can visibly tick up between relay snapshots. */
export function fmtMoneyFull(n: number | undefined): string {
  if (n == null || n <= 0) return "-";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtCountFull(n: number | undefined): string {
  if (n == null || n < 0) return "-";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtLag(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
