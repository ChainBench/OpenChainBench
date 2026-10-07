package main

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Multi-day windows, for the benches that rank on more than the latest day.
//
// A separate metric family rather than a `window` label on the existing
// gauges. Adding a label to a published metric makes every query that does not
// pin it match several series at once, and the loader returns null for "more
// than one series where one was expected": the four benches already serving
// from terminal_volume_usd would all go blank on deploy.
//
// Sums, not averages. Volume, fees and transactions add over days the same way
// they add over chains, and the take rate built on them is correctly
// time-weighted by construction: total fees over the volume of the days whose
// fees could be measured, never a mean of daily rates.

var windowKeys = []string{"1d", "7d", "30d"}

var (
	windowVolumeUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_window_volume_usd",
		Help: "Routed volume in USD summed over the window, for one platform on one chain. window is 1d, 7d or 30d, counted back from the source's latest day.",
	}, []string{"platform", "chain", "window"})

	windowFeesUSD = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_window_fees_usd",
		Help: "Fee revenue in USD summed over the window. Only days whose fee cell was usable are counted, so this never pairs a partial numerator with a whole denominator.",
	}, []string{"platform", "chain", "window"})

	windowTxns = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_window_txns",
		Help: "Swap transactions summed over the window.",
	}, []string{"platform", "chain", "window"})

	windowTakeRatePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_window_take_rate_pct",
		Help: "Fees over volume across the window, in percent, volume-weighted by construction. Published only when at least one day in the window had a usable fee cell.",
	}, []string{"platform", "chain", "window"})

	windowSharePct = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_window_share_pct",
		Help: "This platform's share of the cohort's total volume over the window, in percent, on this chain.",
	}, []string{"platform", "chain", "window"})

	historyDays = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "terminal_history_days",
		Help: "Days between the platform's first day in the source and its latest, a measure of how long it has been running.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(
		windowVolumeUSD, windowFeesUSD, windowTxns, windowTakeRatePct, windowSharePct, historyDays,
	)
}

func windowGauges() []*prometheus.GaugeVec {
	return []*prometheus.GaugeVec{windowVolumeUSD, windowFeesUSD, windowTxns, windowTakeRatePct, windowSharePct}
}

// windowAgg is one platform-chain-window cell while it is being accumulated.
type windowAgg struct {
	vol, fees, txns, feeVol float64
	feeOK                   bool
}

// publishWindows writes the 1d, 7d and 30d sums for every platform and chain,
// plus the all-chains slice and each platform's share of the cohort.
//
// agg is keyed platform|chain|window. roster is every platform the source
// offers, so one that stops reporting is dropped rather than left behind.
func publishWindows(agg map[string]*windowAgg, roster []string, chains []string, firstDays map[string]float64) {
	// Cohort totals per chain and window, for the share column. Computed
	// before anything is written, because a share needs the denominator whole.
	totals := map[string]float64{}
	for k, a := range agg {
		chain, win := splitKey(k)
		totals[chain+"|"+win] += a.vol
	}

	for k, a := range agg {
		platform, chain, win := splitKey3(k)
		if a.vol <= 0 {
			continue
		}
		windowVolumeUSD.WithLabelValues(platform, chain, win).Set(a.vol)
		windowTxns.WithLabelValues(platform, chain, win).Set(a.txns)
		if t := totals[chain+"|"+win]; t > 0 {
			windowSharePct.WithLabelValues(platform, chain, win).Set(a.vol / t * 100)
		}
		if a.feeOK && a.feeVol > 0 {
			windowFeesUSD.WithLabelValues(platform, chain, win).Set(a.fees)
			windowTakeRatePct.WithLabelValues(platform, chain, win).Set(a.fees / a.feeVol * 100)
		} else {
			windowFeesUSD.DeleteLabelValues(platform, chain, win)
			windowTakeRatePct.DeleteLabelValues(platform, chain, win)
		}
	}

	for p, d := range firstDays {
		historyDays.WithLabelValues(p).Set(d)
	}

	// Drop what this cycle did not write, so a platform that goes quiet stops
	// being scraped with last week's totals.
	for _, p := range roster {
		for _, chain := range append(append([]string{}, chains...), aggregateChain) {
			for _, win := range windowKeys {
				if _, ok := agg[p+"|"+chain+"|"+win]; ok {
					continue
				}
				for _, g := range windowGauges() {
					g.DeleteLabelValues(p, chain, win)
				}
			}
		}
		if _, ok := firstDays[p]; !ok {
			historyDays.DeleteLabelValues(p)
		}
	}
}

