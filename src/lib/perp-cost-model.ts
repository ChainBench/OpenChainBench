/**
 * What a leveraged perp trade costs, per venue, on one trade.
 *
 * Nine of the ten products here charge a share of NOTIONAL, twice, whether the
 * trade wins or loses. Papertrade charges a share of the GAIN, once, and
 * nothing when there is no gain. No single fee rate can express both, which is
 * why this is a model and not a column: the ranking depends on how far the
 * price travels, and the page exists to show where it flips.
 *
 * Every parameter below carries its provenance in `src`, because they are not
 * equally solid: `api` was read from the venue's own endpoint, `chain` from its
 * contracts, `docs` derived from a documented rule rather than a published
 * field. Two venues were left out rather than guessed at, see NOT_SHOWN.
 *
 * Fees and spreads were read on MEASURED_AT. They are static here: making them
 * live needs a harness, and a stale number with a date beats a fresh number
 * with no method.
 */

export type Market = "BTC" | "ETH";
export type Provenance = "api" | "chain" | "docs";

/** The day every fee, spread and maintenance figure below was read. */
export const MEASURED_AT = "2026-10-13";

export const MARGIN_RANGE = { min: 1, max: 1_000_000_000, default: 1000 } as const;
export const LEVERAGE_RANGE = { min: 1, max: 1000, default: 500 } as const;
/** The price-move slider, in thousandths of a percent: 0.001% to 2%. */
export const MOVE_RANGE = { min: 1, max: 2000, default: 200 } as const;

const BPS = 1e-4;

// ── Papertrade ────────────────────────────────────────────────────────────
// Its haircut is its own published formula. The reference notional is a
// constant and not the position size, by design, so the share it takes does
// not vary with how much is traded. The bust buffer is read from
// /state/trading and is an offset BEFORE the zero-equity price, so the room is
// 1/leverage minus the buffer and not the buffer itself.
export const PAPERTRADE = {
  baseRate: 0.1,
  rateMultiplier: 15_000,
  referenceNotional: 1e5,
  deadband: 0.2 * BPS,
  winFee: 0.02,
  perMarket: {
    BTC: { positionMultiplier: 814.598, bustBuffer: 476_041_580_087_574 / 1e18 },
    ETH: { positionMultiplier: 483.979, bustBuffer: 481_304_050_180_130 / 1e18 },
  },
} as const;

/**
 * The fraction of a winning move Papertrade hands back, after its haircut and
 * its 2% win fee. Zero at or below the deadband, and it approaches
 * (1 - baseRate) * (1 - winFee) from below as the move grows.
 */
export function papertradeKeep(market: Market, move: number): number {
  const m = move - PAPERTRADE.deadband;
  if (!(m > 0)) return 0;
  const { positionMultiplier } = PAPERTRADE.perMarket[market];
  const scale =
    (1 - PAPERTRADE.baseRate) /
    (1 +
      1 / (m * PAPERTRADE.rateMultiplier) +
      PAPERTRADE.referenceNotional / (1e6 * m * positionMultiplier));
  return scale * (1 - PAPERTRADE.winFee);
}

// ── Gains ─────────────────────────────────────────────────────────────────
// getPairLiquidationParams on the Arbitrum diamond gives the threshold as a
// share of collateral: 90% at or below 25x, 75% at or above 60x, interpolated
// linearly between. The x500 degen pairs read 80% flat.
const GAINS_STANDARD_THRESHOLD = {
  startThresholdPct: 90,
  endThresholdPct: 75,
  startLeverage: 25,
  endLeverage: 60,
} as const;

export function gainsStandardThresholdPct(leverage: number): number {
  const { startThresholdPct, endThresholdPct, startLeverage, endLeverage } =
    GAINS_STANDARD_THRESHOLD;
  if (leverage <= startLeverage) return startThresholdPct;
  if (leverage >= endLeverage) return endThresholdPct;
  return (
    startThresholdPct -
    ((leverage - startLeverage) * (startThresholdPct - endThresholdPct)) /
      (endLeverage - startLeverage)
  );
}

