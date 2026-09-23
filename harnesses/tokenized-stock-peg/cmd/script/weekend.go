package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Weekend drift, one value per completed weekend and per asset: the
// maximum deviation from Friday's close observed between the last regular
// tick before a gap and the first regular tick after it, published when
// that first regular tick arrives. A rolling PromQL maximum over 72 h
// mixed weeknights with two weekends and ranked a Tuesday night as "last
// weekend" (audit 2026-09-23); the harness knows the sessions, so it does
// the aggregation itself.
//
//	tsp_weekend_drift_bps{asset}      max |deviation| over the last completed weekend gap
//	tsp_weekend_drift_end_unix{asset} when that gap ended (the Monday regular open)
//
// A gap counts as a weekend when it lasted at least weekendMinGap: the
// nightly close is about 17.5 h, Friday close to Monday open 65.5 h, and a
// holiday weekend longer. On start the tracker backfills the last completed
// weekend from Prometheus, so a redeploy does not blank the bench for a week.

const weekendMinGap = 40 * time.Hour

type weekendTracker struct {
	mu        sync.Mutex
	lastState string
	gapStart  time.Time
	maxDev    map[string]float64
	seen      bool
}

var weekend = &weekendTracker{maxDev: map[string]float64{}}

// observe is called once per asset per tick with the session in force.
// Session transitions are tracked once per tick (the first asset seen).
func (w *weekendTracker) begin(state string, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seen && w.lastState == "regular" && state != "regular" {
		w.gapStart = now
		w.maxDev = map[string]float64{}
	}
	if w.seen && w.lastState != "regular" && state == "regular" && !w.gapStart.IsZero() {
		if gap := now.Sub(w.gapStart); gap >= weekendMinGap {
			for sym, dev := range w.maxDev {
				tspWeekendDrift.WithLabelValues(sym).Set(dev)
				tspWeekendDriftEnd.WithLabelValues(sym).Set(float64(now.Unix()))
			}
			fmt.Printf("[weekend] gap of %.1f h closed, %d assets published\n", gap.Hours(), len(w.maxDev))
		}
		w.gapStart = time.Time{}
	}
	w.lastState = state
	w.seen = true
}

func (w *weekendTracker) observe(sym, state string, dev float64) {
	if state == "regular" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.gapStart.IsZero() {
		return // gap started before the process did; the backfill covers it
	}
	if dev > w.maxDev[sym] {
		w.maxDev[sym] = dev
	}
}

// backfill sets the gauges from Prometheus for the last completed weekend:
// the maximum of the closed-session deviation over the 66 h that end at
// the most recent Monday 13:30 UTC (the regular open; a holiday Monday
// simply yields the same gap read on Tuesday by the live tracker).
func (w *weekendTracker) backfill(client *http.Client) {
	prom := strings.TrimRight(envOr("PROM_URL", "http://172.18.0.14:9090"), "/")
	now := time.Now().UTC()
	// most recent Monday 13:30 UTC strictly in the past
	d := now
	for d.Weekday() != time.Monday {
		d = d.AddDate(0, 0, -1)
	}
	end := time.Date(d.Year(), d.Month(), d.Day(), 13, 30, 0, 0, time.UTC)
	if end.After(now) {
		end = end.AddDate(0, 0, -7)
	}
	// Session-gated: before 2026-09-23 the closed gauge stayed exported
	// through the next sessions, so an ungated maximum would pick up
	// Thursday night's frozen value on Friday evening.
	q := fmt.Sprintf(`max_over_time((tsp_deviation_bps{benchmark="tokenized-stock-peg", issuer="robinhood", market_state="closed"} and on() (tsp_market_session{benchmark="tokenized-stock-peg", market_state="closed"} == 1))[66h:1m] @ %d)`, end.Unix())
	req, _ := http.NewRequest("GET", prom+"/api/v1/query?query="+urlQueryEscape(q), nil)
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[weekend] backfill skipped: %v\n", err)
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var envel struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  []interface{}     `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Data.Result) == 0 {
		fmt.Printf("[weekend] backfill: no data for the weekend ending %s\n", end.Format(time.RFC3339))
		return
	}
	n := 0
	for _, r := range envel.Data.Result {
		sym := r.Metric["asset"]
		if sym == "" || len(r.Value) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(fmt.Sprint(r.Value[1]), 64)
		if err != nil {
			continue
		}
		tspWeekendDrift.WithLabelValues(sym).Set(v)
		tspWeekendDriftEnd.WithLabelValues(sym).Set(float64(end.Unix()))
		n++
	}
	fmt.Printf("[weekend] backfilled %d assets for the weekend ending %s\n", n, end.Format(time.RFC3339))
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func urlQueryEscape(s string) string {
	r := strings.NewReplacer(" ", "%20", "\"", "%22", "{", "%7B", "}", "%7D", "[", "%5B", "]", "%5D", "@", "%40", "=", "%3D", ",", "%2C", "|", "%7C", "+", "%2B", "#", "%23", "&", "%26", "(", "%28", ")", "%29", ":", "%3A")
	return r.Replace(s)
}
