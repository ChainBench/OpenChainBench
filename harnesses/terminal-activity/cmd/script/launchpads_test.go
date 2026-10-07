package main

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func resetPads() {
	for _, g := range launchpadGauges() {
		g.Reset()
	}
	launchpadHealth.Reset()
}

// Launchpad volume totals across chains, unlike wallets. A pad running on two
// chains is one pad with two markets, and the all-chains slice is their sum.
func TestLaunchpadAllChainsIsATotal(t *testing.T) {
	resetPads()
	publishLaunchpads([]padSample{
		{Pad: "pumpfun", Chain: "solana", Volume: 1000, TokensLaunched: 10, TradeTxns: 100},
		{Pad: "pumpfun", Chain: "robinhood", Volume: 500, TokensLaunched: 5, TradeTxns: 50},
	}, []padKey{{"pumpfun", "solana"}, {"pumpfun", "robinhood"}})

	if got := testutil.ToFloat64(launchpadVolumeUSD.WithLabelValues("pumpfun", "all")); got != 1500 {
		t.Errorf("all-chains volume must total both markets, got %v want 1500", got)
	}
	if got := testutil.ToFloat64(launchpadVolumeUSD.WithLabelValues("pumpfun", "solana")); got != 1000 {
		t.Errorf("the real chain is still published, got %v", got)
	}
	if got := testutil.ToFloat64(launchpadTokensLaunched.WithLabelValues("pumpfun", "all")); got != 15 {
		t.Errorf("launches total too, got %v want 15", got)
	}
}

// A pad in the roster the cycle did not cover reads unhealthy with no figures,
// on its chain and on the aggregate. Same rule as the terminal side: these
// gauges are scraped every 60 seconds, so a figure left in place is averaged
// in as though it had just been measured.
func TestQuietPadIsDroppedEverywhere(t *testing.T) {
	resetPads()
	publishLaunchpads([]padSample{
		{Pad: "pumpfun", Chain: "solana", Volume: 1000, TokensLaunched: 10, TradeTxns: 100},
	}, []padKey{{"pumpfun", "solana"}, {"deadpad", "solana"}})

	if got := testutil.ToFloat64(launchpadHealth.WithLabelValues("deadpad", "solana")); got != 0 {
		t.Errorf("a quiet pad must read health 0 on its chain, got %v", got)
	}
	if got := testutil.ToFloat64(launchpadHealth.WithLabelValues("deadpad", "all")); got != 0 {
		t.Errorf("and on the aggregate, got %v", got)
	}
	if n := testutil.CollectAndCount(launchpadVolumeUSD); n != 2 {
		t.Errorf("expected pumpfun under solana and all only, got %d series", n)
	}
}

// A pad with no volume on the day publishes nothing rather than a zero that
// would rank it last on a figure nobody measured.
func TestPadWithNoVolumePublishesNothing(t *testing.T) {
	resetPads()
	n := publishLaunchpads([]padSample{
		{Pad: "quiet", Chain: "solana", Volume: 0, TokensLaunched: 3, TradeTxns: 0},
	}, []padKey{{"quiet", "solana"}})
	if n != 0 {
		t.Errorf("expected nothing published, got %d", n)
	}
	if c := testutil.CollectAndCount(launchpadVolumeUSD); c != 0 {
		t.Errorf("expected no volume series, got %d", c)
	}
}
