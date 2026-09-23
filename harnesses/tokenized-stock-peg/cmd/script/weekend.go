package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the image has no zoneinfo; Saturday is a New York day
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
// A gap counts as a weekend when it lasted at least weekendMinGap and
// contains a Saturday (New York time): the nightly close is about 17.5 h,
// Friday close to Monday open 65.5 h, a holiday weekend longer, and a
// midweek holiday (Thanksgiving: Wednesday close to Friday open, 41.5 h)
// is not a weekend. The maximum itself is read back from Prometheus over
// the exact gap, session-gated, so a restart inside the gap loses nothing
// and every asset is either published from the gap's own samples or has
// its stale value deleted (review 2026-09-23, pass 6). On start the
// tracker finds the last completed weekend the same way, so a redeploy
// does not blank the bench for a week.

const weekendMinGap = 40 * time.Hour

// regularScan is how far back the session series is scanned for gaps: two
// weekends plus a holiday one.
const regularScan = 10 * 24 * time.Hour

var newYork = func() *time.Location {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		panic("weekend: America/New_York: " + err.Error())
	}
	return loc
}()

type weekendTracker struct {
	mu        sync.Mutex
	client    *http.Client
	lastState string
	gapStart  time.Time // last regular tick before the current gap; zero when unknown
	sawStart  bool      // this process saw the gap open, so maxDev covers all of it
	maxDev    map[string]float64
	seen      bool
}

var weekend = &weekendTracker{maxDev: map[string]float64{}}

// begin is called once per tick, before the per-asset observations, with
// the session in force.
func (w *weekendTracker) begin(state string, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.seen && w.lastState == "regular" && state != "regular" {
		w.gapStart = now
		w.sawStart = true
		w.maxDev = map[string]float64{}
	}
	if w.seen && w.lastState != "regular" && state == "regular" {
		w.closeGap(now)
		w.gapStart = time.Time{}
		w.sawStart = false
		w.maxDev = map[string]float64{}
	}
	w.lastState = state
	w.seen = true
}

// observe keeps an in-process maximum per asset as the fallback for a
// gap Prometheus could not be asked about when it closes.
func (w *weekendTracker) observe(sym, state string, dev float64) {
	if state == "regular" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if dev > w.maxDev[sym] {
		w.maxDev[sym] = dev
	}
}

// closeGap runs at the first regular tick after a gap (lock held). The gap
// start is the tick the tracker saw, or, when the process started inside
// the gap, the last regular minute Prometheus holds.
func (w *weekendTracker) closeGap(now time.Time) {
	start := w.gapStart
	if start.IsZero() {
		gaps := w.gapsFromProm(now)
		if len(gaps) == 0 || !gaps[len(gaps)-1].end.IsZero() {
			fmt.Printf("[weekend] gap closed at %s with no known start; nothing published\n", now.Format(time.RFC3339))
			return
		}
		start = gaps[len(gaps)-1].start
	}
	if !isWeekendGap(start, now) {
		fmt.Printf("[weekend] gap of %.1f h (from %s) is not a weekend; nothing published\n", now.Sub(start).Hours(), start.Format(time.RFC3339))
		return
	}
	if n, ok := w.publishFromProm(start, now); ok {
		fmt.Printf("[weekend] gap of %.1f h closed, %d assets published from Prometheus\n", now.Sub(start).Hours(), n)
		return
	}
	// Prometheus unavailable: the in-process maximum is the whole gap only
	// when this process saw it open (a start found by the backfill scan
	// leaves the pre-restart part unseen), so anything else publishes
	// nothing rather than a partial weekend.
	if !w.sawStart {
		fmt.Printf("[weekend] gap closed, Prometheus unavailable and the process started inside the gap; nothing published\n")
		return
	}
	for _, a := range assets {
		sym := strings.ToLower(a.Symbol)
		if dev, ok := w.maxDev[sym]; ok {
			tspWeekendDrift.WithLabelValues(sym).Set(dev)
			tspWeekendDriftEnd.WithLabelValues(sym).Set(float64(now.Unix()))
		} else {
			tspWeekendDrift.DeleteLabelValues(sym)
			tspWeekendDriftEnd.DeleteLabelValues(sym)
		}
	}
	fmt.Printf("[weekend] gap of %.1f h closed, %d assets published from the in-process maximum\n", now.Sub(start).Hours(), len(w.maxDev))
}

// isWeekendGap: long enough, and a Saturday (New York) falls inside it.
func isWeekendGap(start, end time.Time) bool {
	if end.Sub(start) < weekendMinGap {
		return false
	}
	last := end.In(newYork)
	for d := start.In(newYork); !d.After(last); d = d.Add(24 * time.Hour) {
		if d.Weekday() == time.Saturday {
			return true
		}
	}
	return last.Weekday() == time.Saturday
}

// backfill publishes the last completed weekend from Prometheus at start,
// and, when the process starts inside a gap, remembers that gap's start
// so the live close publishes the whole gap.
func (w *weekendTracker) backfill(client *http.Client) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.client = client
	now := time.Now().UTC()
	gaps := w.gapsFromProm(now)
	if len(gaps) == 0 {
		fmt.Println("[weekend] backfill: no session history in Prometheus")
		return
	}
	if open := gaps[len(gaps)-1]; open.end.IsZero() {
		w.gapStart = open.start
		w.lastState = "closed"
		w.seen = true
		fmt.Printf("[weekend] started inside a gap open since %s\n", open.start.Format(time.RFC3339))
	}
	for i := len(gaps) - 1; i >= 0; i-- {
		g := gaps[i]
		if g.end.IsZero() || !isWeekendGap(g.start, g.end) {
			continue
		}
		if n, ok := w.publishFromProm(g.start, g.end); ok {
			fmt.Printf("[weekend] backfilled %d assets for the weekend %s to %s\n", n, g.start.Format(time.RFC3339), g.end.Format(time.RFC3339))
		}
		return
	}
	fmt.Println("[weekend] backfill: no completed weekend in the scanned history")
}

