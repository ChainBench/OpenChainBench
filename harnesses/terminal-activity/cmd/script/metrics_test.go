package main

import (
	"math"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func resetAll() {
	for _, g := range pairGauges() {
		g.Reset()
	}
	health.Reset()
	feeWithheld.Reset()
	chainBreadth.Reset()
	feeColumnOK.Reset()
}

// day returns the unix seconds of 00:00 UTC n whole days before now.
func day(now time.Time, n int) float64 {
	return float64(now.UTC().Truncate(24*time.Hour).AddDate(0, 0, -n).Unix())
}

func mk(platform, chain string, dayUnix, vol, tx, fees, w float64) sample {
	return sample{Platform: platform, Chain: chain, DayUnix: dayUnix, Volume: vol, Txns: tx, Fees: fees, Wallets: w}
}

// The headline slice has to be published under chain="all", and nothing else
// may claim it.
//
// The site's label injection only rewrites a selector already pinned to
// `="all"`. Without the alias a spec cannot pin the dimension, so it reads every
// chain at once and the loader returns null where it wanted one series. If a
// second chain also published under `all`, pinning it would match two chains and
// the same null comes back from the other direction.
func TestHeadlineChainIsAliasedAndIsUnique(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{
		mk("axiom", "solana", d, 1000, 10, 7, 5),
		mk("axiom", "bnb", d, 500, 5, 3, 2),
	}, []string{"axiom"}, 3, now)

	if got := testutil.ToFloat64(volumeUSD.WithLabelValues("axiom", "all")); got != 1000 {
		t.Errorf(`chain="all" should carry the %s figure 1000, got %v`, headlineChain, got)
	}
	if got := testutil.ToFloat64(volumeUSD.WithLabelValues("axiom", headlineChain)); got != 1000 {
		t.Errorf("the real chain label must still be published, got %v", got)
	}
	// Collect every chain label value that exists and check only one aliases.
	aliased := 0
	for _, c := range []string{"solana", "bnb"} {
		for _, a := range aliasesFor(c) {
			if a == "all" {
				aliased++
			}
		}
	}
	if aliased != 1 {
		t.Errorf("exactly one chain may alias to all, %d do", aliased)
	}
}

// A platform in the roster that this cycle did not publish must read unhealthy
// with no figures, not keep the last cycle's numbers.
//
// This is the failure that cost 32 days of wrong data on the source these
// benches used until 2026-09-27: a frozen feed kept being republished, scraped
// every 60 seconds and averaged through a 24h window as if it had just been
// measured. BullX is the live case here, with 765 days of history and no volume
// since 2026-05-31.
func TestQuietPlatformIsDroppedAndMarkedUnhealthy(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{mk("axiom", "solana", d, 1000, 10, 7, 5)}, []string{"axiom", "bullx"}, 3, now)

	if got := testutil.ToFloat64(health.WithLabelValues("bullx", "solana")); got != 0 {
		t.Errorf("a quiet platform must read health 0, got %v", got)
	}
	if n := testutil.CollectAndCount(volumeUSD); n != 2 {
		// axiom under solana and under all; bullx under neither.
		t.Errorf("expected 2 volume series (one platform, two aliases), got %d", n)
	}
	if got := testutil.ToFloat64(chainBreadth.WithLabelValues("bullx")); got != 0 {
		t.Errorf("a quiet platform has breadth 0, got %v", got)
	}
}

// A data day older than the window publishes nothing.
func TestStaleDayIsNotPublished(t *testing.T) {
	resetAll()
	now := time.Now()
	published, _ := publish([]sample{mk("axiom", "solana", day(now, 9), 1000, 10, 7, 5)}, []string{"axiom"}, 3, now)
	if published != 0 {
		t.Errorf("a 9-day-old sample must not publish, published %d", published)
	}
	if got := testutil.ToFloat64(health.WithLabelValues("axiom", "solana")); got != 0 {
		t.Errorf("a stale platform must read health 0, got %v", got)
	}
}

