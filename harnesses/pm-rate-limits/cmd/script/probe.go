package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/http/httptrace"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type baselineSample struct {
	at  time.Time
	dur float64
}

type venueState struct {
	mu        sync.Mutex
	pin       Pin
	baseline  []baselineSample // warm primary-class durations, pruned to 1h
	lastRepin time.Time
	repinCh   chan string
}

func newVenueState() *venueState {
	return &venueState{repinCh: make(chan string, 1)}
}

func (st *venueState) getPin() Pin {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.pin
}

func (st *venueState) setPin(p Pin) {
	st.mu.Lock()
	st.pin = p
	st.mu.Unlock()
}

func (st *venueState) addBaseline(d float64) {
	now := time.Now()
	st.mu.Lock()
	st.baseline = append(st.baseline, baselineSample{at: now, dur: d})
	cut := now.Add(-time.Hour)
	i := 0
	for i < len(st.baseline) && st.baseline[i].at.Before(cut) {
		i++
	}
	st.baseline = st.baseline[i:]
	st.mu.Unlock()
}

// baselineP50 returns the median warm primary-class duration over the last
// hour and the sample count. The ramp's added-latency gauge is meaningless
// without it.
func (st *venueState) baselineP50() (float64, int) {
	st.mu.Lock()
	durs := make([]float64, len(st.baseline))
	for i, s := range st.baseline {
		durs[i] = s.dur
	}
	st.mu.Unlock()
	if len(durs) == 0 {
		return 0, 0
	}
	sort.Float64s(durs)
	return durs[len(durs)/2], len(durs)
}

func (st *venueState) triggerRepin(failed string) {
	select {
	case st.repinCh <- failed:
	default:
	}
}

// classifyCache buckets response cache headers: "hit" when an edge served the
// response without touching origin, "miss" when cache infra is present but the
// response came from origin, "none" when no cache layer announced itself
// (Myriad's bare Heroku router).
func classifyCache(h http.Header) string {
	cf := strings.ToUpper(h.Get("Cf-Cache-Status"))
	xc := strings.ToLower(h.Get("X-Cache"))
	if cf == "HIT" || cf == "STALE" || cf == "UPDATING" || strings.Contains(xc, "hit") {
		return "hit"
	}
	if age, err := strconv.Atoi(h.Get("Age")); err == nil && age > 0 {
		return "hit"
	}
	if cf != "" || xc != "" {
		return "miss"
	}
	return "none"
}

func classifyOutcome(v *Venue, status int, body []byte, err error) string {
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "timeout"
		}
		return "net_error"
	}
	switch {
	case status >= 200 && status < 300:
		return "ok"
	case status == 429:
		return "throttled"
	case status >= 500:
		return "http_5xx"
	case status == 404:
		return "probe_invalid"
	default:
		for _, s := range v.InvalidBody {
			if strings.Contains(string(body), s) {
				return "probe_invalid"
			}
		}
		return "http_4xx"
	}
}

type probeResult struct {
	outcome string
	dur     float64
	ttfb    float64
	connect float64
	cache   string
	body    []byte
}

func probeOnce(ctx context.Context, client *http.Client, v *Venue, cl Class, conn string) probeResult {
	pctx, cancel := context.WithTimeout(ctx, cl.Timeout)
	defer cancel()

	res := probeResult{cache: "none"}
	var connectStart time.Time
	start := time.Now()
	trace := &httptrace.ClientTrace{
		ConnectStart: func(string, string) { connectStart = time.Now() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			if !connectStart.IsZero() {
				res.connect = time.Since(connectStart).Seconds()
			}
		},
		GotFirstResponseByte: func() { res.ttfb = time.Since(start).Seconds() },
	}
	url := cl.URL(v.pinOf(ctx))
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(pctx, trace), http.MethodGet, url, nil)
	if err != nil {
		res.outcome = "net_error"
		return res
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		res.outcome = classifyOutcome(v, 0, nil, err)
		if pctx.Err() == context.DeadlineExceeded {
			res.outcome = "timeout"
		}
		return res
	}
	defer resp.Body.Close()
	body, rerr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	res.dur = time.Since(start).Seconds()
	if rerr != nil {
		res.outcome = classifyOutcome(v, 0, nil, rerr)
		if pctx.Err() == context.DeadlineExceeded {
			res.outcome = "timeout"
		}
		return res
	}
	res.cache = classifyCache(resp.Header)
	res.outcome = classifyOutcome(v, resp.StatusCode, body, nil)
	res.body = body
	return res
}

