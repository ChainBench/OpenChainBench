package main

import (
	"os"
	"sort"
	"strings"
	"testing"
)

// HYPE joined this harness on 2026-10-21, on the six venues that list it as a
// perp. The cohort is pinned here because the evidence for each membership is
// a live read nobody will repeat, and because two of the exclusions look like
// oversights until you know why they are not.
//
// Paradex matches "HYPE" on an option symbol, HYPE-USD-22OCT26-65-C with
// asset_kind OPTION, so a substring check would have put an options series in
// a perp cohort. Gains carries no HYPE pair at all: 470 pair indices were
// scanned on its Arbitrum diamond and none matched, so findGainsPair would
// fail on every tick and publish an error rather than a figure.
func venueAssets(t *testing.T) map[string][]string {
	t.Helper()
	cfg := loadConfig()
	out := map[string][]string{}
	for _, v := range cfg.Venues {
		out[v.Slug] = append(out[v.Slug], v.Asset)
	}
	for k := range out {
		sort.Strings(out[k])
	}
	return out
}

func TestHypeCohortIsTheVenuesThatListIt(t *testing.T) {
	assets := venueAssets(t)

	// Verified at each venue's own endpoint on 2026-10-21: Hyperliquid's meta
	// (HYPE, maxLeverage 10), dYdX's indexer (HYPE-USD), Lighter's orderBooks
	// (symbol HYPE, perp, active, market_id 24), Extended's info/markets
	// (HYPE-USD, maxLeverage 50), Aster's exchangeInfo (HYPEUSDT), and
	// edgeX's getMetaData (HYPEUSDC, enableTrade true).
	onHype := []string{
		"hyperliquid", "dydx", "lighter", "extended", "aster", "edgex",
		// Joined 2026-10-22 once the two-market choice was made on the
		// numbers: HYPE/USD [WBTC.b-USDC] has 117 times the open interest of
		// HYPE/USD [USDG-USDG] and the same collateral pair as the BTC market
		// gmxMarkets already reads.
		"gmx",
	}
	for _, slug := range onHype {
		got, ok := assets[slug]
		if !ok {
			t.Fatalf("%s is not in the config at all", slug)
		}
		if !hasAsset(got, "HYPE") {
			t.Errorf("%s should carry HYPE, has %v", slug, got)
		}
	}

	// Not on HYPE, each for a reason written next to the config.
	offHype := map[string]string{
		"paradex":    "its HYPE market is an option, not a perp",
		"gains":      "its diamond carries no HYPE pair in 470 indices",
		"polymarket": "unverified: its hosts failed TLS hostname validation",
		"ondo":       "unverified: substring match only, which is what Paradex also had",
	}
	for slug, why := range offHype {
		got, ok := assets[slug]
		if !ok {
			t.Fatalf("%s is not in the config at all", slug)
		}
		if hasAsset(got, "HYPE") {
			t.Errorf("%s must not carry HYPE: %s", slug, why)
		}
	}
}

func TestEveryVenueKeepsTheThreeOriginalAssets(t *testing.T) {
	// Adding a market must not quietly drop one. Every venue in this harness
	// has published ETH, BTC and SOL since it was built.
	for slug, got := range venueAssets(t) {
		for _, want := range []string{"ETH", "BTC", "SOL"} {
			if !hasAsset(got, want) {
				t.Errorf("%s lost %s, has %v", slug, want, got)
			}
		}
	}
}

func TestEdgexResolvesEveryAssetItDeclares(t *testing.T) {
	// edgeX is the one venue on HYPE that needs a map entry rather than a
	// symbol pattern, so a declared asset with no contract id would fail
	// every tick with "unknown asset" instead of publishing.
	for _, v := range loadConfig().Venues {
		if v.Slug != "edgex" {
			continue
		}
		if _, ok := edgexContractIDs[v.Asset]; !ok {
			t.Errorf("edgex declares %s but edgexContractIDs has no id for it", v.Asset)
		}
	}
	// And the reverse: an id for an asset nobody declares is dead config.
	declared := map[string]bool{}
	for _, v := range loadConfig().Venues {
		if v.Slug == "edgex" {
			declared[v.Asset] = true
		}
	}
	for asset := range edgexContractIDs {
		if !declared[asset] {
			t.Errorf("edgexContractIDs carries %s, which edgex does not declare", asset)
		}
	}
}

func TestConfigSaysWhyAVenueIsOffHype(t *testing.T) {
	// The asset lists differ between venues now, which reads as arbitrary
	// without the note. Pinned so a later edit does not delete the reasoning
	// and leave the list looking like a mistake.
	raw, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatalf("read config.go: %v", err)
	}
	src := string(raw)
	// Short fragments only: the note is a wrapped comment, so anything longer
	// than a few words straddles a line break and the check fails on
	// formatting rather than on meaning.
	for _, phrase := range []string{
		"asset_kind OPTION",
		"no HYPE pair",
		"TLS hostname",
		"substring",
	} {
		if !strings.Contains(src, phrase) {
			t.Errorf("config.go no longer explains %q", phrase)
		}
	}
}

// Named to avoid colliding with contains(string, string) in metrics.go.
func hasAsset(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
