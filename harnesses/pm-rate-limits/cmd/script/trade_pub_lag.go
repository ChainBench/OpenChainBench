package main

// Kalshi correlation state + REST poller for trade pub lag.
// Polymarket pub lag is computed inline in wsSession (timestamp in WS frame).

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

type wsTickerEvent struct {
	priceCents int
	recvAt     time.Time
}

var kalshiWSTickerState = struct {
	mu    sync.Mutex
	byMkt map[string][]wsTickerEvent
}{byMkt: map[string][]wsTickerEvent{}}

func recordKalshiWSTick(mkt string, priceCents int, recvAt time.Time) {
	kalshiWSTickerState.mu.Lock()
	defer kalshiWSTickerState.mu.Unlock()
	cutoff := recvAt.Add(-30 * time.Second)
	existing := kalshiWSTickerState.byMkt[mkt]
	pruned := existing[:0]
	for _, e := range existing {
		if e.recvAt.After(cutoff) {
			pruned = append(pruned, e)
		}
	}
	kalshiWSTickerState.byMkt[mkt] = append(pruned, wsTickerEvent{priceCents: priceCents, recvAt: recvAt})
}

func findKalshiWSMatch(mkt string, priceCents int, createDate time.Time) (time.Time, bool) {
	kalshiWSTickerState.mu.Lock()
	defer kalshiWSTickerState.mu.Unlock()
	lo := createDate.Add(-2 * time.Second)
	hi := createDate.Add(15 * time.Second)
	for _, e := range kalshiWSTickerState.byMkt[mkt] {
		if e.priceCents == priceCents && e.recvAt.After(lo) && e.recvAt.Before(hi) {
			return e.recvAt, true
		}
	}
	return time.Time{}, false
}

func runKalshiTradeRestPoll(ctx context.Context, st *venueState) {
	if currentRegion != "us-east" {
		return
	}
	client := &http.Client{Timeout: 8 * time.Second}
	seen := map[string]struct{}{}
	var seenOrder []string

	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}

		pin := st.getPin()
		if pin.Market == "" {
			continue
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.elections.kalshi.com/v1/social/trades", nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", userAgent)

		resp, err := client.Do(req)
		if err != nil {
			continue
		}

		var body struct {
			Trades []struct {
				TradeID    string `json:"trade_id"`
				Ticker     string `json:"ticker"`
				Price      int    `json:"price"`
				CreateDate string `json:"create_date"`
			} `json:"trades"`
			Cursor string `json:"cursor"`
		}
		if json.NewDecoder(resp.Body).Decode(&body) != nil {
			resp.Body.Close()
			continue
		}
		resp.Body.Close()

		for _, t := range body.Trades {
			if _, dup := seen[t.TradeID]; dup {
				continue
			}
			seen[t.TradeID] = struct{}{}
			seenOrder = append(seenOrder, t.TradeID)
			if len(seenOrder) > 4096 {
				delete(seen, seenOrder[0])
				seenOrder = seenOrder[1:]
			}

			if !strings.EqualFold(t.Ticker, pin.Market) {
				continue
			}
			createDate, err := time.Parse(time.RFC3339Nano, t.CreateDate)
			if err != nil {
				continue
			}
			recvAt, ok := findKalshiWSMatch(t.Ticker, t.Price, createDate)
			if !ok {
				continue
			}
			delta := recvAt.Sub(createDate).Seconds()
			if delta >= 0 && delta <= 30 {
				wsTradePublishLag.WithLabelValues("kalshi", currentRegion, sourceDirect).Observe(delta)
			}
		}
	}
}
