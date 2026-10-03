/**
 * Shape of the trader-leaderboard audit snapshot written by the
 * `hl-archive traders` collector (harnesses/hl-archive/script/traders_run.go).
 *
 * Field names mirror the Go struct tags exactly. The harness writes raw
 * JSON under its own Upstash key rather than the `{ data, asOf }`
 * envelope the cohort layer uses, because the payload already carries
 * its own `updated_at`.
 */

/** Aggregates over every row of Hyperliquid's published leaderboard. */
export type HlTradersIntegrity = {
  accounts: number;
  winners: number;
  winners_pct: number;
  agg_pnl_usd: number;
  agg_equity_usd: number;
  agg_vlm_usd: number;
  /** Accounts publishing a non-zero PnL against exactly zero volume. */
  zero_vlm_accounts: number;
  zero_vlm_pnl_usd: number;
  /** Can exceed 100: the losers net the denominator down. */
  zero_vlm_pnl_pct: number;
  top100_pnl_pct: number;
  roi_outliers: number;
  losers_pnl_usd: number;
  /**
   * Rows whose lifetime window was absent or unreadable. Expected zero.
   * Non-zero means the published blob's shape moved, and every other
   * figure here needs re-reading before it is quoted.
   */
  malformed_rows: number;
};

/**
 * Perp vs non-perp split from the info API, over the highest-PnL
 * accounts only. `sampled` travels with the percentage because the
 * sample is biased by construction toward the zero-volume cohort, so the
 * figure describes the top of the table and never the population.
 */
export type HlTradersDecomposition = {
  sampled: number;
  failed: number;
  pnl_usd: number;
  perp_pnl_usd: number;
  non_perp_pnl_usd: number;
  non_perp_pnl_pct: number;
  accounts_with_non_perp_pnl: number;
};

export type HlTraderRow = {
  address: string;
  equity_usd: number;
  pnl_usd: number;
  roi: number;
  vlm_usd: number;
  pnl_day_usd: number;
  /** Claims PnL on zero volume. Marked in place, never dropped. */
  no_volume: boolean;
};

export type HlTradersSnapshot = {
  updated_at: string;
  source: string;
  integrity: HlTradersIntegrity;
  decomposition: HlTradersDecomposition;
  /** Ordered by all-time PnL, capped at `row_cap`. */
  top: HlTraderRow[];
  row_cap: number;
};
