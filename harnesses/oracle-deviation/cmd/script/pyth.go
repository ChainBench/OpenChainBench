package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Pyth Hermes REST poller. Hermes' batch endpoint accepts multiple
// ids[] params per request, so we ask for all 10 prices in a single
// HTTP call per tick. Soft rate-limit is ~30 req/s; one batch every
// 30 s is well under that.

const hermesBatchURL = "https://hermes.pyth.network/api/latest_price_feeds"

type hermesEntry struct {
	ID    string `json:"id"`
	Price struct {
		Price       string `json:"price"`
		Conf        string `json:"conf"`
		Expo        int    `json:"expo"`
		PublishTime int64  `json:"publish_time"`
	} `json:"price"`
}

func runPyth(ctx context.Context, specs []PairSpec) {
	client := &http.Client{Timeout: httpTimeout}
	// Map from id (lowercase, no 0x) -> pair. Hermes echoes ids without
	// the 0x prefix in the response.
	idToPair := make(map[string]Pair, len(specs))
	q := url.Values{}
	for _, s := range specs {
		bare := s.PythID
		if len(bare) >= 2 && bare[:2] == "0x" {
			bare = bare[2:]
		}
		idToPair[bare] = s.Pair
		q.Add("ids[]", bare)
	}
	reqURL := hermesBatchURL + "?" + q.Encode()

	t := time.NewTicker(pollInterval)
	defer t.Stop()

	tick := func() {
		pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
		defer cancel()
		req, _ := http.NewRequestWithContext(pollCtx, "GET", reqURL, nil)
		resp, err := client.Do(req)
		if err != nil {
			for _, s := range specs {
				oracleScrapeErrors.WithLabelValues(string(SourcePyth), string(s.Pair)).Inc()
			}
			fmt.Printf("[pyth] http err: %v\n", err)
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			for _, s := range specs {
				oracleScrapeErrors.WithLabelValues(string(SourcePyth), string(s.Pair)).Inc()
			}
			fmt.Printf("[pyth] http %d: %s\n", resp.StatusCode, string(body))
			return
		}
		var entries []hermesEntry
		if err := json.Unmarshal(body, &entries); err != nil {
			for _, s := range specs {
				oracleScrapeErrors.WithLabelValues(string(SourcePyth), string(s.Pair)).Inc()
			}
			fmt.Printf("[pyth] decode err: %v\n", err)
			return
		}
		got := make(map[Pair]bool)
		for _, e := range entries {
			pair, ok := idToPair[e.ID]
			if !ok {
				continue
			}
			price, err := pythToFloat(e.Price.Price, e.Price.Expo)
			if err != nil {
				oracleScrapeErrors.WithLabelValues(string(SourcePyth), string(pair)).Inc()
				continue
			}
			recordPrice(SourcePyth, pair, price)
			got[pair] = true
		}
		// Mark missing pairs as errored so the deviation map doesn't
		// silently freeze on a stale value.
		for _, s := range specs {
			if !got[s.Pair] {
				oracleScrapeErrors.WithLabelValues(string(SourcePyth), string(s.Pair)).Inc()
			}
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// pythToFloat applies the per-feed exponent: real = price × 10^expo.
// Pyth prices ship as a stringified int64 with a signed exponent
// (typically -8). float64 precision is fine across the range we care
// about (sub-cent for ADA, low-hundred-thousand for BTC).
func pythToFloat(priceStr string, expo int) (float64, error) {
	n, err := strconv.ParseInt(priceStr, 10, 64)
	if err != nil {
		return 0, err
	}
	return float64(n) * math.Pow10(expo), nil
}

// silence unused warnings in case future trimming.
var _ = fmt.Sprintf