// Zero fees on one platform is a measurement and must publish. Zero fees across
// the whole chain is the column having failed and must publish nothing.
//
// pump.fun's own app is the real zero: it charges no terminal fee while every
// other terminal in the cohort takes 0.46% to 1.11%. That finding is worth
// publishing. A chain where nobody charges anything is not a market, it is a
// missing column, and publishing it would be the most flattering possible
// reading of absent data.
func TestZeroFeeIsAMeasurementButAZeroColumnIsNot(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)

	publish([]sample{
		mk("pumpapp", "solana", d, 1000, 10, 0, 5),
		mk("axiom", "solana", d, 2000, 20, 14, 8),
	}, []string{"pumpapp", "axiom"}, 3, now)
	if got := testutil.ToFloat64(feeRatePct.WithLabelValues("pumpapp", "solana")); got != 0 {
		t.Errorf("a real zero take rate must publish as 0, got %v", got)
	}
	if got := testutil.ToFloat64(feeColumnOK.WithLabelValues("solana")); got != 1 {
		t.Errorf("the fee column carried signal, expected ok 1, got %v", got)
	}

	resetAll()
	publish([]sample{
		mk("pumpapp", "solana", d, 1000, 10, 0, 5),
		mk("axiom", "solana", d, 2000, 20, 0, 8),
	}, []string{"pumpapp", "axiom"}, 3, now)
	if n := testutil.CollectAndCount(feeRatePct); n != 0 {
		t.Errorf("a wholly zero fee column must publish no take rate, got %d series", n)
	}
	if got := testutil.ToFloat64(feeColumnOK.WithLabelValues("solana")); got != 0 {
		t.Errorf("a wholly zero fee column must read ok 0, got %v", got)
	}
	// Volume still publishes: it does not depend on the fee column.
	if got := testutil.ToFloat64(volumeUSD.WithLabelValues("axiom", "solana")); got != 2000 {
		t.Errorf("volume must survive a failed fee column, got %v", got)
	}
}

// Ratios are never invented from a zero denominator.
func TestNoWalletsMeansNoPerWalletRatios(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{mk("gmgn", "solana", d, 1000, 10, 7, 0)}, []string{"gmgn"}, 3, now)

	if n := testutil.CollectAndCount(tradesPerWallet); n != 0 {
		t.Errorf("trades per wallet must not publish without wallets, got %d series", n)
	}
	if n := testutil.CollectAndCount(volumePerWalletUSD); n != 0 {
		t.Errorf("volume per wallet must not publish without wallets, got %d series", n)
	}
	if n := testutil.CollectAndCount(wallets); n != 0 {
		t.Errorf("wallets must not publish a zero, got %d series", n)
	}
	// The figures that do not need the denominator are still there.
	if got := testutil.ToFloat64(avgTradeUSD.WithLabelValues("gmgn", "solana")); got != 100 {
		t.Errorf("avg trade is volume/txns and must still publish, got %v", got)
	}
}

// The derived figures are the ones the four benches actually rank on, so pin the
// arithmetic rather than trusting it.
func TestDerivedFiguresAreTheRatiosTheyClaimToBe(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{mk("terminal", "solana", d, 6000, 100, 66, 20)}, []string{"terminal"}, 3, now)

	for _, c := range []struct {
		name string
		got  float64
		want float64
	}{
		{"avg trade (6000/100)", testutil.ToFloat64(avgTradeUSD.WithLabelValues("terminal", "solana")), 60},
		{"take rate (66/6000*100)", testutil.ToFloat64(feeRatePct.WithLabelValues("terminal", "solana")), 1.1},
		{"trades per wallet (100/20)", testutil.ToFloat64(tradesPerWallet.WithLabelValues("terminal", "solana")), 5},
		{"volume per wallet (6000/20)", testutil.ToFloat64(volumePerWalletUSD.WithLabelValues("terminal", "solana")), 300},
	} {
		if math.Abs(c.got-c.want) > 1e-9 {
			t.Errorf("%s: got %v want %v", c.name, c.got, c.want)
		}
	}
}

