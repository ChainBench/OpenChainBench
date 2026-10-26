package main

import (
	"fmt"
	"strconv"
	"time"
)

// Maya Protocol. Keyless, and the only rail measured on 2026-10-25 that
// carries two privacy assets: ZEC.ZEC and DASH.DASH, both Available.
//
// Its ZEC pool was 47.8 % of all Maya volume that day, essentially tied
// with BTC at 48.1 %, so this is not a corner of the venue, it is half of
// it.

type mayaQuote struct {
	ExpectedAmountOut string `json:"expected_amount_out"`
	TotalSwapSeconds  int    `json:"total_swap_seconds"`
	OutboundDelay     int    `json:"outbound_delay_seconds"`
	InboundAddress    string `json:"inbound_address"`
	Error             string `json:"error"`
	Fees              struct {
		Asset     string `json:"asset"`
		Outbound  string `json:"outbound"`
		Liquidity string `json:"liquidity"`
		Total     string `json:"total"`
	} `json:"fees"`
}

func (m *mayaQuote) out() (int64, error) {
	if m.Error != "" {
		return 0, fmt.Errorf("%s", m.Error)
	}
	if m.ExpectedAmountOut == "" {
		return 0, fmt.Errorf("no expected_amount_out")
	}
	return strconv.ParseInt(m.ExpectedAmountOut, 10, 64)
}

func mayaQuoteSwap(cfg *Config, from, to string, amount int64, dest string) (*mayaQuote, int, error) {
	url := fmt.Sprintf("%s/mayachain/quote/swap?from_asset=%s&to_asset=%s&amount=%d",
		cfg.MayaBase, from, to, amount)
	if dest != "" {
		url += "&destination=" + dest
	}
	var q mayaQuote
	code, err := getJSON(url, &q)
	return &q, code, err
}

// probeMayaRoundTrip measures the thing a user actually experiences: in and
// back out. Two chained quotes, the second one sized by the first one's
// output, so the number is a round trip and not two unrelated legs.
//
// Both legs must succeed or nothing is published. A half-measured round trip
// is worse than a gap, because it looks like a cheap one.
func probeMayaRoundTrip(cfg *Config, asset string) {
	var costs, secs []float64
	for _, r := range tiers {
		lbl := []string{"maya", asset, r.Bucket, cfg.MonitorRegion}

		in, _, err := mayaQuoteSwap(cfg, "BTC.BTC", asset, r.SatIn, "")
		if err != nil {
			probeTotal.WithLabelValues("maya", "round_trip", "transport_error").Inc()
			continue
		}
		mid, err := in.out()
		if err != nil {
			probeTotal.WithLabelValues("maya", "round_trip", "leg1_refused").Inc()
			continue
		}

		back, _, err := mayaQuoteSwap(cfg, asset, "BTC.BTC", mid, "")
		if err != nil {
			probeTotal.WithLabelValues("maya", "round_trip", "transport_error").Inc()
			continue
		}
		outSat, err := back.out()
		if err != nil {
			probeTotal.WithLabelValues("maya", "round_trip", "leg2_refused").Inc()
			continue
		}

		lost := float64(r.SatIn-outSat) / float64(r.SatIn) * 10000
		if lost < 0 {
			// A negative round trip means the two pool prices disagree in the
			// user's favour. It is a real reading, not an error, but it is not
			// a cost, so it is counted and not published as one.
			probeTotal.WithLabelValues("maya", "round_trip", "negative_cost").Inc()
			continue
		}
		roundTripBps.WithLabelValues(lbl...).Set(lost)
		eta := float64(in.TotalSwapSeconds + back.TotalSwapSeconds)
		roundTripSec.WithLabelValues(lbl...).Set(eta)
		costs = append(costs, lost)
		secs = append(secs, eta)
		probeTotal.WithLabelValues("maya", "round_trip", "ok").Inc()
		lastSuccess.WithLabelValues("maya", "round_trip").Set(float64(time.Now().Unix()))
	}
	publishPooled("maya", asset, cfg.MonitorRegion, costs, secs)
}