export type Venue = {
  id: string;
  name: string;
  /**
   * What distinguishes this product from the venue's other one, empty when the
   * venue has only this product. The chain and execution tags carry the rest,
   * so this never repeats them.
   */
  sub: string;
  /**
   * Logo manifest key, and the provider-registry key the official link comes
   * from. Both read the same slug, so a venue cannot show one brand's mark
   * beside another brand's site.
   */
  logoKey: string;
  /** Where the figures in this row were read, not every chain it serves. */
  chain: string;
  /** How a fill happens, which is why some rows carry no spread at all. */
  execution: "Order book" | "Oracle pool" | "House LP";
  /** What the fee is charged on. */
  charges: "notional" | "gain";
  src: Provenance;
  /** Taker fee, in bps of notional, per leg. */
  takerBps: number;
  /**
   * The FULL quoted book spread in bps, halved per leg below because a taker
   * crosses half the book. Gains' 0.0100% on-chain pair spread therefore
   * enters as 1.0 and not as 0.5.
   */
  spreadBps: Record<Market, number>;
  minLeverage: number;
  maxLeverage: Record<Market, number>;
  /**
   * True when the cap is not published but implied by the margin requirement
   * eating the whole margin, so it is a limit the venue approaches rather than
   * one it offers: the boundary itself cannot be opened.
   */
  impliedCap?: boolean;
  /** Maintenance requirement as a share of notional. */
  maintenance: (leverage: number, maxLeverage: number, market: Market) => number;
  /** True when the fee is charged inside the liquidation trigger. */
  feeInTrigger: boolean;
  /** True when the trigger is documented to leave equity behind. */
  returnsEquity: boolean;
  /**
   * Set when losing on this venue mints the venue's own token to the loser.
   *
   * It is kept apart from returnsEquity because it is not equity: no margin
   * comes back, and at launch the token cannot even be transferred, only
   * staked. But "nothing comes back" is still the wrong sentence for a venue
   * that hands the liquidated trader a claim on its revenue, so the row says
   * both things rather than one.
   */
  mintsOnLoss?: string;
};

export const VENUES: readonly Venue[] = [
  {
    id: "gains-std",
    logoKey: "gains",
    chain: "Arbitrum",
    execution: "Oracle pool",
    name: "Gains",
    sub: "standard pair",
    charges: "notional",
    src: "chain",
    takerBps: 3.5,
    spreadBps: { BTC: 1.0, ETH: 1.0 },
    minLeverage: 1.1,
    maxLeverage: { BTC: 200, ETH: 200 },
    maintenance: (lev) => (100 - gainsStandardThresholdPct(lev)) / 100 / lev,
    feeInTrigger: true,
    returnsEquity: false,
  },
  {
    // pairMinLeverage and pairMaxLeverage both read 500x, so this is a fixed
    // leverage product and not a 500x ceiling.
    id: "gains-degen",
    logoKey: "gains",
    chain: "Arbitrum",
    execution: "Oracle pool",
    name: "Gains",
    sub: "x500 degen, fixed",
    charges: "notional",
    src: "chain",
    takerBps: 2.0,
    spreadBps: { BTC: 0, ETH: 0 },
    minLeverage: 500,
    maxLeverage: { BTC: 500, ETH: 500 },
    maintenance: (lev) => 20 / 100 / lev,
    feeInTrigger: true,
    returnsEquity: false,
  },
  {
    id: "papertrade",
    logoKey: "papertrade",
    chain: "HyperEVM",
    execution: "House LP",
    name: "Papertrade",
    sub: "charges on the gain",
    charges: "gain",
    src: "api",
    takerBps: 0,
    spreadBps: { BTC: 0, ETH: 0 },
    minLeverage: 1,
    maxLeverage: { BTC: 1000, ETH: 1000 },
    maintenance: (_lev, _mx, market) => PAPERTRADE.perMarket[market].bustBuffer,
    feeInTrigger: false,
    returnsEquity: false,
    // Losing is the only thing that mints PAPER: its docs are explicit that
    // "PAPER mints to your account whenever you close a trade at a loss or get
    // liquidated. Nothing else mints PAPER." Below $2M of tracked LP the rate
    // is a flat 100 PAPER per dollar of loss basis, and it decays above that;
    // tracked LP read $65.1M on 2026-10-19, so the flat rate does not apply
    // and the published curve does not give the decay. The figure quoted is
    // measured instead, from the venue's own daily series: paperSupply over
    // traderPnl gave 54 to 99 PAPER a dollar across the six days to
    // 2026-10-19. It is a range and not a rate because it is an observation.
    mintsOnLoss: "mints PAPER, 54-99 per $1 lost",
  },
  {
    id: "lighter",
    logoKey: "lighter",
    chain: "zkSync rollup",
    execution: "Order book",
    name: "Lighter",
    sub: "",
    charges: "notional",
    src: "api",
    takerBps: 0,
    spreadBps: { BTC: 0.3197, ETH: 0.3186 },
    minLeverage: 1,
    maxLeverage: { BTC: 50, ETH: 50 },
    maintenance: () => 0.012,
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    // Paradex publishes two taker tiers on the same market, and this row takes
    // the cheaper one on purpose. /v1/markets fee_config reads
    // interactive_fee.taker 0 and both api_fee.taker and rpi_fee.taker 0.0002,
    // so a person clicking in the interface pays nothing to cross and a
    // programmatic order pays 2 bps a leg. A page that prices one leveraged
    // trade for a reader is pricing the interactive path, so that is the one
    // shown. It is stated in the footer because an undeclared choice between
    // two published numbers is the kind of thing that quietly decides a
    // ranking: at 2 bps a leg Paradex costs 4 bps round trip instead of the
    // 1.49 its spread alone gives it.
    id: "paradex",
    logoKey: "paradex",
    chain: "Starknet",
    execution: "Order book",
    name: "Paradex",
    sub: "",
    charges: "notional",
    src: "api",
    takerBps: 0,
    spreadBps: { BTC: 1.4947, ETH: 1.4335 },
    minLeverage: 1,
    maxLeverage: { BTC: 50, ETH: 50 },
    maintenance: () => 0.01,
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    id: "extended",
    logoKey: "extended",
    chain: "Starknet",
    execution: "Order book",
    name: "Extended",
    sub: "",
    charges: "notional",
    src: "docs",
    takerBps: 2.5,
    spreadBps: { BTC: 0.0604, ETH: 0.1994 },
    minLeverage: 1,
    maxLeverage: { BTC: 50, ETH: 50 },
    maintenance: () => 0.01,
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    id: "edgex",
    logoKey: "edgex",
    chain: "StarkEx",
    execution: "Order book",
    name: "edgeX",
    sub: "",
    charges: "notional",
    src: "api",
    takerBps: 4.5,
    spreadBps: { BTC: 0.0181, ETH: 0.2479 },
    minLeverage: 1,
    maxLeverage: { BTC: 100, ETH: 100 },
    maintenance: () => 0.005,
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    id: "hyperliquid",
    logoKey: "hyperliquid",
    chain: "Hyperliquid L1",
    execution: "Order book",
    name: "Hyperliquid",
    sub: "",
    charges: "notional",
    src: "docs",
    takerBps: 4.5,
    spreadBps: { BTC: 0.0603, ETH: 0.1991 },
    minLeverage: 1,
    maxLeverage: { BTC: 40, ETH: 25 },
    maintenance: (_lev, mx) => 1 / (2 * mx),
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    id: "dydx",
    logoKey: "dydx",
    chain: "dYdX Chain",
    execution: "Order book",
    name: "dYdX v4",
    sub: "",
    charges: "notional",
    src: "api",
    takerBps: 5,
    spreadBps: { BTC: 8.4248, ETH: 1.7929 },
    minLeverage: 1,
    maxLeverage: { BTC: 50, ETH: 50 },
    maintenance: () => 0.012,
    feeInTrigger: false,
    returnsEquity: true,
  },
  {
    // GMX publishes no leverage cap. Its 200x is 1 / 0.005, the leverage at
    // which the margin requirement equals the whole margin, so a position AT
    // 200x has no room at all and only something strictly below can be opened.
    id: "gmx",
    logoKey: "gmx",
    chain: "Arbitrum",
    execution: "Oracle pool",
    name: "GMX v2",
    sub: "implied cap",
    charges: "notional",
    src: "chain",
    takerBps: 6,
    spreadBps: { BTC: 0, ETH: 0 },
    minLeverage: 1,
    maxLeverage: { BTC: 200, ETH: 200 },
    impliedCap: true,
    maintenance: () => 0.005,
    feeInTrigger: false,
    returnsEquity: true,
  },
];

