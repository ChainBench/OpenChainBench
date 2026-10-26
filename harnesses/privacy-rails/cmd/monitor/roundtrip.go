package main

import (
	"strconv"
	"time"
)

// The round trip, for every rail, on shared size tiers.
//
// The two rails do not start from the same asset: Maya's deep side is BTC and
// NEAR Intents quotes from USDC on Base. Forcing one source asset on both
// would mean quoting a pair one of them does not serve well, which measures
// our choice rather than the rail.
//
// So the tier is the shared axis and each rail sends its own natural asset at
// roughly that notional. The published figure is basis points of round-trip
// loss, which is unit-free and therefore comparable; the methodology says
// exactly what each rail was sent, because a tier label is an approximation
// and a reader is owed the actual amount.
//
// BTC rungs are fixed in BTC rather than re-derived from a price feed each
// tick: a rung that moves with the BTC price would make yesterday's board
// incomparable with today's, and this harness has no price oracle it trusts
// enough to anchor a size on.
type sizeTier struct {
	Bucket string // dimension value, shared across rails
	SatIn  int64  // Maya: BTC smallest unit
	ZatIn  int64  // Maya: ZEC smallest unit, for the exit-cost probe
	UsdcIn int64  // NEAR Intents: USDC, 6 decimals
}

var tiers = []sizeTier{
	{Bucket: "usd100", SatIn: 100_000, ZatIn: 100_000_000, UsdcIn: 100_000_000},
	{Bucket: "usd1k", SatIn: 1_000_000, ZatIn: 1_000_000_000, UsdcIn: 1_000_000_000},
	{Bucket: "usd10k", SatIn: 10_000_000, ZatIn: 10_000_000_000, UsdcIn: 10_000_000_000},
}

// probeNearRoundTrip chains USDC -> ZEC -> USDC on 1Click.
//
// Two things cost time to find and are worth keeping here. The quote answers
// 201 Created, not 200, which an earlier version read as a refusal. And
// `refundTo` must be an address on the ORIGIN chain: the return leg starts in
// ZEC, so it needs the Zcash address, and passing the EVM one fails with
// "refundTo is not valid" rather than anything about the direction.
func probeNearRoundTrip(cfg *Config) {
	for _, t := range tiers {
		lbl := []string{"near-intents", "ZEC.ZEC", t.Bucket, cfg.MonitorRegion}

		in, code, err := oneClickLeg(cfg, usdcBase, zecNear,
			strconv.FormatInt(t.UsdcIn, 10), cfg.ZecTransparent, evmRefund)
		if err != nil || !ok2xx(code) || in == nil {
			probeTotal.WithLabelValues("near-intents", "round_trip", "leg1_refused").Inc()
			continue
		}
		mid, perr := strconv.ParseInt(in.Quote.AmountOut, 10, 64)
		if perr != nil || mid <= 0 {
			probeTotal.WithLabelValues("near-intents", "round_trip", "leg1_unparsed").Inc()
			continue
		}

		back, code2, err2 := oneClickLeg(cfg, zecNear, usdcBase,
			strconv.FormatInt(mid, 10), evmRefund, cfg.ZecTransparent)
		if err2 != nil || !ok2xx(code2) || back == nil {
			probeTotal.WithLabelValues("near-intents", "round_trip", "leg2_refused").Inc()
			continue
		}
		out, perr := strconv.ParseInt(back.Quote.AmountOut, 10, 64)
		if perr != nil || out <= 0 {
			probeTotal.WithLabelValues("near-intents", "round_trip", "leg2_unparsed").Inc()
			continue
		}

		lost := float64(t.UsdcIn-out) / float64(t.UsdcIn) * 10000
		if lost < 0 {
			probeTotal.WithLabelValues("near-intents", "round_trip", "negative_cost").Inc()
			continue
		}
		roundTripBps.WithLabelValues(lbl...).Set(lost)
		roundTripSec.WithLabelValues(lbl...).Set(float64(in.Quote.TimeEstimate + back.Quote.TimeEstimate))
		probeTotal.WithLabelValues("near-intents", "round_trip", "ok").Inc()
		lastSuccess.WithLabelValues("near-intents", "round_trip").Set(float64(time.Now().Unix()))
	}
}

const evmRefund = "0x0000000000000000000000000000000000000001"