// probeMayaExitCost asks the narrower question: what does it cost to get OUT,
// at three sizes. Entering is optional, leaving is not, and on a thin pool
// the exit is where the cost lives.
//
// The reference is the SMALLEST rung's own rate, not a sub-divided quote.
// The first version divided each size by 1000 to get a mid, which falls
// below Maya's recommended minimum on the small rungs: 4 of 6 probes came
// back refused and the two that answered produced 2062 bps, a number with
// no meaning. Measuring against the smallest rung costs no extra call and
// the reference is always a size the rail actually quotes.
func probeMayaExitCost(cfg *Config, asset string) {
	type leg struct {
		label string
		in    int64
		out   int64
	}
	var legs []leg
	for _, r := range tiers {
		q, _, err := mayaQuoteSwap(cfg, asset, "BTC.BTC", r.ZatIn, "")
		if err != nil {
			probeTotal.WithLabelValues("maya", "exit_cost", "transport_error").Inc()
			continue
		}
		outSat, err := q.out()
		if err != nil {
			probeTotal.WithLabelValues("maya", "exit_cost", "refused").Inc()
			continue
		}
		legs = append(legs, leg{r.Bucket, r.ZatIn, outSat})
	}
	if len(legs) < 2 {
		// One size alone has nothing to be compared against, and publishing
		// a 0 would read as a frictionless exit.
		probeTotal.WithLabelValues("maya", "exit_cost", "too_few_sizes").Inc()
		return
	}

	base := legs[0] // the smallest rung that answered
	baseRate := float64(base.out) / float64(base.in)
	if baseRate <= 0 {
		probeTotal.WithLabelValues("maya", "exit_cost", "bad_reference").Inc()
		return
	}
	// The reference rung is NOT published. Measured against itself it is 0 by
	// construction, and a row reading 0 bps would be read as a frictionless
	// exit rather than as the baseline the other sizes are measured from.
	var impacts []float64
	for _, l := range legs[1:] {
		expected := baseRate * float64(l.in)
		impact := (expected - float64(l.out)) / expected * 10000
		if impact < 0 {
			impact = 0
		}
		exitCostBps.WithLabelValues("maya", asset, l.label, cfg.MonitorRegion).Set(impact)
		impacts = append(impacts, impact)
	}
	// The pooled series the default tab reads, for the same reason the round
	// trip needs one: an unpinned selector matches every tier at once and the
	// board cannot pick a value, while pinning a real tier would survive into
	// every filtered tab because injectLabels only replaces bucket="all".
	if len(impacts) >= 2 {
		exitCostBps.WithLabelValues("maya", asset, "all", cfg.MonitorRegion).Set(medianOf(impacts))
	}
	probeTotal.WithLabelValues("maya", "exit_cost", "ok").Inc()
	lastSuccess.WithLabelValues("maya", "exit_cost").Set(float64(time.Now().Unix()))
}

type midgardPool struct {
	Asset      string `json:"asset"`
	Volume24h  string `json:"volume24h"`
	AssetDepth string `json:"assetDepth"`
}

// probeMayaDepth publishes the liquidity behind the cost. A board that shows
// 325 bps without the depth that produced it invites the reader to blame the
// venue's pricing when the answer is the pool size.
func probeMayaDepth(cfg *Config, assets []string) {
	var pools []midgardPool
	if _, err := getJSON(cfg.MayaMidgard+"/v2/pools?period=24h", &pools); err != nil {
		probeTotal.WithLabelValues("maya", "depth", "transport_error").Inc()
		return
	}
	want := map[string]bool{}
	for _, a := range assets {
		want[a] = true
	}
	for _, p := range pools {
		if !want[p.Asset] {
			continue
		}
		if d, err := strconv.ParseFloat(p.AssetDepth, 64); err == nil {
			poolDepth.WithLabelValues("maya", p.Asset).Set(d / 1e8)
		}
	}
	probeTotal.WithLabelValues("maya", "depth", "ok").Inc()
	lastSuccess.WithLabelValues("maya", "depth").Set(float64(time.Now().Unix()))
}
