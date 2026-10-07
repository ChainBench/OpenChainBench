package main

import (
	"net/http"
	"sort"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// headlineChain is the slice a spec's unfiltered view selects. Every gauge keyed
// on chain is published under its real chain and, for this one, again under
// chain="all".
//
// The alias is not decoration and it is not an average. The site's label
// injection only replaces a selector already pinned to `="all"`, so a spec that
// does not pin it reads every chain at once and the loader returns null for
// "more than one series where one was expected". Bench 283 spent a day with a
// blank headline column for exactly that reason. `all` therefore has to carry
// one real slice, and it carries Solana: it is where most of this cohort's
// volume is, and a pooled cross-chain figure would describe no venue anyone
// trades on.
const headlineChain = "solana"

func aliasesFor(chain string) []string {
	if chain == headlineChain {
		return []string{chain, "all"}
	}
	return []string{chain}
}

var (
	volumeUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_volume_usd",
		Help: "Routed swap volume in USD for one platform on one chain, on the latest complete UTC day the source published.",
	}, []string{"platform", "chain"})

	txns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_txns",
		Help: "Swap transactions for one platform on one chain, on the latest complete UTC day.",
	}, []string{"platform", "chain"})

	feesUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_fees_usd",
		Help: "Platform fee revenue in USD for one platform on one chain, on the latest complete UTC day.",
	}, []string{"platform", "chain"})

	wallets = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_wallets",
		Help: "Distinct wallets that traded through one platform on one chain, on the latest complete UTC day. Per chain, so it is not deduplicated across chains.",
	}, []string{"platform", "chain"})

	avgTradeUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_avg_trade_usd",
		Help: "Average swap size in USD (volume / transactions) for one platform on one chain.",
	}, []string{"platform", "chain"})

	feeRatePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_fee_rate_pct",
		Help: "Observed take rate in percent (fees / volume * 100) for one platform on one chain. Zero is a measurement: an app that charges no terminal fee reads 0.",
	}, []string{"platform", "chain"})

	tradesPerWallet = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_trades_per_wallet",
		Help: "Swaps per distinct wallet (transactions / wallets) for one platform on one chain: how heavily that platform's users trade in a day.",
	}, []string{"platform", "chain"})

	volumePerWalletUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_volume_per_wallet_usd",
		Help: "Volume per distinct wallet in USD (volume / wallets) for one platform on one chain.",
	}, []string{"platform", "chain"})

	chainBreadth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_chain_breadth",
		Help: "How many chains a platform routed measurable volume on, on the latest complete UTC day.",
	}, []string{"platform"})

	dataDayUnix = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_data_day_unix",
		Help: "Unix timestamp of 00:00 UTC on the day every other gauge for this platform and chain describes.",
	}, []string{"platform", "chain"})

	health = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_activity_health",
		Help: "1 when this platform and chain published a day inside the freshness window on the last poll, 0 when it is in the roster and did not.",
	}, []string{"platform", "chain"})

	lastSuccessUnix = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "terminal_activity_last_success_unix",
		Help: "Unix timestamp of the last cycle that published at least one platform. Prometheus gauges keep their last value, so a spec needs this to tell a quiet harness from a dead one.",
	})

	feeWithheld = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_fee_withheld",
		Help: "1 when this platform and chain reported exactly zero fees on material volume while the same platform reports fees on another chain, so the zero is an unexplained gap rather than a price. The take rate is not published for that cell.",
	}, []string{"platform", "chain"})

	feeColumnOK = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_fee_column_ok",
		Help: "1 when at least one platform on this chain reported non-zero fees on the data day, 0 when the whole column was zero. A zero column is a source failure, not a market where every platform is free.",
	}, []string{"chain"})
)

func init() {
	prometheus.MustRegister(
		volumeUSD, txns, feesUSD, wallets,
		avgTradeUSD, feeRatePct, tradesPerWallet, volumePerWalletUSD,
		chainBreadth, dataDayUnix, health, lastSuccessUnix, feeColumnOK, feeWithheld,
	)
}

// pairGauges are the gauges keyed on (platform, chain). health is deliberately
// not in the list: dropping a pair sets it to 0 rather than deleting it, so a
// platform that went quiet is visibly unhealthy instead of absent.
func pairGauges() []*prometheus.GaugeVec {
	return []*prometheus.GaugeVec{
		volumeUSD, txns, feesUSD, wallets,
		avgTradeUSD, feeRatePct, tradesPerWallet, volumePerWalletUSD, dataDayUnix,
	}
}

// dropPair removes every figure for a platform on a chain and marks it
// unhealthy, under the real chain label and under every alias it was published
// with.
//
// Deleting rather than republishing is the whole mechanism. These gauges are
// scraped every 60 seconds and read through a 24h window, so a figure left in
// place is averaged in as though it had just been measured. The source this
// cohort read until 2026-09-27 froze on 2026-08-25 and was republished for 32
// days with nothing in the metrics saying so.
func dropPair(platform, chain string) {
	for _, alias := range aliasesFor(chain) {
		for _, g := range pairGauges() {
			g.DeleteLabelValues(platform, alias)
		}
		health.WithLabelValues(platform, alias).Set(0)
	}
}

// daysBehind is how many whole UTC days separate a data day from now: 0 today,
// 1 yesterday. A sample with no day is treated as very stale rather than as
// current, because a source that will not say which day it measured has not
// earned the benefit of the doubt.
func daysBehind(dayUnix float64, now time.Time) int {
	if dayUnix <= 0 {
		return 1 << 20
	}
	day := time.Unix(int64(dayUnix), 0).UTC().Truncate(24 * time.Hour)
	today := now.UTC().Truncate(24 * time.Hour)
	return int(today.Sub(day) / (24 * time.Hour))
}

