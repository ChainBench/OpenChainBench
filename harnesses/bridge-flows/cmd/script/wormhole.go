package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"time"
)

// Wormholescan publishes, free and keyless, the volume that left each
// chain over Wormhole per UTC day. Values are USD scaled by 1e8: on
// 2026-09-23 the per-chain rows summed to about $35M against the
// scorecards' rolling 24h volume of $50M (api/v1/scorecards), the same
// order of magnitude, and the scale matches Wormholescan's own displays.
const wormholeURL = "https://api.wormholescan.io/api/v1/x-chain-activity/tops?timespan=1d&from=%s&to=%s"

var wormholeHTTP = &http.Client{Timeout: 30 * time.Second}

// Chains published on the last poll, so vanished ones are deleted without
// blanking the whole vector.
var wormholeSeen = map[string]bool{}

type wormholeRow struct {
	From         string  `json:"from"`
	To           string  `json:"to"`
	EmitterChain string  `json:"emitter_chain"`
	Volume       float64 `json:"volume"`
	Count        int64   `json:"count"`
}

// pollWormhole publishes per-chain outbound volume over the last complete
// UTC day (window 24h) and the last 7 complete days (window 7d).
func pollWormhole(ctx context.Context) error {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from := today.AddDate(0, 0, -7)
	url := fmt.Sprintf(wormholeURL, from.Format(time.RFC3339), today.Format(time.RFC3339))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "OpenChainBench-bridge-flows/1.0 (+https://openchainbench.com)")
	resp, err := wormholeHTTP.Do(req)
	if err != nil {
		sourceFetches.WithLabelValues("wormhole", "transport").Inc()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		sourceFetches.WithLabelValues("wormhole", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		return fmt.Errorf("wormholescan http %d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var rows []wormholeRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		sourceFetches.WithLabelValues("wormhole", "decode").Inc()
		return err
	}
	sourceFetches.WithLabelValues("wormhole", "ok").Inc()
	todayKey := today.Format("2006-01-02")
	yesterday := today.AddDate(0, 0, -1).Format("2006-01-02")
	v24 := map[string]float64{}
	v7 := map[string]float64{}
	days := map[string]bool{}
	haveYesterday := false
	for _, r := range rows {
		day := ""
		if t, err := time.Parse(time.RFC3339, r.From); err == nil {
			day = t.UTC().Format("2006-01-02")
		} else if len(r.From) >= 10 {
			day = r.From[:10]
		}
		if day == "" || day >= todayKey {
			continue // the open day never enters a complete-day sum
		}
		slug, ok := wormholeSlug[r.EmitterChain]
		if !ok {
			slug = "wormhole-" + r.EmitterChain
		}
		usd := r.Volume / 1e8
		days[day] = true
		v7[slug] += usd
		if day == yesterday {
			v24[slug] += usd
			haveYesterday = true
		}
	}
	if len(days) < 7 {
		log.Printf("[wormhole] only %d of 7 days returned; 7d sums cover those days", len(days))
	}
	// Replace, never blank: drop chains that vanished, then set the rest.
	// The 24h series is absent (not zero) until Wormholescan has
	// materialized yesterday's bucket.
	for slug := range wormholeSeen {
		if _, ok := v7[slug]; !ok {
			wormholeVolume.DeleteLabelValues(slug, "7d")
			wormholeVolume.DeleteLabelValues(slug, "24h")
			delete(wormholeSeen, slug)
		}
	}
	for slug, usd := range v7 {
		wormholeSeen[slug] = true
		wormholeVolume.WithLabelValues(slug, "7d").Set(usd)
		if haveYesterday {
			wormholeVolume.WithLabelValues(slug, "24h").Set(v24[slug])
		} else {
			wormholeVolume.DeleteLabelValues(slug, "24h")
		}
	}
	wormholeDays.Set(float64(len(days)))
	wormholeLastTick.Set(float64(time.Now().Unix()))
	top := make([]string, 0, len(v24))
	for s := range v24 {
		top = append(top, s)
	}
	sort.Slice(top, func(i, j int) bool { return v24[top[i]] > v24[top[j]] })
	if len(top) > 3 {
		top = top[:3]
	}
	log.Printf("[wormhole] %d chains, day %s (present=%v), top: %v", len(v7), yesterday, haveYesterday, top)
	return nil
}
