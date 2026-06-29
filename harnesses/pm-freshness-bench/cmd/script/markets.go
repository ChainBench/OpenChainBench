package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// A market we subscribe to across every provider. Each Polymarket market
// has a conditionId (0x-prefixed hex) shared by both outcomes, and a pair
// of clobTokenIds (decimal strings) — one per Yes/No outcome.
// For Kalshi the ConditionId field holds the market_ticker and ClobTokenIds
// is empty — the rest of the pipeline only needs ConditionId for matching.
type Market struct {
	Slug         string
	ConditionId  string   // Polymarket conditionId OR Kalshi market_ticker (lowercased)
	ClobTokenIds []string // 2 ids, the Polymarket WS `asset_id` per outcome (Polymarket only)
	Vol24h       float64
}

var (
	basketMu     sync.RWMutex
	basket       []Market // Polymarket basket
	kalshiBasket []Market
)

// currentBasket returns a snapshot of the currently-subscribed Polymarket
// markets. Callers should treat the slice as read-only.
func currentBasket() []Market {
	basketMu.RLock()
	defer basketMu.RUnlock()
	out := make([]Market, len(basket))
	copy(out, basket)
	return out
}

// currentKalshiBasket returns a snapshot of the currently-subscribed Kalshi
// markets. Same read-only contract as currentBasket.
func currentKalshiBasket() []Market {
	basketMu.RLock()
	defer basketMu.RUnlock()
	out := make([]Market, len(kalshiBasket))
	copy(out, kalshiBasket)
	return out
}

// refreshLoop polls gamma-api on an interval and updates the shared basket.
// Connections are not torn down here — providers re-subscribe diff-style
// on every refresh (see their respective files).
func refreshLoop(ctx context.Context, every time.Duration, size int, onChange func([]Market)) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	if err := refreshBasket(ctx, size, onChange); err != nil {
		appendLog("[markets] initial refresh err: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := refreshBasket(ctx, size, onChange); err != nil {
				appendLog("[markets] refresh err: %v", err)
			}
		}
	}
}

func refreshBasket(ctx context.Context, size int, onChange func([]Market)) error {
	url := fmt.Sprintf("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=%d", size)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("gamma-api status=%d", resp.StatusCode)
	}
	var raw []struct {
		Slug           string  `json:"slug"`
		ConditionId    string  `json:"conditionId"`
		ClobTokenIds   string  `json:"clobTokenIds"` // JSON-encoded array of strings
		Volume24hr     float64 `json:"volume24hr"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return err
	}
	out := make([]Market, 0, len(raw))
	for _, r := range raw {
		if r.ConditionId == "" || r.ClobTokenIds == "" {
			continue
		}
		var ids []string
		if err := json.Unmarshal([]byte(r.ClobTokenIds), &ids); err != nil {
			continue
		}
		if len(ids) < 2 {
			continue
		}
		out = append(out, Market{
			Slug:         r.Slug,
			ConditionId:  strings.ToLower(r.ConditionId),
			ClobTokenIds: ids,
			Vol24h:       r.Volume24hr,
		})
	}

	basketMu.Lock()
	basket = out
	basketMu.Unlock()
	basketSize.WithLabelValues("polymarket").Set(float64(len(out)))
	appendLog("[markets] refreshed basket: %d markets, top vol=$%.0fk", len(out), firstVol(out)/1000)
	if onChange != nil {
		onChange(out)
	}
	return nil
}

func firstVol(ms []Market) float64 {
	if len(ms) == 0 {
		return 0
	}
	return ms[0].Vol24h
}

// refreshKalshiLoop mirrors refreshLoop for Kalshi. Kalshi's public markets
// endpoint is a separate host so we drive it on its own goroutine.
func refreshKalshiLoop(ctx context.Context, every time.Duration, size int, onChange func([]Market)) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	if err := refreshKalshiBasket(ctx, size, onChange); err != nil {
		appendLog("[kalshi-markets] initial refresh err: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := refreshKalshiBasket(ctx, size, onChange); err != nil {
				appendLog("[kalshi-markets] refresh err: %v", err)
			}
		}
	}
}

func refreshKalshiBasket(ctx context.Context, size int, onChange func([]Market)) error {
	// Kalshi's elections host is the public unauthenticated read endpoint.
	// We pull a wider page than `size` because the API doesn't expose a
	// sort-by-volume parameter — we rank client-side and trim.
	url := "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=200"
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("kalshi markets status=%d", resp.StatusCode)
	}
	var raw struct {
		Markets []struct {
			Ticker    string  `json:"ticker"`
			Volume24h float64 `json:"volume_24h"`
			Volume    float64 `json:"volume"`
			LastPrice float64 `json:"last_price"`
		} `json:"markets"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return err
	}
	// Rank by 24h volume when available, fall back to all-time volume.
	type scored struct {
		Market
		score float64
	}
	scoredList := make([]scored, 0, len(raw.Markets))
	for _, r := range raw.Markets {
		if r.Ticker == "" {
			continue
		}
		s := r.Volume24h
		if s == 0 {
			s = r.Volume
		}
		scoredList = append(scoredList, scored{
			Market: Market{
				Slug:        r.Ticker,
				ConditionId: strings.ToLower(r.Ticker),
				Vol24h:      r.Volume24h,
			},
			score: s,
		})
	}
	sort.Slice(scoredList, func(i, j int) bool { return scoredList[i].score > scoredList[j].score })
	if len(scoredList) > size {
		scoredList = scoredList[:size]
	}
	out := make([]Market, len(scoredList))
	for i, s := range scoredList {
		out[i] = s.Market
	}

	basketMu.Lock()
	kalshiBasket = out
	basketMu.Unlock()
	basketSize.WithLabelValues("kalshi").Set(float64(len(out)))
	appendLog("[kalshi-markets] refreshed basket: %d markets, top vol24h=$%.0fk", len(out), firstVol(out)/1000)
	if onChange != nil {
		onChange(out)
	}
	return nil
}
