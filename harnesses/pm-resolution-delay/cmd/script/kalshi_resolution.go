package main

// Kalshi resolution delay poller.
//
// Unlike Polymarket (UMA on-chain events, 2h floor), Kalshi resolves via its
// own internal process. Delay is measured as:
//   settlement_ts - market.close_time
//
// settlement_ts is returned directly by the Kalshi API (exact, no polling error).
// No auth required — uses the public /trade-api/v2/markets endpoint.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	kalshiMarketsURL   = "https://api.elections.kalshi.com/trade-api/v2/markets"
	kalshiLookbackDays = 30
)

type kalshiMarketRecord struct {
	Ticker       string `json:"ticker"`
	Title        string `json:"title"`
	CloseTime    string `json:"close_time"`    // RFC3339
	SettlementTs string `json:"settlement_ts"` // RFC3339Nano, present when settled
	Status       string `json:"status"`        // "open", "closed", "finalized"
	Result       string `json:"result"`        // "yes", "no", "" when unresolved
	Category     string `json:"category"`      // "Sports", "Politics", "Crypto", etc.
}

type kalshiMarketsResponse struct {
	Markets []kalshiMarketRecord `json:"markets"`
	Cursor  string               `json:"cursor"`
}

type kalshiTracker struct {
	mu       sync.Mutex
	watched  map[string]time.Time // ticker → close_time (markets we're watching)
	recorded map[string]struct{}  // tickers already emitted to histogram
	client   *http.Client
}

func newKalshiTracker() *kalshiTracker {
	return &kalshiTracker{
		watched:  make(map[string]time.Time),
		recorded: make(map[string]struct{}),
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

func (k *kalshiTracker) fetchPage(status, cursor string) ([]kalshiMarketRecord, string, error) {
	req, err := http.NewRequest(http.MethodGet, kalshiMarketsURL, nil)
	if err != nil {
		return nil, "", err
	}
	q := req.URL.Query()
	q.Set("limit", "200")
	q.Set("status", status)
	q.Set("order", "close_time")
	q.Set("ascending", "false")
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	req.URL.RawQuery = q.Encode()
	req.Header.Set("User-Agent", userAgent)

	resp, err := k.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", nil
	}
	var body kalshiMarketsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, "", err
	}
	return body.Markets, body.Cursor, nil
}

// normalizeKalshiCategory maps Kalshi's category strings to lowercase slugs
// comparable to Polymarket's categories.
func normalizeKalshiCategory(raw string) string {
	switch strings.ToLower(raw) {
	case "sports":
		return "sports"
	case "politics":
		return "politics"
	case "crypto", "cryptocurrency":
		return "crypto"
	case "economics", "finance":
		return "other"
	default:
		return "other"
	}
}

// pollClosed fetches recently closed (unresolved) markets and adds them to
// the watch list so we notice when they become finalized.
func (k *kalshiTracker) pollClosed() {
	cutoff := time.Now().Add(-kalshiLookbackDays * 24 * time.Hour)
	markets, _, err := k.fetchPage("closed", "")
	if err != nil {
		log.Printf("[kalshi-res] pollClosed error: %v", err)
		return
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, m := range markets {
		ct, err := time.Parse(time.RFC3339, m.CloseTime)
		if err != nil {
			continue
		}
		if ct.Before(cutoff) {
			break
		}
		if _, ok := k.watched[m.Ticker]; !ok {
			k.watched[m.Ticker] = ct
		}
	}
}

// pollFinalized fetches recently settled markets and emits histogram
// observations for any we haven't recorded yet. The API filter param is
// "settled"; the status field in the response body is "finalized".
// Delay is settlement_ts - close_time (exact, from API, no polling error).
func (k *kalshiTracker) pollFinalized() {
	cutoff := time.Now().Add(-kalshiLookbackDays * 24 * time.Hour)

	markets, _, err := k.fetchPage("settled", "")
	if err != nil {
		log.Printf("[kalshi-res] pollFinalized error: %v", err)
		return
	}

	k.mu.Lock()
	defer k.mu.Unlock()
	for _, m := range markets {
		ct, err := time.Parse(time.RFC3339, m.CloseTime)
		if err != nil {
			continue
		}
		if ct.Before(cutoff) {
			break
		}
		if _, done := k.recorded[m.Ticker]; done {
			continue
		}
		if m.Result == "" {
			continue
		}
		k.recorded[m.Ticker] = struct{}{}
		delete(k.watched, m.Ticker)

		// Prefer settlement_ts (exact); fall back to now (first-poll proxy, ±5 min).
		var settleAt time.Time
		if m.SettlementTs != "" {
			settleAt, _ = time.Parse(time.RFC3339Nano, m.SettlementTs)
		}
		if settleAt.IsZero() {
			settleAt = time.Now()
		}
		delay := settleAt.Sub(ct).Seconds()
		if delay < 0 || delay > float64(kalshiLookbackDays*24*3600) {
			continue
		}
		cat := normalizeKalshiCategory(m.Category)
		resolutionDelay.WithLabelValues("kalshi", cat, "false").Observe(delay)
		resolutionsTotal.WithLabelValues("kalshi", cat, "false").Inc()
		log.Printf("[kalshi-res] resolved ticker=%s category=%s delay=%.0fs close_time=%s settled=%s result=%s",
			m.Ticker, cat, delay, m.CloseTime, settleAt.UTC().Format(time.RFC3339), m.Result)
	}
}

func runKalshiResolutionLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()

	tracker := newKalshiTracker()
	// Prime the watch list immediately on startup.
	tracker.pollClosed()
	tracker.pollFinalized()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tracker.pollClosed()
			tracker.pollFinalized()
		}
	}
}
