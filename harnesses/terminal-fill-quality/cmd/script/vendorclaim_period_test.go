package main

import (
	"encoding/csv"
	"math"
	"strconv"
	"strings"
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func gaugeOf(lane, kind, period string) float64 {
	var d dto.Metric
	if gVendorABPeriodRate.WithLabelValues("pump-fun", lane, kind, period).Write(&d) != nil {
		return -1
	}
	return d.Gauge.GetValue()
}

// The daily digest must be the undated digest with a date column, nothing
// more: summing over the day reproduces it cell for cell. If the two files
// ever disagree, one of them no longer describes pump's original.
func TestDailyDigestSumsToTheCommittedDigest(t *testing.T) {
	read := func(src string, dated bool) map[string]float64 {
		var b strings.Builder
		for _, l := range strings.Split(src, "\n") {
			if !strings.HasPrefix(l, "#") {
				b.WriteString(l + "\n")
			}
		}
		rows, err := csv.NewReader(strings.NewReader(b.String())).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]float64{}
		for _, r := range rows[1:] {
			if dated {
				r = r[1:]
			}
			n, _ := strconv.ParseFloat(r[5], 64)
			out[strings.Join(r[:5], ",")] += n
		}
		return out
	}
	a, b := read(pumpErrorDigest, false), read(pumpErrorDigestDaily, true)
	if len(a) != len(b) {
		t.Fatalf("%d cells undated, %d after summing the daily digest", len(a), len(b))
	}
	for k, v := range a {
		if b[k] != v {
			t.Errorf("%s: %v undated, %v summed from days", k, v, b[k])
		}
	}
	if !strings.Contains(pumpErrorDigestDaily, "de8bc04403d1fc3da0325a58c6dc98f5ffd8919a68effad3ad4fd46f2520bd1e") {
		t.Error("the daily digest lost the SHA256 that ties it to pump's original")
	}
}

// The partial first and last days never enter a period, and the periods are
// the whole days the export actually has.
func TestPeriodsUseWholeDaysOnly(t *testing.T) {
	p := vendorPeriods(parseVendorDaily(pumpErrorDigestDaily))
	for period, days := range p {
		for d := range days {
			if pumpPartialDays[d] {
				t.Errorf("%s includes partial day %s", period, d)
			}
		}
	}
	if !p["first_full_day"]["2026-09-29"] || len(p["first_full_day"]) != 1 {
		t.Errorf("first_full_day = %v, want only 2026-09-29", p["first_full_day"])
	}
	for _, d := range []string{"2026-10-04", "2026-10-05", "2026-10-06"} {
		if !p["last_3_full_days"][d] {
			t.Errorf("last_3_full_days misses %s", d)
		}
	}
	if len(p["full_days"]) != 8 {
		t.Errorf("full_days has %d days, want 8 (29 Sep to 6 Oct)", len(p["full_days"]))
	}
}

// The published figures, recomputed independently from the original on
// 2026-10-22. If these move, the digest or the period logic changed.
func TestPeriodRatesMatchTheExport(t *testing.T) {
	loadVendorABPeriods()
	for _, c := range []struct {
		lane, kind, period string
		want               float64
	}{
		{"pump-bridge", "sell", "first_full_day", 11.78},
		{"pump-bridge", "sell", "last_3_full_days", 5.16},
		{"relay", "sell", "first_full_day", 12.05},
		{"relay", "sell", "last_3_full_days", 9.88},
		{"pump-bridge", "buy", "first_full_day", 0.97},
		{"relay", "buy", "last_3_full_days", 12.80},
		{"pump-bridge", "sell", "full_days", 7.02},
		{"relay", "sell", "full_days", 9.95},
	} {
		got := gaugeOf(c.lane, c.kind, c.period)
		if math.Abs(got-c.want) > 0.005 {
			t.Errorf("%s %s %s = %.4f, want %.2f", c.lane, c.kind, c.period, got, c.want)
		}
	}
	// "all" is both directions pooled, so it sits between them.
	for _, period := range []string{"first_full_day", "last_3_full_days", "full_days"} {
		lo, hi := gaugeOf("pump-bridge", "buy", period), gaugeOf("pump-bridge", "sell", period)
		if all := gaugeOf("pump-bridge", "all", period); all < lo || all > hi {
			t.Errorf("%s: all %.3f outside [%.3f, %.3f]", period, all, lo, hi)
		}
	}
}
