package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// L2Beat's TVS chart per project, free and keyless. The change of the
// bridged part (canonical plus external, native excluded) over 24h and 7d
// is the net value that entered or left the L2 through its bridges, in
// USD at each point's own prices, so a price move shows up in it as well;
// the spec says so.
const l2beatTvsURL = "https://l2beat.com/api/scaling/tvs/%s?range=30d"

var l2beatHTTP = &http.Client{Timeout: 30 * time.Second}

type l2beatChart struct {
	Success bool `json:"success"`
	Data    struct {
		Chart struct {
			Types []string    `json:"types"`
			Data  [][]float64 `json:"data"`
		} `json:"chart"`
	} `json:"data"`
}

func pollL2Beat(ctx context.Context, chains []Chain) {
	for _, c := range chains {
		if c.L2Beat == "" {
			continue
		}
		if err := pollL2BeatOne(ctx, c); err != nil {
			log.Printf("[l2beat] %s: %v", c.Slug, err)
		}
	}
	l2beatLastTick.Set(float64(time.Now().Unix()))
}

func pollL2BeatOne(ctx context.Context, c Chain) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(l2beatTvsURL, c.L2Beat), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "OpenChainBench-bridge-flows/1.0 (+https://openchainbench.com)")
	resp, err := l2beatHTTP.Do(req)
	if err != nil {
		sourceFetches.WithLabelValues("l2beat", "transport").Inc()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		sourceFetches.WithLabelValues("l2beat", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var ch l2beatChart
	if err := json.Unmarshal(raw, &ch); err != nil {
		sourceFetches.WithLabelValues("l2beat", "decode").Inc()
		return err
	}
	pts := ch.Data.Chart.Data
	types := ch.Data.Chart.Types
	if !ch.Success || len(pts) < 2 || len(types) < 4 || types[0] != "timestamp" || types[2] != "canonical" || types[3] != "external" {
		sourceFetches.WithLabelValues("l2beat", "shape").Inc()
		return fmt.Errorf("unexpected chart shape %v (%d points)", types, len(pts))
	}
	sourceFetches.WithLabelValues("l2beat", "ok").Inc()
	last := pts[len(pts)-1]
	bridged := func(p []float64) float64 { return p[2] + p[3] }
	// The chart is stepped (a few hours per point on the 30d range); take
	// the newest point at or before the target time.
	at := func(back time.Duration) ([]float64, bool) {
		target := last[0] - back.Seconds()
		var best []float64
		for _, p := range pts {
			if p[0] <= target {
				best = p
			}
		}
		return best, best != nil
	}
	l2Bridged.WithLabelValues(c.Slug).Set(bridged(last))
	l2AsOf.WithLabelValues(c.Slug).Set(last[0])
	for window, back := range map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour} {
		if p, ok := at(back); ok {
			l2TvsChange.WithLabelValues(c.Slug, window).Set(bridged(last) - bridged(p))
		} else {
			l2TvsChange.DeleteLabelValues(c.Slug, window)
		}
	}
	return nil
}
