package main

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// Nova is a gTrade deployment, so it is read by the Gains source with
// different hosts rather than by a copy of it. These pin the two things that
// make that safe: the venue and source labels do not leak across the two
// configurations, and the open-interest read refuses to publish a figure it
// cannot convert.
//
// Why the OI read exists at all: Gains' open interest reaches the cohort
// through DefiLlama, Nova has no DefiLlama perp entry, and bench 271 divides
// volume by OI. Without this, Nova would carry a volume and nothing to
// divide it by.

func TestGtradeSourcesDoNotShareAVenueOrALabel(t *testing.T) {
	g, n := NewGainsNativeSource(), NewNovaNativeSource()

	if g.venue == n.venue {
		t.Fatalf("both sources publish under %q; gauges would overwrite each other", g.venue)
	}
	if g.Name() == n.Name() {
		t.Fatalf("both report source %q; a fork failing would read as Gains failing", g.Name())
	}
	if g.venue != "gains" || n.venue != "nova" {
		t.Errorf("venues are %q and %q, want gains and nova", g.venue, n.venue)
	}
	if g.Name() != srcGainsNative || n.Name() != srcNovaNative {
		t.Errorf("labels are %q and %q", g.Name(), n.Name())
	}
	// Pointing a fork at the parent's backend is the quiet way to publish
	// one venue's numbers twice under two names.
	if g.base == n.base || g.tvURL == n.tvURL {
		t.Errorf("the two sources share a host: base %q/%q, tv %q/%q",
			g.base, n.base, g.tvURL, n.tvURL)
	}
}

func TestOpenInterestSumsEveryCollateralAtItsOwnPrice(t *testing.T) {
	// Two collaterals, different decimals and different prices, so a read
	// that ignored either would come out wrong rather than merely off.
	raw := `{
	  "collaterals": [
	    {"symbol":"USDC","collateralConfig":{"decimals":6},
	     "prices":{"collateralPriceUsd":1.0},
	     "pairOis":[{"collateral":{"oiLongCollateral":"1000000","oiShortCollateral":"500000"}}]},
	    {"symbol":"WETH","collateralConfig":{"decimals":18},
	     "prices":{"collateralPriceUsd":2000.0},
	     "pairOis":[{"collateral":{"oiLongCollateral":"1000000000000000000","oiShortCollateral":"0"}}]}
	  ]
	}`
	var tv gainsTradingVariables
	if err := json.Unmarshal([]byte(raw), &tv); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := gainsOpenInterestUSD(tv)
	if !ok {
		t.Fatal("refused a payload it should accept")
	}
	// 1.0 + 0.5 USDC, plus 1 WETH at 2000.
	want := 1.5 + 2000.0
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestOpenInterestRefusesWhatItCannotConvert(t *testing.T) {
	// A missing price or missing decimals would scale the venue's OI to
	// nothing or to nonsense. Publishing that is worse than publishing none,
	// because a zero reads as "no positions" rather than "not read".
	for name, raw := range map[string]string{
		"no price": `{"collaterals":[{"symbol":"USDC","collateralConfig":{"decimals":6},
			"prices":{"collateralPriceUsd":0},
			"pairOis":[{"collateral":{"oiLongCollateral":"1000000","oiShortCollateral":"0"}}]}]}`,
		"no decimals": `{"collaterals":[{"symbol":"USDC","collateralConfig":{"decimals":0},
			"prices":{"collateralPriceUsd":1},
			"pairOis":[{"collateral":{"oiLongCollateral":"1000000","oiShortCollateral":"0"}}]}]}`,
		"no collaterals": `{"collaterals":[]}`,
	} {
		var tv gainsTradingVariables
		if err := json.Unmarshal([]byte(raw), &tv); err != nil {
			t.Fatalf("%s: unmarshal: %v", name, err)
		}
		if got, ok := gainsOpenInterestUSD(tv); ok {
			t.Errorf("%s: accepted and returned %v, want refusal", name, got)
		}
	}
}

func TestOpenInterestIsZeroNotRefusedWhenNothingIsOpen(t *testing.T) {
	// A venue with a live, priced collateral and no positions really does
	// have zero open interest. That must read as a measured zero, which
	// SetIfPositive then declines to publish, not as a failed read.
	raw := `{"collaterals":[{"symbol":"USDC","collateralConfig":{"decimals":6},
		"prices":{"collateralPriceUsd":1},
		"pairOis":[{"collateral":{"oiLongCollateral":"0","oiShortCollateral":"0"}}]}]}`
	var tv gainsTradingVariables
	if err := json.Unmarshal([]byte(raw), &tv); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := gainsOpenInterestUSD(tv)
	if !ok {
		t.Error("refused a readable payload that simply has no open positions")
	}
	if got != 0 {
		t.Errorf("got %v, want 0", got)
	}
}

// TestGtradeSourcesLive hits both deployments for real and asserts the figures,
// not just that the calls returned. Off by default so the suite stays hermetic;
// run it with OCB_LIVE=1 when a backend's shape may have moved, which is the
// one failure a fixture cannot see.
//
// It also prints what each venue publishes, which is what a bench spec's
// provider block has to be written against.
func TestGtradeSourcesLive(t *testing.T) {
	if os.Getenv("OCB_LIVE") == "" {
		t.Skip("set OCB_LIVE=1 to hit the Gains and Nova backends")
	}
	for _, s := range []*GainsNativeSource{NewGainsNativeSource(), NewNovaNativeSource()} {
		res, err := s.Fetch()
		if err != nil {
			t.Errorf("%s: %v", s.venue, err)
			continue
		}
		v := res.Values[s.venue]
		t.Logf("%s: volume_24h=%.0f oi=%.0f active_markets=%.0f breadth=%v",
			s.venue, v[mVolume24h], v[mOI], v[mActiveMarkets], res.Breadth[s.venue])
		// A gTrade deployment that answers at all answers all three. A zero
		// here is a shape change upstream, not a quiet venue.
		if v[mActiveMarkets] <= 0 {
			t.Errorf("%s published no active markets; trading-variables shape may have moved", s.venue)
		}
		if v[mVolume24h] <= 0 {
			t.Errorf("%s published no volume; volume-mix shape may have moved", s.venue)
		}
	}
}