/** Venues deliberately absent, and why. A missing row beats a wrong one. */
export const NOT_SHOWN = [
  {
    name: "Aster",
    reason:
      "its leverage-bracket endpoint needs a key, and the only public margin fields contradict the product it advertises",
  },
  {
    name: "Ostium",
    reason:
      "its subgraph publishes two threshold fields and only one matches its documented formula, an unresolved conflict",
  },
] as const;

/** "Gains x500 degen, fixed" or just "Lighter", for prose and for labels. */
export function venueLabel(venue: Venue): string {
  return venue.sub ? `${venue.name} ${venue.sub}` : venue.name;
}

/** Taker fee plus half the quoted spread, as a fraction of notional, per leg. */
export function feeLegFraction(venue: Venue, market: Market): number {
  return (venue.takerBps + venue.spreadBps[market] / 2) * BPS;
}

export function maxLeverageOn(venue: Venue, market: Market): number {
  return venue.maxLeverage[market];
}

export function isOpenAt(venue: Venue, market: Market, leverage: number): boolean {
  const mx = maxLeverageOn(venue, market);
  if (leverage < venue.minLeverage) return false;
  return venue.impliedCap ? leverage < mx : leverage <= mx;
}

export type CostRow = {
  venue: Venue;
  open: boolean;
  maxLeverage: number;
  /** What the venue takes, in dollars, on this trade. */
  cost: number;
  /** What is left of the gain after it. */
  net: number;
  /** Cost over raw gain. Above 1 the fees exceed the gain. */
  shareOfGain: number;
  /**
   * Distance from entry to the liquidation trigger, in percent of price, or
   * null when the position has no room at all at this leverage.
   */
  roomPct: number | null;
  /** Share of margin the trigger leaves behind, before the closing fee. */
  equityLeftPct: number;
  /** What a flat close costs, in dollars. */
  flatCost: number;
};

