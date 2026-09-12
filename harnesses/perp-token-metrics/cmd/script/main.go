package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// protocol is one row of the valuation table. llamaSlug is the DeFiLlama
// entity the token accrues value from (the parent when the protocol has
// several products, so mcap and fees are measured on the same scope, the
// way defillama.com/pf does it). llamaPerpSlug is the perps-only child,
// used for the perp-share column and the open-interest join; empty means
// the parent is perps-only. cgID empty means the protocol has no listed
// token: fees are still published, every valuation ratio is skipped.
type protocol struct {
	slug          string // bench slug / prometheus label
	llamaSlug     string // DeFiLlama fees slug, token scope (parent)
	llamaPerpSlug string // DeFiLlama fees slug, perps-only child ("" = same as llamaSlug)
	cgID          string // CoinGecko coin ID ("" = no token)
}

// Verified against api.llama.fi/summary/fees/<slug> and CoinGecko
// /coins/markets on 2026-09-12 (see harness README for the coverage
// table). Slugs that DeFiLlama no longer serves (vertex, aevo, grvt,
// backpack) are deliberately absent rather than left to fail every hour.
var protocols = []protocol{
	{slug: "hyperliquid", llamaSlug: "hyperliquid", llamaPerpSlug: "hyperliquid-perps", cgID: "hyperliquid"},
	{slug: "gmx", llamaSlug: "gmx", llamaPerpSlug: "gmx-v2-perps", cgID: "gmx"},
	{slug: "gains", llamaSlug: "gains-network", cgID: "gains-network"},
	{slug: "dydx", llamaSlug: "dydx", llamaPerpSlug: "dydx-v4", cgID: "dydx-chain"},
	// Drift's DeFiLlama parent aggregates the staked-SOL product; the perps
	// adapter (drift-trade) is what the token is priced on, even while it
	// reports zero and leaves every ratio undefined.
	{slug: "drift", llamaSlug: "drift-trade", cgID: "drift-protocol"},
	{slug: "jupiter", llamaSlug: "jupiter", llamaPerpSlug: "jupiter-perpetual-exchange", cgID: "jupiter-exchange-solana"},
	{slug: "aster", llamaSlug: "aster", llamaPerpSlug: "aster-perps", cgID: "aster-2"},
	{slug: "lighter", llamaSlug: "lighter", llamaPerpSlug: "lighter-perps", cgID: "lighter"},
	{slug: "avantis", llamaSlug: "avantis", cgID: "avantis"},
	{slug: "apex", llamaSlug: "apex-protocol", llamaPerpSlug: "apex-omni", cgID: "apex-token-2"},
	{slug: "orderly", llamaSlug: "orderly-perps", cgID: "orderly-network"},
	{slug: "synfutures", llamaSlug: "synfutures", llamaPerpSlug: "synfutures-v3", cgID: "synfutures"},
	{slug: "derive", llamaSlug: "derive", llamaPerpSlug: "derive-v2", cgID: "derive"},
	// Token-less venues: fees and open interest only.
	{slug: "ostium", llamaSlug: "ostium"},
	{slug: "pacifica", llamaSlug: "pacifica", llamaPerpSlug: "pacifica-perps"},
	{slug: "extended", llamaSlug: "extended", llamaPerpSlug: "extended-perps"},
	{slug: "edgex", llamaSlug: "edgex", llamaPerpSlug: "edgex-v2"},
	{slug: "paradex", llamaSlug: "paradex-perps"},
}

func (p protocol) perpSlug() string {
	if p.llamaPerpSlug != "" {
		return p.llamaPerpSlug
	}
	return p.llamaSlug
}

func addr() string {
	if v := os.Getenv("METRICS_ADDR"); v != "" {
		return v
	}
	return ":2112"
}