// pinOf is a tiny indirection so probeOnce doesn't need venueState plumbed
// through; set per venue at startup.
func (v *Venue) pinOf(context.Context) Pin {
	if v.state == nil {
		return Pin{}
	}
	return v.state.getPin()
}

// warmLoop probes one (venue, class) on its cadence over a shared keep-alive
// pool. Deterministic-ish jitter at startup spreads the fleet.
func warmLoop(ctx context.Context, v *Venue, cl Class, st *venueState, client *http.Client) {
	time.Sleep(time.Duration(rand.Int63n(int64(cl.Interval))))
	t := time.NewTicker(cl.Interval)
	defer t.Stop()
	primary := v.Classes[0].Name
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pin := st.getPin()
		needsPin := strings.Contains(cl.URL(Pin{Market: "\x00", Token: "\x00"}), "\x00")
		if needsPin && pin.Market == "" {
			continue
		}
		if needsPin && !pin.Expiry.IsZero() && time.Now().After(pin.Expiry) {
			st.triggerRepin(pin.Market)
			continue
		}
		res := probeOnce(ctx, client, v, cl, "warm")
		reqTotal.WithLabelValues(v.Slug, cl.Name, currentRegion, "warm", res.outcome, sourceDirect).Inc()
		if res.outcome == "ok" {
			reqDuration.WithLabelValues(v.Slug, cl.Name, currentRegion, "warm", res.cache, sourceDirect).Observe(res.dur)
			reqTTFB.WithLabelValues(v.Slug, cl.Name, currentRegion, "warm", res.cache, sourceDirect).Observe(res.ttfb)
			if cl.Name == primary {
				st.addBaseline(res.dur)
			}
			if v.StalenessMs != nil {
				if ms, ok := v.StalenessMs(cl.Name, res.body); ok {
					age := float64(time.Now().UnixMilli()-ms) / 1000
					if age >= 0 && age < 86400 {
						bookStaleness.WithLabelValues(v.Slug, currentRegion, sourceDirect).Set(age)
					}
				}
			}
		}
		if cl.Name == primary {
			if res.outcome == "ok" {
				venueHealth.WithLabelValues(v.Slug, currentRegion, sourceDirect).Set(1)
			} else {
				venueHealth.WithLabelValues(v.Slug, currentRegion, sourceDirect).Set(0)
			}
		}
		if res.outcome == "probe_invalid" {
			st.triggerRepin(pin.Market)
		}
	}
}

// coldLoop measures fresh TCP+TLS handshakes once a minute on the primary
// class, with keep-alives disabled and a new transport each probe so nothing
// is reused.
func coldLoop(ctx context.Context, v *Venue, st *venueState) {
	time.Sleep(time.Duration(rand.Int63n(int64(time.Minute))))
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	cl := v.Classes[0]
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if st.getPin().Market == "" {
			continue
		}
		tr := &http.Transport{DisableKeepAlives: true}
		client := &http.Client{Transport: tr}
		res := probeOnce(ctx, client, v, cl, "cold")
		tr.CloseIdleConnections()
		reqTotal.WithLabelValues(v.Slug, cl.Name, currentRegion, "cold", res.outcome, sourceDirect).Inc()
		if res.outcome == "ok" {
			reqDuration.WithLabelValues(v.Slug, cl.Name, currentRegion, "cold", res.cache, sourceDirect).Observe(res.dur)
			reqTTFB.WithLabelValues(v.Slug, cl.Name, currentRegion, "cold", res.cache, sourceDirect).Observe(res.ttfb)
			if res.connect > 0 {
				reqConnect.WithLabelValues(v.Slug, currentRegion, sourceDirect).Observe(res.connect)
			}
		}
	}
}

// aggregatorLoop probes one (venue, source) pair on its cadence via the
// aggregator's URL builder, stamping source=<provider> on every metric.
// Reuses the venueState's pin so the aggregator hits exactly the same
// market the direct probes do — every regression has to be apples to
// apples. AuthMutator stamps the credential header; Throttle (Predexon's
// 1 rps global bucket) blocks before the request when set.
func aggregatorLoop(ctx context.Context, ps ProbeSource, st *venueState, client *http.Client) {
	time.Sleep(time.Duration(rand.Int63n(int64(ps.Interval))))
	t := time.NewTicker(ps.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pin := st.getPin()
		if pin.Market == "" && pin.Token == "" {
			continue
		}
		if !pin.Expiry.IsZero() && time.Now().After(pin.Expiry) {
			continue
		}
		if ps.Throttle != nil {
			ps.Throttle()
		}
		res := aggregatorProbeOnce(ctx, client, ps, pin)
		reqTotal.WithLabelValues(ps.Venue, ps.Class, currentRegion, "warm", res.outcome, ps.Source).Inc()
		if res.outcome == "ok" {
			reqDuration.WithLabelValues(ps.Venue, ps.Class, currentRegion, "warm", res.cache, ps.Source).Observe(res.dur)
			reqTTFB.WithLabelValues(ps.Venue, ps.Class, currentRegion, "warm", res.cache, ps.Source).Observe(res.ttfb)
			venueHealth.WithLabelValues(ps.Venue, currentRegion, ps.Source).Set(1)
		} else {
			venueHealth.WithLabelValues(ps.Venue, currentRegion, ps.Source).Set(0)
		}
	}
}

