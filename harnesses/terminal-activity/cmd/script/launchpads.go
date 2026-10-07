package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Launchpads: the other half of the tehcscreener API, read for bench 200.
//
// A launchpad is where a token is created and first traded. It is not a
// terminal: pump.fun appears in both roles and the two figures differ by more
// than an order of magnitude, because the launchpad counts every trade on its
// tokens whoever routed it, while the terminal counts only what came through
// its own interface. Publishing them under separate metric families keeps that
// distinction impossible to lose.
//
// Known divergence, recorded because it is load-bearing and unresolved: on
// 2026-10-07 this endpoint reported pump.fun at $688.4M for the day, against
// $185.0M from DeFiLlama and $188.4M from Mobula, two indexers that share no
// code and landed 1.8% apart. The same comparison on `flap` runs the other way,
// $0.5M here against $21.4M from Mobula. Neither is a counting convention: at
// chain level this source reads 2.08x DeFiLlama on Solana, 1.16x on Base and
// 0.27x on HyperEVM, so the three differ in coverage rather than in method.
// The figures published here are this source's, by decision, and bench 200
// says so on its own page.

var (
	launchpadVolumeUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "launchpad_volume_usd",
		Help: "Trading volume in USD on a launchpad's tokens for the latest complete UTC day, whoever routed the trade. Not the launchpad's own interface volume.",
	}, []string{"pad", "chain"})

	launchpadTokensLaunched = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "launchpad_tokens_launched",
		Help: "Tokens launched on this pad during the latest complete UTC day.",
	}, []string{"pad", "chain"})

	launchpadTradeTxns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "launchpad_trade_txns",
		Help: "Trade transactions on this launchpad's tokens during the latest complete UTC day.",
	}, []string{"pad", "chain"})

	launchpadHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "launchpad_health",
		Help: "1 when this pad published a day inside the freshness window on the last poll, 0 when it is in the roster and did not.",
	}, []string{"pad", "chain"})
)

func init() {
	prometheus.MustRegister(
		launchpadVolumeUSD, launchpadTokensLaunched, launchpadTradeTxns, launchpadHealth,
	)
}

func launchpadGauges() []*prometheus.GaugeVec {
	return []*prometheus.GaugeVec{launchpadVolumeUSD, launchpadTokensLaunched, launchpadTradeTxns}
}

// dropPad removes a pad's figures and marks it unhealthy, under its real chain
// and under the aggregate alias. Same reasoning as dropPair: a figure left in
// place is scraped every 60 seconds and averaged through a window as though it
// had just been measured.
func dropPad(pad, chain string) {
	for _, alias := range padAliases(chain) {
		for _, g := range launchpadGauges() {
			g.DeleteLabelValues(pad, alias)
		}
		launchpadHealth.WithLabelValues(pad, alias).Set(0)
	}
}

// padAliases is deliberately not aliasesFor. Launchpad volume adds up across
// chains, so `all` is a true total written once from the totals, not a copy of
// the headline chain. Only the real chain is written per sample.
func padAliases(chain string) []string { return []string{chain} }

// publishLaunchpads writes one day per pad and drops every pad in the roster
// the cycle did not cover. roster is every pad the source offers, so one that
// goes quiet reads unhealthy instead of vanishing.
func publishLaunchpads(pads []padSample, roster []padKey) (published int) {
	seen := map[string]bool{}
	type tot struct{ vol, tok, tx float64 }
	byPad := map[string]*tot{}

	for _, p := range pads {
		if p.Pad == "" || p.Chain == "" || p.Volume <= 0 {
			continue
		}
		seen[p.Pad+"|"+p.Chain] = true
		launchpadVolumeUSD.WithLabelValues(p.Pad, p.Chain).Set(p.Volume)
		launchpadTokensLaunched.WithLabelValues(p.Pad, p.Chain).Set(p.TokensLaunched)
		launchpadTradeTxns.WithLabelValues(p.Pad, p.Chain).Set(p.TradeTxns)
		launchpadHealth.WithLabelValues(p.Pad, p.Chain).Set(1)

		t := byPad[p.Pad]
		if t == nil {
			t = &tot{}
			byPad[p.Pad] = t
		}
		t.vol += p.Volume
		t.tok += p.TokensLaunched
		t.tx += p.TradeTxns
		published++
	}

	// The all-chains slice: a real total. A pad that runs on two chains is one
	// pad with two markets, and its volume is the sum of them, unlike a wallet
	// count. Written once from the totals rather than copied from one chain.
	for pad, t := range byPad {
		launchpadVolumeUSD.WithLabelValues(pad, aggregateChain).Set(t.vol)
		launchpadTokensLaunched.WithLabelValues(pad, aggregateChain).Set(t.tok)
		launchpadTradeTxns.WithLabelValues(pad, aggregateChain).Set(t.tx)
		launchpadHealth.WithLabelValues(pad, aggregateChain).Set(1)
	}

	for _, k := range roster {
		if !seen[k.Pad+"|"+k.Chain] {
			dropPad(k.Pad, k.Chain)
			if _, ok := byPad[k.Pad]; !ok {
				launchpadHealth.WithLabelValues(k.Pad, aggregateChain).Set(0)
				for _, g := range launchpadGauges() {
					g.DeleteLabelValues(k.Pad, aggregateChain)
				}
			}
		}
	}
	return published
}