func main() {
	fmt.Println("=== perp-token-metrics harness ===")
	fmt.Println("OpenChainBench #234 (P/E) + perp DEX valuation (P/F, P/S)")
	fmt.Printf("Protocols: %d | poll interval: 1h\n", len(protocols))

	go func() {
		if err := startMetricsServer(addr()); err != nil {
			fmt.Fprintf(os.Stderr, "metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	poll()

	if os.Getenv("ONESHOT") == "1" {
		return
	}

	ticker := time.NewTicker(60 * time.Minute)
	defer ticker.Stop()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)

	for {
		select {
		case <-ticker.C:
			poll()
		case s := <-sig:
			fmt.Printf("signal %v — exiting\n", s)
			return
		}
	}
}

func poll() {
	fmt.Printf("[%s] polling DeFiLlama + CoinGecko\n", time.Now().UTC().Format(time.RFC3339))

	// One batch call for every token, one call for every open-interest row.
	cgIDs := []string{}
	for _, p := range protocols {
		if p.cgID != "" {
			cgIDs = append(cgIDs, p.cgID)
		}
	}
	markets := fetchCGMarkets(cgIDs)
	oi := fetchLlamaOpenInterest()

	for _, p := range protocols {
		fees, feesOK := fetchLlamaSeries(p.llamaSlug, "dailyFees")
		if !feesOK {
			fmt.Printf("  [%s] DeFiLlama fees fetch failed\n", p.slug)
			protocolHealth.WithLabelValues(p.slug).Set(0)
			continue
		}
		// Revenue is optional: several adapters publish fees only, and an
		// adapter that answers with a flat zero series is the same thing.
		rev, revOK := fetchLlamaSeries(p.llamaSlug, "dailyRevenue")
		revOK = revOK && rev.Sum30d > 0
		perpFees := fees
		if p.perpSlug() != p.llamaSlug {
			if pf, ok := fetchLlamaSeries(p.perpSlug(), "dailyFees"); ok {
				perpFees = pf
			}
		}

		v := computeValuation(fees, rev, revOK, markets[p.cgID], p.cgID != "")
		publish(p, v, perpFees, oi[p.perpSlug()])
		protocolHealth.WithLabelValues(p.slug).Set(1)

		fmt.Printf("  [%s] fees30d=$%.0f rev30d=$%.0f mcap=$%.0f fdv=$%.0f pf=%.1fx ps=%.1fx pe=%.1fx\n",
			p.slug, fees.Sum30d, rev.Sum30d, v.Mcap, v.FDV, v.PF, v.PS, v.PE)
	}
}

// publish writes one protocol's row into the gauge vectors. Ratios that
// could not be computed (no token, zero fees) are removed from the vector
// so a stale value from a previous poll never survives a source outage.
func publish(p protocol, v valuation, perpFees llamaSeries, oiUSD float64) {
	l := labelsFor(p.slug)

	protocolFees24h.With(l).Set(v.Fees24h)
	protocolFees30d.With(l).Set(v.Fees30d)
	protocolFeesPrev30d.With(l).Set(v.FeesPrev30d)
	protocolFees1y.With(l).Set(v.Fees1y)
	protocolAnnualFees.With(l).Set(v.AnnualFees)
	protocolPerpFees30d.With(l).Set(perpFees.Sum30d)

	setOrDelete(protocolRev24h, l, v.Rev24h, v.HasRev)
	setOrDelete(protocolRev30d, l, v.Rev30d, v.HasRev)
	setOrDelete(protocolAnnualRev, l, v.AnnualRev, v.HasRev)
	setOrDelete(protocolRevShare, l, v.RevSharePct, v.HasRev && v.Fees30d > 0)

	setOrDelete(protocolMcap, l, v.Mcap, v.HasToken && v.Mcap > 0)
	setOrDelete(protocolFDV, l, v.FDV, v.HasToken && v.FDV > 0)
	setOrDelete(protocolFloat, l, v.FloatPct, v.HasToken && v.FloatPct > 0)

	setOrDelete(protocolPF, l, v.PF, v.HasPF)
	setOrDelete(protocolPFfdv, l, v.PFfdv, v.HasPFfdv)
	setOrDelete(protocolPS, l, v.PS, v.HasPS)
	setOrDelete(protocolPE, l, v.PE, v.HasPE)

	setOrDelete(protocolOI, l, oiUSD, oiUSD > 0)
	feesToOI := 0.0
	if oiUSD > 0 {
		feesToOI = v.AnnualFees / oiUSD
	}
	setOrDelete(protocolFeesToOI, l, feesToOI, feesToOI > 0)
}
