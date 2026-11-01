/**
 * Venues whose published volume is not the cohort's quantity.
 *
 * Its own module, with no imports, because both sides of the render need it:
 * the server builds the ItemList from it, and the client leaderboard filters
 * after hydration when the venue-type selector changes. Importing it from
 * perp-stats pulled that module's Prometheus client, and its node:dns SSRF
 * guard, into the browser bundle, and the /perps build failed outright.
 *
 * Papertrade: its own spec says "single house LP, BTC and ETH only" and "the
 * four side columns are summed because every position faces the house".
 * Notional turnover at up to 1000x leverage is not what the other rows
 * measure. On 2026-10-20 the hub published "Papertrade leads 28 tracked perp
 * DEXes on 30-day volume at $2623.64B"; on 2026-11-01 the table still ranked
 * it first at $1267.73B against Hyperliquid's $161.8B, on two markets, under
 * a headline naming Hyperliquid.
 *
 * Not a self-reporting flag: every venue here self-reports its volume. The
 * distinction is what the number counts, not where it comes from. Open
 * interest is NOT excluded: a snapshot of open positions is the same
 * measurement everywhere.
 */
export const NOTIONAL_NOT_COMPARABLE = new Set(["papertrade"]);
