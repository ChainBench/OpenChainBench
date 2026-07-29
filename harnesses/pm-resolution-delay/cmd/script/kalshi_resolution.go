package main

// Kalshi resolution delay poller.
//
// Kalshi resolves via its own internal process (no onchain oracle).
// Delay = settlement_ts - close_time (both from the public API, exact).
//
// Exotics filter (auto-generated multivariate parlays):
//   Exotics auto-settle so fast they skip the "closed" state entirely —
//   they go from open → finalized within seconds.  pollClosed() uses
//   status=closed, which never returns Exotics, so the watched map is
//   naturally Exotics-free.  pollFinalized() emits only for watched
//   markets, so Exotics can never appear in the histogram.
//
// Category: the /markets endpoint has no category field. We look it up
// lazily from /events/{event_ticker} (in-memory cache, stable forever).
//
// No auth required — uses the public /trade-api/v2 endpoints.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	kalshiMarketsURL   = "https://api.elections.kalshi.com/trade-api/v2/markets"
	kalshiEventsURL    = "https://api.elections.kalshi.com/trade-api/v2/events"
	kalshiLookbackDays = 30
)

type kalshiMarketRecord struct {
	Ticker       string `json:"ticker"`
	Title        string `json:"title"`
	CloseTime    string `json:"close_time"`    // RFC3339
	SettlementTs string `json:"settlement_ts"` // RFC3339Nano, present when settled
	EventTicker  string `json:"event_ticker"`  // parent event, used to look up category
	Status       string `json:"status"`
	Result       string `json:"result"` // "yes", "no", "" when unresolved
}

type kalshiMarketsResponse struct {
	Markets []kalshiMarketRecord `json:"markets"`
	Cursor  string               `json:"cursor"`
}

// kalshiWatched holds the metadata stored when a market enters pollClosed.
type kalshiWatched struct {
	closeTime   time.Time
	eventTicker string
}

// kalshiCategoryCache lazily fetches and caches event_ticker → category
// from /events/{event_ticker}. Cache is never evicted (events are stable).
type kalshiCategoryCache struct {
	mu     sync.Mutex
	cats   map[string]string
	client *http.Client
}

func newKalshiCategoryCache(client *http.Client) *kalshiCategoryCache {
	return &kalshiCategoryCache{cats: make(map[string]string), client: client}
}

func (c *kalshiCategoryCache) get(eventTicker string) string {
	if eventTicker == "" {
		return ""
	}
	c.mu.Lock()
	if cat, ok := c.cats[eventTicker]; ok {
		c.mu.Unlock()
		return cat
	}
	c.mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, kalshiEventsURL+"/"+eventTicker, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, _ := io.ReadAll(resp.Body)
	var wrapper struct {
		Event struct {
			Category string `json:"category"`
		} `json:"event"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return ""
	}
	cat := wrapper.Event.Category
	c.mu.Lock()
	c.cats[eventTicker] = cat
	c.mu.Unlock()
	return cat
}

type kalshiTracker struct {
	mu       sync.Mutex
	watched  map[string]kalshiWatched // ticker → metadata (non-Exotics only)
	recorded map[string]struct{}      // tickers already emitted
	client   *http.Client
	catCache *kalshiCategoryCache
}

func newKalshiTracker() *kalshiTracker {
	client := &http.Client{Timeout: 15 * time.Second}
	return &kalshiTracker{
		watched:  make(map[string]kalshiWatched),
		recorded: make(map[string]struct{}),
		client:   client,
		catCache: newKalshiCategoryCache(client),
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

// normalizeKalshiCategory maps Kalshi's event category to our standard slugs.
func normalizeKalshiCategory(raw string) string {
	switch strings.ToLower(raw) {
	case "sports":
		return "sports"
	case "politics", "elections":
		return "politics"
	case "crypto", "cryptocurrency", "financials":
		return "crypto"
	default:
		return "other"
	}
}

// pollClosed fetches markets currently in the "closed" (pending settlement)
// state and adds them to the watch list. Exotics never appear here: they
// auto-settle so fast they skip the closed state entirely.
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
		// KXMV* = auto-generated multivariate parlays. They can briefly pass
		// through status=closed (6-10s window) before auto-settling. Exclude.
		if strings.HasPrefix(m.Ticker, "KXMV") {
			continue
		}
		ct, err := time.Parse(time.RFC3339, m.CloseTime)
		if err != nil {
			continue
		}
		if ct.Before(cutoff) {
			break
		}
		if _, ok := k.watched[m.Ticker]; !ok {
			k.watched[m.Ticker] = kalshiWatched{closeTime: ct, eventTicker: m.EventTicker}
		}
	}
}

// pollFinalized fetches recently settled markets and emits histogram
// observations for any that are in the watched map (i.e. were seen in the
// "closed" state first). This naturally excludes Exotics.
// Delay = settlement_ts - close_time (exact from API).
func (k *kalshiTracker) pollFinalized() {
	cutoff := time.Now().Add(-kalshiLookbackDays * 24 * time.Hour)

	markets, _, err := k.fetchPage("settled", "")
	if err != nil {
		log.Printf("[kalshi-res] pollFinalized error: %v", err)
		return
	}

	// Collect candidates that need category lookup (outside lock).
	type candidate struct {
		ticker      string
		eventTicker string
		closeTime   time.Time
		settlementTs string
		result      string
		closeTimeStr string
	}
	var pending []candidate

	k.mu.Lock()
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
		w, watched := k.watched[m.Ticker]
		if !watched {
			// Not in watchlist: either Exotics or outside our lookback window.
			// Mark recorded to avoid rechecking.
			k.recorded[m.Ticker] = struct{}{}
			continue
		}
		pending = append(pending, candidate{
			ticker:      m.Ticker,
			eventTicker: w.eventTicker,
			closeTime:   w.closeTime,
			settlementTs: m.SettlementTs,
			result:      m.Result,
			closeTimeStr: m.CloseTime,
		})
	}
	k.mu.Unlock()

	for _, c := range pending {
		rawCat := k.catCache.get(c.eventTicker)
		cat := normalizeKalshiCategory(rawCat)

		var settleAt time.Time
		if c.settlementTs != "" {
			settleAt, _ = time.Parse(time.RFC3339Nano, c.settlementTs)
		}
		if settleAt.IsZero() {
			settleAt = time.Now()
		}
		delay := settleAt.Sub(c.closeTime).Seconds()

		k.mu.Lock()
		if _, done := k.recorded[c.ticker]; done {
			k.mu.Unlock()
			continue
		}
		k.recorded[c.ticker] = struct{}{}
		delete(k.watched, c.ticker)
		k.mu.Unlock()

		if delay < 0 || delay > float64(kalshiLookbackDays*24*3600) {
			continue
		}
		resolutionDelay.WithLabelValues("kalshi", cat, "false").Observe(delay)
		resolutionsTotal.WithLabelValues("kalshi", cat, "false").Inc()
		log.Printf("[kalshi-res] resolved ticker=%s category=%s(%s) delay=%.0fs close=%s settled=%s result=%s",
			c.ticker, cat, rawCat, delay, c.closeTimeStr, settleAt.UTC().Format(time.RFC3339), c.result)
	}
}

func runKalshiResolutionLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()

	tracker := newKalshiTracker()
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