export type CostModel = {
  margin: number;
  leverage: number;
  market: Market;
  move: number;
  notional: number;
  rawGain: number;
  /** Open at this leverage, cheapest first. */
  live: CostRow[];
  /** Not open at this leverage, in declaration order. */
  unavailable: CostRow[];
  cheapest: CostRow | null;
  dearest: CostRow | null;
  /** False when even the cheapest venue takes more than the whole gain. */
  anyProfitable: boolean;
  /** The cheapest open venue charging on notional, if any. */
  rival: CostRow | null;
  /**
   * The price move at which Papertrade's haircut equals that rival's round
   * trip, or null when the comparison does not apply. Below it Papertrade
   * takes less, above it the rival does.
   */
  crossoverMove: number | null;
};

/**
 * Where Papertrade's haircut equals a notional-fee round trip.
 *
 * Both sides are proportional to notional, so it cancels: the crossover
 * depends only on the price move, never on the margin or the leverage. Solving
 * `move * (1 - keep(move)) = 2 * feeLeg` by bisection, since keep() is
 * monotone in move (asserted in the tests) and so the left side is too.
 */
export function crossoverMove(market: Market, rivalFeeLeg: number): number {
  let lo = 1e-7;
  let hi = 1;
  for (let i = 0; i < 120; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid * (1 - papertradeKeep(market, mid)) < 2 * rivalFeeLeg) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function computeCostModel({
  margin,
  leverage,
  market,
  move,
}: {
  margin: number;
  leverage: number;
  market: Market;
  /** Price move in your favour, as a fraction. 0.002 is 0.2% of price. */
  move: number;
}): CostModel {
  const notional = margin * leverage;
  const rawGain = move * notional;

  const rows: CostRow[] = VENUES.map((venue) => {
    const mx = maxLeverageOn(venue, market);
    const open = isOpenAt(venue, market, leverage);
    const legFee = feeLegFraction(venue, market);
    const roundTrip = 2 * legFee * notional;
    const cost =
      venue.charges === "gain" ? rawGain * (1 - papertradeKeep(market, move)) : roundTrip;

    let roomPct: number | null = null;
    let equityLeftPct = 0;
    if (open) {
      const mm = venue.maintenance(leverage, mx, market);
      const room = (1 / leverage - mm - (venue.feeInTrigger ? 2 * legFee : 0)) * 100;
      roomPct = room > 0 ? room : null;
      if (venue.returnsEquity && roomPct !== null) {
        equityLeftPct = Math.max(0, Math.min(1, 1 - (roomPct / 100) * leverage));
      }
    }

    return {
      venue,
      open,
      maxLeverage: mx,
      cost,
      net: rawGain - cost,
      shareOfGain: rawGain > 0 ? cost / rawGain : 0,
      roomPct,
      equityLeftPct,
      flatCost: venue.charges === "gain" ? 0 : roundTrip,
    };
  });

  const live = rows.filter((r) => r.open).sort((a, b) => b.net - a.net);
  const unavailable = rows.filter((r) => !r.open);
  const cheapest = live[0] ?? null;
  const dearest = live.length > 1 ? live[live.length - 1] : null;
  const papertrade = rows.find((r) => r.venue.id === "papertrade") ?? null;
  const rival = live.find((r) => r.venue.charges === "notional") ?? null;

  return {
    margin,
    leverage,
    market,
    move,
    notional,
    rawGain,
    live,
    unavailable,
    cheapest,
    dearest,
    anyProfitable: cheapest !== null && cheapest.net > 0,
    rival,
    crossoverMove:
      papertrade?.open && rival ? crossoverMove(market, feeLegFraction(rival.venue, market)) : null,
  };
}

/**
 * Why a venue is absent, phrased from the bound actually crossed. Reading the
 * minimum first said "fixed at 1.1x" for a venue that was in fact capped.
 */
export function unavailableReason(row: CostRow, leverage: number): string {
  const { minLeverage, impliedCap } = row.venue;
  const mx = row.maxLeverage;
  if (leverage < minLeverage) {
    return minLeverage === mx ? `fixed at ${minLeverage}x` : `starts at ${minLeverage}x`;
  }
  return impliedCap
    ? `no published cap; the margin requirement bites below ${mx}x`
    : `caps at ${mx}x`;
}
