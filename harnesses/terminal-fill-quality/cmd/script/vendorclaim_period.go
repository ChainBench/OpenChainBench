package main

// pump.fun's export over time, not only in total.
//
// The headline figures are window averages, and the window was not a steady
// state: the bridge's sell error rate fell from 11.78 % on the first full day
// (2026-09-29) to 5.16 % over the last three (2026-10-04 to 06), while Relay's
// went from 12.05 % to 9.88 %. On the first full day the two routes were level
// on sells. A window average over a system being changed during its own test
// is a different caveat from the unequal sell arms, and the per-period figures
// are what let a reader see it.
//
// The daily digest is lossless (summing over the day reproduces
// pump-error-digest.csv exactly; a test holds that), carries the SHA256 of
// pump's original, and keeps the two partial days. They are dropped here, at
// read time, so the file can still be checked against the original: the
// export starts at 16:00 on 2026-09-28 and ends at 20:00 on 2026-10-07, and an
// 8-hour day read beside 24-hour days looks like a level change it is not.

import (
	_ "embed"
	"encoding/csv"
	"log"
	"sort"
	"strconv"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
)

//go:embed pump-error-digest-daily.csv
var pumpErrorDigestDaily string

// pumpPartialDays: the export's first and last UTC days, which it covers only
// in part (8 and 21 hours). Named rather than detected so a reader of the code
// sees exactly what is left out.
var pumpPartialDays = map[string]bool{"2026-09-28": true, "2026-10-07": true}

var (
	gVendorABPeriodRate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_vendor_ab_period_error_rate_pct",
		Help: "Error rate from a vendor's OWN published A/B export over one period of its window, percent of trades. period=first_full_day|last_3_full_days|full_days; partial first and last days are excluded. Not measured by this harness and not live. Read beside tfq_vendor_ab_error_rate_pct: the gap between the first and last periods is how much the product changed during its own test",
	}, []string{"vendor", "lane", "kind", "period"})
	gVendorABPeriodRows = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_vendor_ab_period_rows",
		Help: "Trades behind each tfq_vendor_ab_period_error_rate_pct, from the vendor's own export",
	}, []string{"vendor", "lane", "kind", "period"})
)

func init() {
	prometheus.MustRegister(gVendorABPeriodRate, gVendorABPeriodRows)
}

// vendorDayCell is one day's count for a lane and direction.
type vendorDayCell struct {
	day, lane, kind string
	n, errs         float64
}

// parseVendorDaily reads the daily digest into per-day cells, partial days
// included: filtering is the caller's decision.
func parseVendorDaily(src string) []vendorDayCell {
	var body strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		body.WriteString(line)
		body.WriteString("\n")
	}
	rows, err := csv.NewReader(strings.NewReader(body.String())).ReadAll()
	if err != nil || len(rows) < 2 {
		log.Printf("[vendor-ab] daily digest unreadable: %v", err)
		return nil
	}
	agg := map[[3]string]*vendorDayCell{}
	for _, rec := range rows[1:] { // day,chain,lane,direction,outcome,error_class,rows
		if len(rec) < 7 {
			continue
		}
		n, err := strconv.ParseFloat(rec[6], 64)
		if err != nil {
			continue
		}
		k := [3]string{rec[0], laneSlug(rec[2]), rec[3]}
		c := agg[k]
		if c == nil {
			c = &vendorDayCell{day: k[0], lane: k[1], kind: k[2]}
			agg[k] = c
		}
		c.n += n
		if rec[4] != "success" {
			c.errs += n
		}
	}
	out := make([]vendorDayCell, 0, len(agg))
	for _, c := range agg {
		out = append(out, *c)
	}
	return out
}

// vendorPeriods splits the whole days into the three published periods.
func vendorPeriods(cells []vendorDayCell) map[string]map[string]bool {
	seen := map[string]bool{}
	for _, c := range cells {
		if !pumpPartialDays[c.day] {
			seen[c.day] = true
		}
	}
	days := make([]string, 0, len(seen))
	for d := range seen {
		days = append(days, d)
	}
	sort.Strings(days)
	p := map[string]map[string]bool{"first_full_day": {}, "last_3_full_days": {}, "full_days": {}}
	for i, d := range days {
		p["full_days"][d] = true
		if i == 0 {
			p["first_full_day"][d] = true
		}
		if i >= len(days)-3 {
			p["last_3_full_days"][d] = true
		}
	}
	return p
}

// loadVendorABPeriods publishes the per-period rates once, like loadVendorAB.
func loadVendorABPeriods() {
	cells := parseVendorDaily(pumpErrorDigestDaily)
	if len(cells) == 0 {
		return
	}
	type key struct{ lane, kind, period string }
	n, e := map[key]float64{}, map[key]float64{}
	for period, days := range vendorPeriods(cells) {
		for _, c := range cells {
			if !days[c.day] {
				continue
			}
			for _, kind := range []string{c.kind, "all"} {
				k := key{c.lane, kind, period}
				n[k] += c.n
				e[k] += c.errs
			}
		}
	}
	for k, total := range n {
		if total <= 0 {
			continue
		}
		gVendorABPeriodRows.WithLabelValues("pump-fun", k.lane, k.kind, k.period).Set(total)
		gVendorABPeriodRate.WithLabelValues("pump-fun", k.lane, k.kind, k.period).Set(100 * e[k] / total)
	}
	f := key{"pump-bridge", "sell", "first_full_day"}
	l := key{"pump-bridge", "sell", "last_3_full_days"}
	if n[f] > 0 && n[l] > 0 {
		log.Printf("[vendor-ab] bridge sell error %.2f%% on the first full day, %.2f%% over the last three", 100*e[f]/n[f], 100*e[l]/n[l])
	}
}