// Chain breadth counts chains with a published row, so a platform that only
// trades on one chain reads 1 and a multi-chain router reads its real spread.
// Measured today: Trojan and Photon are on 1, GMGN on 10.
func TestChainBreadthCountsPublishedChains(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{
		mk("gmgn", "solana", d, 1000, 10, 7, 5),
		mk("gmgn", "bnb", d, 500, 5, 3, 2),
		mk("gmgn", "base", d, 100, 2, 1, 1),
		mk("trojan", "solana", d, 900, 9, 6, 4),
	}, []string{"gmgn", "trojan"}, 3, now)

	if got := testutil.ToFloat64(chainBreadth.WithLabelValues("gmgn")); got != 3 {
		t.Errorf("gmgn breadth: got %v want 3", got)
	}
	if got := testutil.ToFloat64(chainBreadth.WithLabelValues("trojan")); got != 1 {
		t.Errorf("trojan breadth: got %v want 1", got)
	}
}

// A platform that charges somewhere and reports exactly nothing elsewhere has
// its take rate withheld for that cell, not published as the market floor.
//
// This is the bug a chain-level gate could not see. Axiom routed $29.8M on
// Robinhood and $21.7M on BNB over a week with fees of exactly $0.00 while
// charging 0.92% on Solana. The other terminals on those chains do report
// fees, so the column gate read healthy, and Axiom's zero was published as the
// lowest take rate in the market and crowned both tabs. Nobody routes tens of
// millions for free for a week, and this harness cannot tell a waived fee from
// an unmeasured one, so the honest move is to withhold the cell and say why.
func TestUnexplainedZeroFeeIsWithheldNotCrowned(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{
		// Axiom: real fees on Solana, exactly zero on BNB with real volume.
		mk("axiom", "solana", d, 100000, 1000, 920, 50),
		mk("axiom", "bnb", d, 50000, 500, 0, 25),
		// Another terminal reports fees on BNB, so the column gate reads healthy
		// and cannot be what saves us here.
		mk("gmgn", "bnb", d, 40000, 400, 420, 20),
	}, []string{"axiom", "gmgn"}, 3, now)

	if got := testutil.ToFloat64(feeColumnOK.WithLabelValues("bnb")); got != 1 {
		t.Fatalf("precondition: the bnb fee column must read healthy, got %v", got)
	}
	if n := testutil.CollectAndCount(feeRatePct); n != 3 {
		// axiom/solana under two aliases, gmgn/bnb under one. Axiom on bnb: none.
		t.Errorf("expected 3 take-rate series, got %d", n)
	}
	if got := testutil.ToFloat64(feeWithheld.WithLabelValues("axiom", "bnb")); got != 1 {
		t.Errorf("axiom on bnb must be flagged withheld, got %v", got)
	}
	// Everything that does not depend on the fee column survives.
	if got := testutil.ToFloat64(volumeUSD.WithLabelValues("axiom", "bnb")); got != 50000 {
		t.Errorf("volume must survive a withheld fee cell, got %v", got)
	}
	if got := testutil.ToFloat64(wallets.WithLabelValues("axiom", "bnb")); got != 25 {
		t.Errorf("wallets must survive a withheld fee cell, got %v", got)
	}
}

// A platform that reports zero on every chain it serves is making a different
// claim, and that one still publishes as a real zero. Without this the guard
// would erase a genuinely free terminal, which is the opposite error.
func TestZeroEverywhereStillPublishesAsZero(t *testing.T) {
	resetAll()
	now := time.Now()
	d := day(now, 1)
	publish([]sample{
		mk("freebot", "solana", d, 100000, 1000, 0, 50),
		mk("freebot", "bnb", d, 50000, 500, 0, 25),
		mk("gmgn", "solana", d, 40000, 400, 420, 20),
	}, []string{"freebot", "gmgn"}, 3, now)

	if got := testutil.ToFloat64(feeRatePct.WithLabelValues("freebot", "solana")); got != 0 {
		t.Errorf("a platform free on every chain must publish 0, got %v", got)
	}
	if n := testutil.CollectAndCount(feeWithheld); n != 0 {
		t.Errorf("nothing should be withheld for a uniformly free platform, got %d flags", n)
	}
}