func splitKey(k string) (chain, win string) {
	_, c, w := splitKey3(k)
	return c, w
}

func splitKey3(k string) (platform, chain, win string) {
	first, rest := cut(k, '|')
	second, third := cut(rest, '|')
	return first, second, third
}

func cut(s string, sep byte) (string, string) {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return s[:i], s[i+1:]
		}
	}
	return s, ""
}

// buildWindows turns the per-bot series into the 1d, 7d and 30d aggregation,
// per chain and across all of them, plus each platform's days of history.
//
// The fee rule is the daily one applied over time. A platform that reports
// fees somewhere in the window has any zero day treated as a gap and left out
// of the ratio entirely, numerator and denominator together; a platform that
// reports nothing anywhere is uniformly free and publishes a real zero. The
// alternative, dividing whatever fees were seen by all of the volume, reads a
// terminal as cheaper the less of it could be measured.
func buildWindows(details []*botDetail) (map[string]*windowAgg, map[string]float64, []string) {
	feesAnywhere := map[string]bool{}
	for _, d := range details {
		for _, s := range d.Series {
			for _, f := range s.FeesUSD {
				if f > 0 {
					feesAnywhere[canonical(d.Bot)] = true
				}
			}
		}
	}

	agg := map[string]*windowAgg{}
	firstDays := map[string]float64{}
	chainSet := map[string]bool{}
	get := func(k string) *windowAgg {
		if a := agg[k]; a != nil {
			return a
		}
		a := &windowAgg{}
		agg[k] = a
		return a
	}

	for _, d := range details {
		if d == nil || len(d.Days) == 0 {
			continue
		}
		p := canonical(d.Bot)
		// How long the platform has been running, not how many days this
		// cycle read. len(d.Days) is the window size, so it reads 30 for
		// everyone and the column means nothing; first_day is what the
		// source knows about its age.
		if age, err := daysBetween(d.FirstDay, d.Through); err == nil {
			firstDays[p] = age
		}
		n := len(d.Days)
		for _, s := range d.Series {
			if s.Name == "" {
				continue
			}
			chainSet[s.Name] = true
			for i := 0; i < n; i++ {
				v, t, f := at(s.VolumeUSD, i), at(s.Txns, i), at(s.FeesUSD, i)
				if v <= 0 {
					continue
				}
				back := n - i // 1 for the latest day
				for _, win := range windowKeys {
					if back > windowLen(win) {
						continue
					}
					for _, chain := range []string{s.Name, aggregateChain} {
						a := get(p + "|" + chain + "|" + win)
						a.vol += v
						a.txns += t
						// A zero fee day counts only when the platform charges
						// nothing anywhere; otherwise it is a gap.
						if f > 0 || !feesAnywhere[p] {
							a.fees += f
							a.feeVol += v
							a.feeOK = true
						}
					}
				}
			}
		}
	}
	chains := make([]string, 0, len(chainSet))
	for c := range chainSet {
		chains = append(chains, c)
	}
	return agg, firstDays, chains
}

func windowLen(win string) int {
	switch win {
	case "1d":
		return 1
	case "7d":
		return 7
	default:
		return 30
	}
}

// daysBetween is the whole days from one YYYY-MM-DD to another, inclusive of
// the first day, so a platform seen on exactly one day reads 1.
func daysBetween(from, to string) (float64, error) {
	a, err := time.Parse("2006-01-02", from)
	if err != nil {
		return 0, err
	}
	b, err := time.Parse("2006-01-02", to)
	if err != nil {
		return 0, err
	}
	return b.Sub(a).Hours()/24 + 1, nil
}
