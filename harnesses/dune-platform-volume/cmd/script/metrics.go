package main

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	platformVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_24h_usd",
		Help: "Trading volume in USD per platform for the data day the query resolved to.",
	}, []string{"platform"})

	platformTxns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_txns_24h",
		Help: "Swap transaction count per platform for the data day the query resolved to.",
	}, []string{"platform"})

	platformFeesUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_fees_24h_usd",
		Help: "Platform fee revenue in USD per platform for the data day the query resolved to.",
	}, []string{"platform"})

	platformAvgTrade = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_avg_trade_usd",
		Help: "Average swap size in USD per platform (volume_usd / txns).",
	}, []string{"platform"})

	platformFeeRate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_fee_rate_pct",
		Help: "Observed fee take rate in percent per platform (fees_usd / volume_usd * 100).",
	}, []string{"platform"})

	platformWallets = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_wallets_24h",
		Help: "Unique trading wallets per platform for the data day the query resolved to.",
	}, []string{"platform"})

	// The data day every other gauge on this platform describes, as a unix
	// timestamp of 00:00 UTC. Published so a spec can gate on freshness and so
	// an operator can see which day a row is for: the figures themselves carry
	// no date, and the source this harness used until 2026-09-27 froze on
	// 2026-08-25 and kept being republished for 32 days with nothing in the
	// metrics saying so.
	platformDataDay = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_data_day_unix",
		Help: "Unix timestamp of 00:00 UTC on the data day the other gauges for this platform describe.",
	}, []string{"platform"})

	platformHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_health",
		Help: "1 if this platform returned a data day inside the freshness window on the last Dune poll, 0 otherwise.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(
		platformVolume,
		platformTxns,
		platformFeesUSD,
		platformAvgTrade,
		platformFeeRate,
		platformWallets,
		platformDataDay,
		platformHealth,
	)
}

// platformGauges are the gauge children keyed on platform alone.
func platformGauges() []*prometheus.GaugeVec {
	return []*prometheus.GaugeVec{
		platformVolume, platformTxns, platformFeesUSD,
		platformAvgTrade, platformFeeRate, platformWallets, platformDataDay,
	}
}

// dropPlatform removes every figure for a platform and drops its health to 0,
// the shape usdy-nav-basis uses for a failed leg. Deleting rather than
// republishing is the point: a stale or missing platform has to read
// unresponsive on the bench, because a value left in place is scraped every
// 60 s and averaged into a 24h window as if it had just been measured.
func dropPlatform(platform string) {
	for _, g := range platformGauges() {
		g.DeleteLabelValues(platform)
	}
	platformHealth.WithLabelValues(platform).Set(0)
}

// daysBehind is how many whole UTC days separate the data day from now: 0 is
// today, 1 yesterday. A row with no data day returns a very large number, so a
// source that does not say which day it measured is treated as stale rather
// than as current.
func daysBehind(dataDayUnix float64, now time.Time) int {
	if dataDayUnix <= 0 {
		return 1 << 20
	}
	day := time.Unix(int64(dataDayUnix), 0).UTC().Truncate(24 * time.Hour)
	today := now.UTC().Truncate(24 * time.Hour)
	return int(today.Sub(day) / (24 * time.Hour))
}

// publishRows writes the platforms whose data day is inside the window and
// drops everything else. maxDays is how many whole UTC days behind the data day
// may be; known is every platform the query is expected to return, so one that
// vanishes from the result is dropped too rather than keeping the figures from
// the last poll that carried it.
func publishRows(rows []duneRow, maxDays int, now time.Time, known []string) (published, dropped []string) {
	seen := make(map[string]bool, len(rows))
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		seen[r.Platform] = true
		if behind := daysBehind(r.DataDayUnix, now); behind > maxDays {
			dropPlatform(r.Platform)
			dropped = append(dropped, r.Platform)
			continue
		}
		platformVolume.WithLabelValues(r.Platform).Set(r.VolumeUSD)
		platformTxns.WithLabelValues(r.Platform).Set(r.Txns)
		platformFeesUSD.WithLabelValues(r.Platform).Set(r.FeesUSD)
		if r.AvgTradeUSD > 0 {
			platformAvgTrade.WithLabelValues(r.Platform).Set(r.AvgTradeUSD)
		} else {
			platformAvgTrade.DeleteLabelValues(r.Platform)
		}
		platformFeeRate.WithLabelValues(r.Platform).Set(r.FeeRatePct)
		if r.Wallets > 0 {
			platformWallets.WithLabelValues(r.Platform).Set(r.Wallets)
		} else {
			platformWallets.DeleteLabelValues(r.Platform)
		}
		platformDataDay.WithLabelValues(r.Platform).Set(r.DataDayUnix)
		platformHealth.WithLabelValues(r.Platform).Set(1)
		published = append(published, r.Platform)
	}
	for _, p := range known {
		if !seen[p] {
			dropPlatform(p)
			dropped = append(dropped, p)
		}
	}
	return published, dropped
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
