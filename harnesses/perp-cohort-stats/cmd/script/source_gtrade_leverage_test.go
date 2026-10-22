package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"
)

// Nova is read through the Gains leverage path with a different diamond, and
// gtradePairs hardcodes the pair INDICES. That works only because Nova serves
// the identical gTrade registry, which is the one thing a fork could change
// without changing anything else. Reading the wrong index would publish a
// different asset's terms under Nova's name, silently and plausibly: pair 7
// would still answer with a real leverage and a real threshold.
//
// So the indices are checked against each deployment's own registry rather
// than trusted.

func TestGtradeVenuesAreDistinctDeployments(t *testing.T) {
	if len(gtradeVenues) < 2 {
		t.Fatal("expected at least Gains and Nova")
	}
	seenVenue := map[string]bool{}
	seenDiamond := map[string]bool{}
	for _, g := range gtradeVenues {
		if seenVenue[g.venue] {
			t.Errorf("venue %q listed twice; its gauges would be written twice", g.venue)
		}
		if seenDiamond[g.diamond] {
			t.Errorf("diamond %s listed twice; two venues would publish one book's terms", g.diamond)
		}
		seenVenue[g.venue] = true
		seenDiamond[g.diamond] = true
	}
	if !seenVenue["gains"] || !seenVenue["nova"] {
		t.Errorf("want gains and nova, got %v", seenVenue)
	}
}

func TestGtradePairIndicesCoverTheBenchMarkets(t *testing.T) {
	// A market in gtradePairs that the bench does not list would publish a row
	// no tab can show; a bench market missing from gtradePairs drops the venue
	// from that tab without any error.
	for market := range gtradePairs {
		if !leverageTermsMarkets[market] {
			t.Errorf("gtradePairs has %q, which is not a bench market", market)
		}
	}
	for market := range leverageTermsMarkets {
		idxs, ok := gtradePairs[market]
		if !ok || len(idxs) == 0 {
			t.Errorf("bench market %q has no gTrade pair indices", market)
		}
	}
}

// expectedGtradeSymbols is what each index in gtradePairs must be. The standard
// pair carries the bare symbol and the degen pair the DEGEN suffix, which is
// how the two products are told apart in the registry.
var expectedGtradeSymbols = map[int64]string{
	0:   "BTC",
	1:   "ETH",
	300: "BTCDEGEN",
	313: "ETHDEGEN",
}

type gtradeTVPairs struct {
	Pairs []struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"pairs"`
}

// TestGtradeLeveragePairIndices checks, against each deployment's live
// registry, that the hardcoded indices still name the assets they are supposed
// to. Off by default so the suite stays hermetic; this is the failure a
// fixture cannot see, because the fixture would be the stale thing.
func TestGtradeLeveragePairIndices(t *testing.T) {
	if os.Getenv("OCB_LIVE") == "" {
		t.Skip("set OCB_LIVE=1 to read the Gains and Nova registries")
	}
	hosts := map[string]string{
		"gains": "https://backend-arbitrum.gains.trade/trading-variables",
		"nova":  "https://backend-arbitrum.nova.markets/trading-variables",
	}
	client := &http.Client{Timeout: 30 * time.Second}
	for venue, url := range hosts {
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			t.Fatalf("%s: %v", venue, err)
		}
		req.Header.Set("User-Agent", leverageTermsUA)
		resp, err := client.Do(req)
		if err != nil {
			t.Errorf("%s: %v", venue, err)
			continue
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Errorf("%s: %v", venue, err)
			continue
		}
		var tv gtradeTVPairs
		if err := json.Unmarshal(body, &tv); err != nil {
			t.Errorf("%s: %v", venue, err)
			continue
		}
		for idx, want := range expectedGtradeSymbols {
			if int(idx) >= len(tv.Pairs) {
				t.Errorf("%s: pair %d is beyond its %d-pair registry", venue, idx, len(tv.Pairs))
				continue
			}
			got := tv.Pairs[idx].From
			if got != want {
				t.Errorf("%s: pair %d is %s/%s, want %s. gtradePairs would publish the wrong asset's terms",
					venue, idx, got, tv.Pairs[idx].To, want)
			}
		}
		t.Logf("%s: %d pairs, indices verified", venue, len(tv.Pairs))
	}
}

// TestGtradeLeverageTermsLive reads both diamonds and prints the terms side by
// side. The assertion is that the two deployments are the same product with
// different pricing, which is the claim the bench row and the perp-cost rows
// both rest on: same leverage, same liquidation threshold, different fee.
func TestGtradeLeverageTermsLive(t *testing.T) {
	if os.Getenv("OCB_LIVE") == "" {
		t.Skip("set OCB_LIVE=1 to eth_call the Gains and Nova diamonds")
	}
	s := NewLeverageTermsSource()
	byKey := map[string]venueTerms{}
	for _, g := range gtradeVenues {
		ts := s.fetchGtrade(g.venue, g.diamond)
		if len(ts) == 0 {
			t.Errorf("%s returned nothing; its diamond or selectors may have moved", g.venue)
			continue
		}
		for _, v := range ts {
			key := fmt.Sprintf("%s/%s/%s", g.venue, v.market, strconv.FormatFloat(v.maxLev, 'f', 0, 64))
			byKey[key] = v
			// costPerLeg is already a percentage of notional: fees() word 0
			// at 1e10 gives 0.035 for 0.035%, not for 3.5%. Printing it
			// times 100 under a % sign is the unit slip this codebase
			// documents in gtradePairFee, so it is printed as bps.
			t.Logf("%-6s %-4s min=%7.2f max=%7.2f fee/leg=%.4f%% (%.2f bps)",
				g.venue, v.market, v.minLev, v.maxLev, v.costPerLeg, v.costPerLeg*100)
		}
	}
	// The two deployments must agree on leverage and disagree on fee at the
	// standard pair. If they ever agree on everything, the fork has been
	// repriced and the perp-cost rows need re-reading.
	for _, market := range []string{"BTC", "ETH"} {
		g, gok := byKey["gains/"+market+"/200"]
		n, nok := byKey["nova/"+market+"/200"]
		if !gok || !nok {
			t.Errorf("%s: missing a 200x standard row (gains=%v nova=%v)", market, gok, nok)
			continue
		}
		if g.maxLev != n.maxLev || g.minLev != n.minLev {
			t.Errorf("%s: leverage bounds diverged, gains %v-%v vs nova %v-%v",
				market, g.minLev, g.maxLev, n.minLev, n.maxLev)
		}
		if n.costPerLeg <= g.costPerLeg {
			t.Errorf("%s: nova fee %.4f%% is no longer above gains %.4f%%; the perp-cost rows say it is",
				market, n.costPerLeg*100, g.costPerLeg*100)
		}
	}
}
