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

export function fmtCount(n: number | undefined): string {
  if (n == null || n < 0) return "-";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Full-number variants used by the live ticker so every digit is visible
 *  and the value can visibly tick up between relay snapshots. */
export function fmtMoneyFull(n: number | undefined): string {
  if (n == null || n <= 0) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtCountFull(n: number | undefined): string {
  if (n == null || n < 0) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtLag(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