func aggregatorProbeOnce(ctx context.Context, client *http.Client, ps ProbeSource, pin Pin) probeResult {
	pctx, cancel := context.WithTimeout(ctx, ps.Timeout)
	defer cancel()

	res := probeResult{cache: "none"}
	var connectStart time.Time
	start := time.Now()
	trace := &httptrace.ClientTrace{
		ConnectStart: func(string, string) { connectStart = time.Now() },
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			if !connectStart.IsZero() {
				res.connect = time.Since(connectStart).Seconds()
			}
		},
		GotFirstResponseByte: func() { res.ttfb = time.Since(start).Seconds() },
	}
	method := http.MethodGet
	var bodyReader io.Reader
	if strings.EqualFold(ps.Method, "POST") && ps.BodyFunc != nil {
		body := ps.BodyFunc(pin)
		if body == nil {
			// Missing identifier on the pin (e.g. Codex Polymarket
			// without a conditionId yet). Skip instead of POSTing an
			// empty query — it would just burn quota for nothing.
			res.outcome = "probe_invalid"
			return res
		}
		method = http.MethodPost
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(pctx, trace), method, ps.URL(pin), bodyReader)
	if err != nil {
		res.outcome = "net_error"
		return res
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if ps.ContentType != "" {
		req.Header.Set("Content-Type", ps.ContentType)
	}
	if ps.AuthMutator != nil {
		ps.AuthMutator(req)
	}

	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || pctx.Err() == context.DeadlineExceeded {
			res.outcome = "timeout"
		} else {
			res.outcome = "net_error"
		}
		return res
	}
	defer resp.Body.Close()
	body, rerr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	res.dur = time.Since(start).Seconds()
	if rerr != nil {
		if pctx.Err() == context.DeadlineExceeded {
			res.outcome = "timeout"
		} else {
			res.outcome = "net_error"
		}
		return res
	}
	res.cache = classifyCache(resp.Header)
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		// Codex (GraphQL) answers 200 even on errors; an "errors" key in
		// the payload means the query was rejected (auth, schema, etc.)
		// and the latency we just measured is the upstream's failure
		// path, not a hit. Bucket as http_4xx so it doesn't poison the
		// "ok" duration histogram.
		if ps.Source == "codex" && bytes.Contains(body, []byte(`"errors"`)) {
			res.outcome = "http_4xx"
			// One-shot debug: surface the first failing response body so we
			// can tell tier-gate (NOT_AUTHORIZED) from marketId or schema
			// issues. Rate-limited to at most once per minute per
			// (venue, region) to avoid log flooding.
			codexErrorLogOnce(ps.Venue, currentRegion, body)
		} else {
			res.outcome = "ok"
		}
	case resp.StatusCode == 429:
		res.outcome = "throttled"
	case resp.StatusCode >= 500:
		res.outcome = "http_5xx"
	case resp.StatusCode == 404:
		res.outcome = "probe_invalid"
	default:
		res.outcome = "http_4xx"
	}
	res.body = body
	return res
}

// repinLoop re-pins on probe_invalid, debounced to once per 5 minutes so a
// flapping endpoint can't turn the pinner into a crawler.
func repinLoop(ctx context.Context, v *Venue, st *venueState, client *http.Client) {
	for {
		var failed string
		select {
		case <-ctx.Done():
			return
		case failed = <-st.repinCh:
		}
		st.mu.Lock()
		recent := time.Since(st.lastRepin) < 5*time.Minute
		if !recent {
			st.lastRepin = time.Now()
		}
		st.mu.Unlock()
		if recent {
			continue
		}
		pin, err := v.PinFunc(ctx, client, failed)
		if err != nil {
			log.Printf("[pin][%s] re-pin failed (was %q): %v", v.Slug, failed, err)
			continue
		}
		st.setPin(pin)
		log.Printf("[pin][%s] re-pinned %q -> %q (expiry %s)", v.Slug, failed, pin.Market, pin.Expiry.Format(time.RFC3339))
	}
}
