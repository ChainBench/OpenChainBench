package main

// pump.fun's own A/B export, recomputed.
//
// On 2026-10-21 pump published a Pump Bridge versus Relay comparison and
// invited anyone to check it, linking the rows behind it. The headline was
// "almost 13x fewer buy errors than Relay", 0.87 against 11 per 100.
//
// That reproduces exactly, on buys. The export also carries sells, and there
// the bridge errors at 7.378% against Relay's 10.511%: over both directions
// the ratio is 2.95x, not 12.90x. The bridge fails 8.5 times more often on a
// sell than on a buy, mostly as bridge_execute_failed.
//
// The counts are embedded rather than described, so the figures below can be
// recomputed from this repository without trusting this file's arithmetic. The
// digest is lossless for any rate by chain, lane, direction or error class, and
// carries the SHA256 of the 20 MB original.
//
// These gauges are NOT a measurement of ours. They restate a vendor's published
// dataset over a window that ended on 2026-10-07, and their help text says so,
// because a gauge on a dashboard otherwise reads as live.

import (
	_ "embed"
	"encoding/csv"
	"log"
	"strconv"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
)

//go:embed pump-error-digest.csv
var pumpErrorDigest string

var (
	gVendorABErrorRate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_vendor_ab_error_rate_pct",
		Help: "Error rate recomputed from a vendor's OWN published A/B export, percent of trades. Not measured by this harness and not live: pump.fun's export covers 2026-09-28 to 2026-10-07 and does not change. Read it beside the direction label, which is where its headline and its whole dataset disagree",
	}, []string{"vendor", "lane", "kind"})
	gVendorABRows = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tfq_vendor_ab_rows",
		Help: "Trades behind each tfq_vendor_ab_error_rate_pct, from the vendor's own export. Published alongside because a rate without its denominator cannot be judged, and because the arms are not equally sized on every direction",
	}, []string{"vendor", "lane", "kind"})
)

func init() {
	prometheus.MustRegister(gVendorABErrorRate, gVendorABRows)
}

// loadVendorAB publishes the recomputation once at startup.
//
// Once, because the source is a finished export. A ticker here would suggest
// the numbers move.
// laneSlug maps the export's lane name to the provider slug the spec declares.
//
// A metric_panel matches its label value against the PROVIDER SLUG, so a lane
// published as "bridge" beside a provider called "pump-bridge" simply never
// renders: the panel showed Relay alone and nothing failed. Relay matched only
// because its export name and its slug happen to be the same word.
func laneSlug(lane string) string {
	if lane == "bridge" {
		return "pump-bridge"
	}
	return lane
}

func loadVendorAB() {
	type cell struct{ lane, kind string }
	total := map[cell]float64{}
	errs := map[cell]float64{}

	var body strings.Builder
	for _, line := range strings.Split(pumpErrorDigest, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		body.WriteString(line)
		body.WriteString("\n")
	}
	r := csv.NewReader(strings.NewReader(body.String()))
	rows, err := r.ReadAll()
	if err != nil || len(rows) < 2 {
		log.Printf("[vendor-ab] digest unreadable: %v", err)
		return
	}
	for _, rec := range rows[1:] { // rows[0] is the header
		if len(rec) < 6 {
			continue
		}
		n, err := strconv.ParseFloat(rec[5], 64)
		if err != nil {
			continue
		}
		k := cell{lane: laneSlug(rec[1]), kind: rec[2]}
		total[k] += n
		if rec[3] != "success" {
			errs[k] += n
		}
	}
	if len(total) == 0 {
		log.Printf("[vendor-ab] digest parsed to nothing")
		return
	}

	// Per direction, and the two together, which is the comparison the
	// vendor's headline leaves out.
	byLane := map[string]float64{}
	byLaneErr := map[string]float64{}
	for k, n := range total {
		gVendorABRows.WithLabelValues("pump-fun", k.lane, k.kind).Set(n)
		if n > 0 {
			gVendorABErrorRate.WithLabelValues("pump-fun", k.lane, k.kind).
				Set(100 * errs[k] / n)
		}
		byLane[k.lane] += n
		byLaneErr[k.lane] += errs[k]
	}
	for lane, n := range byLane {
		if n <= 0 {
			continue
		}
		gVendorABRows.WithLabelValues("pump-fun", lane, "all").Set(n)
		gVendorABErrorRate.WithLabelValues("pump-fun", lane, "all").
			Set(100 * byLaneErr[lane] / n)
	}
	log.Printf("[vendor-ab] pump.fun export recomputed: bridge %.3f%% vs relay %.3f%% over both directions, from %.0f trades",
		100*byLaneErr["bridge"]/byLane["bridge"],
		100*byLaneErr["relay"]/byLane["relay"],
		byLane["bridge"]+byLane["relay"])
}
