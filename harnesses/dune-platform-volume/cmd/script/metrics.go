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

// markAllUnresponsive puts health 0 on every platform and no figures, which is
// the honest state before anything has been fetched. Without it a deploy that
// lands before the indexing lag has cleared leaves the series absent rather than
// unresponsive for hours, and an alert on health == 0 has nothing to fire on.
func markAllUnresponsive(known []string) {
	for _, p := range known {
		dropPlatform(p)
	}
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

// rowDay is the row's data day as YYYY-MM-DD.
func rowDay(r duneRow) string {
	if r.DataDayUnix <= 0 {
		return ""
	}
	return time.Unix(int64(r.DataDayUnix), 0).UTC().Format("2006-01-02")
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

// dayCovered reports whether the query saw trades close enough to the end of the
// data day for that day to be treated as loaded. The data day on its own cannot
// show this, because the harness chose it rather than observing it: a Spellbook
// incremental that is still half way through the day returns a fraction of its
// volume, which would otherwise be published as a whole day. The last trade is
// taken across the whole cohort, which does millions of transactions a day, so
// the final minutes of a loaded day are always populated.
func dayCovered(r duneRow) bool {
	if r.DataDayUnix <= 0 || r.DayLastTradeUnix <= 0 {
		return false
	}
	return r.DayLastTradeUnix >= r.DataDayUnix+23*3600
}

// rowUsable is the guard's rule for one row: a data day inside the window, on a
// day the query saw through to its end. publishRows and publishableRows both go
// through it so the two can never disagree.
func rowUsable(r duneRow, maxDays int, now time.Time) bool {
	return r.Platform != "" && daysBehind(r.DataDayUnix, now) <= maxDays && dayCovered(r)
}

// publishableRows is how many of these rows publishRows would publish, and how
// many of those would carry their fee figures. Used to decide whether a fresh
// result is worth taking, without touching any gauge.
func publishableRows(rows []duneRow, maxDays int, now time.Time) (usable, priced int) {
	for _, r := range rows {
		if !rowUsable(r, maxDays, now) {
			continue
		}
		usable++
		if r.SolPriceUSD > 0 {
			priced++
		}
	}
	return usable, priced
}

// dayFinal is a stricter bar than dayCovered. 23:00 is enough to publish a day,
// but recording it as measured stops it ever being re-run, so a day the query saw
// only to 23:00 would be locked in an hour short. A retry can replace it, because
// publish accepts a later usable and priced result for the same day.
func dayFinal(r duneRow) bool {
	return r.DataDayUnix > 0 && r.DayLastTradeUnix >= r.DataDayUnix+23*3600+55*60
}

// publishRows writes the platforms whose data day is inside the window and fully
// loaded, and drops everything else. maxDays is how many whole UTC days behind the
// data day may be; known is every platform the query is expected to return, so one
// that vanishes from the result is dropped too rather than keeping the figures from
// the last poll that carried it.
func publishRows(rows []duneRow, maxDays int, now time.Time, known []string) (published, dropped []string) {
	seen := make(map[string]bool, len(rows))
	// complete is false when any published row had to withhold its fee figures, so
	// the day is not recorded and the refresh gate can retry it. It has to be
	// decided over every row before the day is recorded, not while iterating: the
	// row with no price may come after one that has it.
	complete := true
	day := ""
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		seen[r.Platform] = true
		if !rowUsable(r, maxDays, now) {
			dropPlatform(r.Platform)
			dropped = append(dropped, r.Platform)
			continue
		}
		platformVolume.WithLabelValues(r.Platform).Set(r.VolumeUSD)
		platformTxns.WithLabelValues(r.Platform).Set(r.Txns)
		// Most of these platforms take their cut in SOL, so without the day's SOL
		// close the fee total is only the stablecoin part of it. Volume does not
		// depend on the price, so it still publishes; the fee figures do not, rather
		// than reading as a low take rate that looks measured.
		if r.SolPriceUSD > 0 {
			platformFeesUSD.WithLabelValues(r.Platform).Set(r.FeesUSD)
			platformFeeRate.WithLabelValues(r.Platform).Set(r.FeeRatePct)
		} else {
			platformFeesUSD.DeleteLabelValues(r.Platform)
			platformFeeRate.DeleteLabelValues(r.Platform)
			// prices.day may not have the day's SOL row yet when the query runs.
			// The day is not finished, so the refresh gate must let it be retried.
			complete = false
		}
		if !dayFinal(r) {
			complete = false
		}
		if r.AvgTradeUSD > 0 {
			platformAvgTrade.WithLabelValues(r.Platform).Set(r.AvgTradeUSD)
		} else {
			platformAvgTrade.DeleteLabelValues(r.Platform)
		}
		if r.Wallets > 0 {
			platformWallets.WithLabelValues(r.Platform).Set(r.Wallets)
		} else {
			platformWallets.DeleteLabelValues(r.Platform)
		}
		platformDataDay.WithLabelValues(r.Platform).Set(r.DataDayUnix)
		platformHealth.WithLabelValues(r.Platform).Set(1)
		published = append(published, r.Platform)
		day = rowDay(r)
	}
	for _, p := range known {
		if !seen[p] {
			dropPlatform(p)
			dropped = append(dropped, p)
		}
	}
	switch {
	case len(published) == 0:
		publishedDay = ""
	case complete:
		publishedDay = day
	}
	return published, dropped
}

// publishedDay is the data day the last publish put on the board, or "" when
// nothing is published. The refresh loop reads it to decide whether the day it
// would measure is already in hand. Written only inside publishRows, whose
// callers hold publishMu.
var publishedDay string

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