type sessionGap struct {
	start time.Time // last regular minute before the gap
	end   time.Time // first regular minute after it; zero while the gap is open
}

// gapsFromProm scans the regular-session flag over regularScan ending at
// `end` and returns the gaps between regular sessions, oldest first. The
// last entry has a zero end when the series ends outside regular hours.
func (w *weekendTracker) gapsFromProm(end time.Time) []sessionGap {
	if w.client == nil {
		return nil
	}
	prom := strings.TrimRight(envOr("PROM_URL", "http://172.18.0.14:9090"), "/")
	const step = 120 // seconds; 10 days at 2 min is 7200 points, under Prometheus' 11000 cap
	// The evaluation grid is aligned to the step so two scans made at
	// different moments see the same minutes: otherwise every restart
	// moved a weekend's end stamp by a few seconds and the spec's weekend
	// count (changes of the stamp) went up by one.
	last := end.Unix() - end.Unix()%step
	q := `max(tsp_market_session{benchmark="tokenized-stock-peg", market_state="regular"})`
	u := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%d&end=%d&step=%d", prom, urlQueryEscape(q), last-int64(regularScan.Seconds()), last, step)
	req, _ := http.NewRequest("GET", u, nil)
	resp, err := w.client.Do(req)
	if err != nil {
		fmt.Printf("[weekend] session scan failed: %v\n", err)
		return nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var envel struct {
		Data struct {
			Result []struct {
				Values [][]interface{} `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || len(envel.Data.Result) == 0 {
		return nil
	}
	type sample struct {
		t time.Time
		v float64
	}
	var samples []sample
	for _, pair := range envel.Data.Result[0].Values {
		if len(pair) < 2 {
			continue
		}
		ts, ok := pair[0].(float64)
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(fmt.Sprint(pair[1]), 64)
		if err != nil {
			continue
		}
		samples = append(samples, sample{time.Unix(int64(ts), 0).UTC(), v})
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i].t.Before(samples[j].t) })
	var gaps []sessionGap
	var lastRegular time.Time
	inGap := false
	for _, s := range samples {
		if s.v >= 1 {
			if inGap {
				gaps = append(gaps, sessionGap{start: lastRegular, end: s.t})
				inGap = false
			}
			lastRegular = s.t
			continue
		}
		if !inGap && !lastRegular.IsZero() {
			inGap = true
		}
	}
	if inGap {
		gaps = append(gaps, sessionGap{start: lastRegular})
	}
	return gaps
}

// publishFromProm sets the drift gauges from the session-gated maximum of
// the deviation over (start, end], one series per asset, and deletes the
// gauges of the assets that have no sample in the gap. Every state but
// regular counts (post, closed, pre), as the live tracker always did.
func (w *weekendTracker) publishFromProm(start, end time.Time) (int, bool) {
	if w.client == nil {
		return 0, false
	}
	prom := strings.TrimRight(envOr("PROM_URL", "http://172.18.0.14:9090"), "/")
	minutes := int(end.Sub(start).Minutes()) + 1
	q := fmt.Sprintf(`max_over_time((tsp_deviation_bps{benchmark="tokenized-stock-peg", issuer="robinhood", market_state!="regular"} and on() (tsp_market_session{benchmark="tokenized-stock-peg", market_state="regular"} == 0))[%dm:1m] @ %d)`, minutes, end.Unix())
	req, _ := http.NewRequest("GET", prom+"/api/v1/query?query="+urlQueryEscape(q), nil)
	resp, err := w.client.Do(req)
	if err != nil {
		fmt.Printf("[weekend] gap maximum query failed: %v\n", err)
		return 0, false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var envel struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  []interface{}     `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envel); err != nil || envel.Status != "success" {
		fmt.Printf("[weekend] gap maximum query: bad response\n")
		return 0, false
	}
	got := map[string]float64{}
	for _, r := range envel.Data.Result {
		sym := r.Metric["asset"]
		if sym == "" || len(r.Value) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(fmt.Sprint(r.Value[1]), 64)
		if err != nil {
			continue
		}
		if cur, ok := got[sym]; !ok || v > cur {
			got[sym] = v
		}
	}
	n := 0
	for _, a := range assets {
		sym := strings.ToLower(a.Symbol)
		if v, ok := got[sym]; ok {
			tspWeekendDrift.WithLabelValues(sym).Set(v)
			tspWeekendDriftEnd.WithLabelValues(sym).Set(float64(end.Unix()))
			n++
		} else {
			tspWeekendDrift.DeleteLabelValues(sym)
			tspWeekendDriftEnd.DeleteLabelValues(sym)
		}
	}
	return n, true
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func urlQueryEscape(s string) string {
	r := strings.NewReplacer(" ", "%20", "\"", "%22", "{", "%7B", "}", "%7D", "[", "%5B", "]", "%5D", "@", "%40", "=", "%3D", ",", "%2C", "|", "%7C", "+", "%2B", "#", "%23", "&", "%26", "(", "%28", ")", "%29", ":", "%3A", "!", "%21")
	return r.Replace(s)
}