// publish writes one cycle's samples and drops everything in the roster that
// those samples do not cover.
//
// roster is every platform the source offers, including the quiet ones, so a
// platform that stops reporting is marked unhealthy instead of vanishing.
// maxAgeDays is how many whole days behind the data day may be.
func publish(samples []sample, roster []string, maxAgeDays int, now time.Time) (published int, chains []string) {
	fresh := make([]sample, 0, len(samples))
	for _, s := range samples {
		if s.Platform == "" || s.Chain == "" {
			continue
		}
		if daysBehind(s.DayUnix, now) > maxAgeDays {
			continue
		}
		fresh = append(fresh, s)
	}

	// Whether each chain's fee column carries any signal at all, decided across
	// the cohort before a single take rate is written. One platform reporting no
	// fees is a finding (pump.fun's own app charges no terminal fee). Every
	// platform on a chain reporting no fees is the column having failed, and
	// publishing that as a market of free terminals would be the most flattering
	// possible reading of missing data.
	feesSeen := map[string]bool{}
	for _, s := range fresh {
		if s.Fees > 0 {
			feesSeen[s.Chain] = true
		}
	}

	// And whether each PLATFORM reports fees anywhere, which is the finer
	// question and the one that matters.
	//
	// A chain-level gate cannot catch a gap in one row. Axiom routed $29.8M on
	// Robinhood and $21.7M on BNB over a week with fees of exactly $0.00, while
	// charging 0.92% on Solana; the other terminals on those chains do report
	// fees, so the column gate read healthy and Axiom's zero was published as
	// the lowest take rate in the market and crowned the tab. pump.fun is the
	// same shape in the other direction: it reports fees on Robinhood, BNB,
	// Ethereum and Base and exactly $0.00 on Solana, where it routes $252M.
	//
	// Nobody routes tens of millions for free for a week. A platform that
	// demonstrably charges somewhere and reports exactly nothing elsewhere has
	// an unexplained zero, and this harness is not able to tell a waived fee
	// from an unmeasured one. So the cell's take rate is withheld and a flag
	// says why, instead of publishing the most flattering possible reading of
	// a blank. A platform reporting zero on every chain it serves is a
	// different claim, and that one still publishes as a real zero.
	platformFeesAnywhere := map[string]bool{}
	for _, s := range fresh {
		if s.Fees > 0 {
			platformFeesAnywhere[s.Platform] = true
		}
	}

	seen := map[string]bool{}   // platform|chain
	breadth := map[string]int{} // platform -> chains with a published row
	chainSet := map[string]bool{}
	for _, s := range fresh {
		seen[s.Platform+"|"+s.Chain] = true
		breadth[s.Platform]++
		chainSet[s.Chain] = true
		for _, alias := range aliasesFor(s.Chain) {
			volumeUSD.WithLabelValues(s.Platform, alias).Set(s.Volume)
			txns.WithLabelValues(s.Platform, alias).Set(s.Txns)
			avgTradeUSD.WithLabelValues(s.Platform, alias).Set(s.Volume / s.Txns)
			dataDayUnix.WithLabelValues(s.Platform, alias).Set(s.DayUnix)
			health.WithLabelValues(s.Platform, alias).Set(1)

			unexplainedZero := s.Fees <= 0 && platformFeesAnywhere[s.Platform]
			if feesSeen[s.Chain] && !unexplainedZero {
				feesUSD.WithLabelValues(s.Platform, alias).Set(s.Fees)
				feeRatePct.WithLabelValues(s.Platform, alias).Set(s.Fees / s.Volume * 100)
			} else {
				feesUSD.DeleteLabelValues(s.Platform, alias)
				feeRatePct.DeleteLabelValues(s.Platform, alias)
			}
			if unexplainedZero {
				feeWithheld.WithLabelValues(s.Platform, alias).Set(1)
			} else {
				feeWithheld.DeleteLabelValues(s.Platform, alias)
			}

			// Wallets are the one field the source does not always carry. The
			// per-chain series is populated for every active platform today, but
			// the cross-chain wallets_dedup field is null for 6 of 8, so a shape
			// change here is plausible and the ratios must not be invented from a
			// zero denominator.
			if s.Wallets > 0 {
				wallets.WithLabelValues(s.Platform, alias).Set(s.Wallets)
				tradesPerWallet.WithLabelValues(s.Platform, alias).Set(s.Txns / s.Wallets)
				volumePerWalletUSD.WithLabelValues(s.Platform, alias).Set(s.Volume / s.Wallets)
			} else {
				wallets.DeleteLabelValues(s.Platform, alias)
				tradesPerWallet.DeleteLabelValues(s.Platform, alias)
				volumePerWalletUSD.DeleteLabelValues(s.Platform, alias)
			}
		}
		published++
	}

	for chain := range chainSet {
		v := 0.0
		if feesSeen[chain] {
			v = 1
		}
		for _, alias := range aliasesFor(chain) {
			feeColumnOK.WithLabelValues(alias).Set(v)
		}
	}

	// Drop every roster pair this cycle did not publish, on every chain the
	// cycle saw. A platform that left one chain keeps its rows on the others.
	for _, p := range roster {
		for chain := range chainSet {
			if !seen[p+"|"+chain] {
				dropPair(p, chain)
			}
		}
		chainBreadth.WithLabelValues(p).Set(float64(breadth[p]))
	}

	chains = make([]string, 0, len(chainSet))
	for c := range chainSet {
		chains = append(chains, c)
	}
	sort.Strings(chains)
	return published, chains
}

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
