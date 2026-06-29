package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Daily rate-limit ramp ("crash test"). One run per venue per day, regions on
// disjoint UTC hours so two regions never load a venue at the same time.
// Tiers run 60s each at RampRates[i] requests per 10s window. The honest
// signal is added latency vs the same-hour warm baseline: Cloudflare in front
// of Polymarket queues instead of returning 429.
var rampHourByRegion = map[string]int{
	"us-east": 2,
	"eu-west": 4,
	"sgp":     6,
}

const (
	tierDuration    = 60 * time.Second
	abortBadRatio   = 0.01 // throttled+5xx per 10s window
	minBaselineN    = 30
	rampTimeout     = 8 * time.Second
	venueStaggerMin = 12
)

func rampHour() int {
	if v := os.Getenv("RAMP_HOUR_UTC"); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h >= 0 && h <= 23 {
			return h
		}
	}
	if h, ok := rampHourByRegion[currentRegion]; ok {
		return h
	}
	return 4
}

func rampLoop(ctx context.Context, vs []*Venue) {
	if os.Getenv("RAMP_DISABLED") == "1" {
		log.Printf("[ramp] disabled via RAMP_DISABLED=1")
		return
	}
	hour := rampHour()
	log.Printf("[ramp] scheduled daily at %02d:00 UTC (region %s), venues staggered %d min apart", hour, currentRegion, venueStaggerMin)
	lastRun := map[string]string{}
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now().UTC()
		if now.Hour() != hour {
			continue
		}
		idx := 0
		for _, v := range vs {
			if v.RampRates == nil {
				continue
			}
			startMin := idx * venueStaggerMin
			idx++
			today := now.Format("2006-01-02")
			if now.Minute() < startMin || now.Minute() >= startMin+venueStaggerMin || lastRun[v.Slug] == today {
				continue
			}
			lastRun[v.Slug] = today
			runRamp(ctx, v)
		}
	}
}

func runRamp(ctx context.Context, v *Venue) {
	st := v.state
	baseP50, n := st.baselineP50()
	if n < minBaselineN {
		log.Printf("[ramp][%s] skipped: only %d baseline samples in the last hour (need %d)", v.Slug, n, minBaselineN)
		return
	}
	pin := st.getPin()
	if pin.Market == "" {
		log.Printf("[ramp][%s] skipped: no pinned market", v.Slug)
		return
	}
	cl := v.Classes[0]
	url := cl.URL(pin)
	client := &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 32}}
	log.Printf("[ramp][%s] start, baseline p50=%.0fms (n=%d), target %s", v.Slug, baseP50*1000, n, url)

	for _, rate := range v.RampRates {
		tier := fmt.Sprintf("%dper10s", rate)
		interval := 10 * time.Second / time.Duration(rate)
		var (
			mu        sync.Mutex
			durations []float64
			wg        sync.WaitGroup
			aborted   atomic.Bool
			winTotal  atomic.Int64
			winBad    atomic.Int64
		)
		tick := time.NewTicker(interval)
		winStart := time.Now()
		deadline := time.Now().Add(tierDuration)
		for time.Now().Before(deadline) && !aborted.Load() && ctx.Err() == nil {
			<-tick.C
			if time.Since(winStart) >= 10*time.Second {
				tot, bad := winTotal.Swap(0), winBad.Swap(0)
				winStart = time.Now()
				if tot > 0 && float64(bad)/float64(tot) > abortBadRatio {
					aborted.Store(true)
					log.Printf("[ramp][%s][%s] ABORT: %d/%d throttled+5xx in 10s window", v.Slug, tier, bad, tot)
					break
				}
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				outcome, dur := rampRequest(ctx, client, v, url)
				rampTotal.WithLabelValues(v.Slug, currentRegion, tier, outcome, sourceDirect).Inc()
				winTotal.Add(1)
				switch outcome {
				case "ok":
					rampDuration.WithLabelValues(v.Slug, currentRegion, tier, sourceDirect).Observe(dur)
					mu.Lock()
					durations = append(durations, dur)
					mu.Unlock()
				case "throttled":
					winBad.Add(1)
					if v.StopOn429 {
						aborted.Store(true)
						log.Printf("[ramp][%s][%s] ABORT: 429 with StopOn429", v.Slug, tier)
					}
				case "http_5xx":
					winBad.Add(1)
				}
			}()
		}
		tick.Stop()
		wg.Wait()
		mu.Lock()
		sort.Float64s(durations)
		if len(durations) > 0 {
			p50 := durations[len(durations)/2]
			rampAdded.WithLabelValues(v.Slug, currentRegion, tier, sourceDirect).Set(p50 - baseP50)
			log.Printf("[ramp][%s][%s] done: n=%d p50=%.0fms added=%.0fms", v.Slug, tier, len(durations), p50*1000, (p50-baseP50)*1000)
		}
		mu.Unlock()
		if aborted.Load() {
			log.Printf("[ramp][%s] aborted at tier %s, skipping higher tiers", v.Slug, tier)
			break
		}
	}
	client.CloseIdleConnections()
}

func rampRequest(ctx context.Context, client *http.Client, v *Venue, url string) (string, float64) {
	rctx, cancel := context.WithTimeout(ctx, rampTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, url, nil)
	if err != nil {
		return "net_error", 0
	}
	req.Header.Set("User-Agent", userAgent)
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return classifyOutcome(v, 0, nil, err), 0
	}
	defer resp.Body.Close()
	var body []byte
	if resp.StatusCode >= 400 {
		body, _ = io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	} else {
		_, _ = io.Copy(io.Discard, resp.Body)
	}
	dur := time.Since(start).Seconds()
	return classifyOutcome(v, resp.StatusCode, body, nil), dur
}
