package main

// Kalshi resolution delay poller.
//
// Kalshi resolves via its own internal process (no onchain oracle).
// Delay = settlement_ts - close_time, both from the public API (exact, no
// polling error). The categories come from the /events/{event_ticker}
// endpoint (the /markets endpoint omits the category field).
//
// "Exotics" markets (KXMV* — auto-generated multivariate parlays) are
// excluded: they settle by algorithm in 0–200 seconds and are not
// comparable to traditional prediction market questions on either venue.
//
// No auth required — uses the public /trade-api/v2/markets + events endpoints.

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
	Status       string `json:"status"`        // "open", "closed", "finalized"
	Result       string `json:"result"`        // "yes", "no", "" when unresolved
}

type kalshiMarketsResponse struct {
	Markets []kalshiMarketRecord `json:"markets"`
	Cursor  string               `json:"cursor"`
}

// kalshiCategoryCache lazily fetches and caches event_ticker → category
// from /events/{event_ticker}. The cache is never evicted (events are stable).
type kalshiCategoryCache struct {
	mu     sync.Mutex
	cats   map[string]string
	client *http.Client
}

func newKalshiCategoryCache(client *http.Client) *kalshiCategoryCache {
	return &kalshiCategoryCache{
		cats:   make(map[string]string),
		client: client,
	}
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
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return ""
	}
	defer resp.Body.Close()
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
	watched  map[string]time.Time // ticker → close_time
	recorded map[string]struct{}  // tickers already emitted
	client   *http.Client
	catCache *kalshiCategoryCache
}

func newKalshiTracker() *kalshiTracker {
	client := &http.Client{Timeout: 15 * time.Second}
	return &kalshiTracker{
		watched:  make(map[string]time.Time),
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

// normalizeKalshiCategory maps Kalshi's event category strings to lowercase
// slugs comparable to Polymarket's categories.
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

// pollClosed fetches recently closed (unresolved) markets and adds them to
// the watch list so we notice when they become settled.
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
// observations for traditional prediction market questions. Auto-generated
// multivariate parlays (Kalshi "Exotics" category, KXMV* prefix) are
// excluded because they settle algorithmically in seconds and are not
// comparable to either venue's real prediction market questions.
func (k *kalshiTracker) pollFinalized() {
	cutoff := time.Now().Add(-kalshiLookbackDays * 24 * time.Hour)

	markets, _, err := k.fetchPage("settled", "")
	if err != nil {
		log.Printf("[kalshi-res] pollFinalized error: %v", err)
		return
	}

	// Collect candidates outside the lock so we can do HTTP calls for categories.
	type candidate struct {
		m  kalshiMarketRecord
		ct time.Time
	}
	var candidates []candidate

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
		candidates = append(candidates, candidate{m: m, ct: ct})
	}
	k.mu.Unlock()

	for _, c := range candidates {
		// Fetch event category (cached after first call).
		rawCat := k.catCache.get(c.m.EventTicker)

		// Skip auto-generated multivariate parlays: they settle by algorithm
		// in seconds and are not comparable to prediction market questions.
		if strings.EqualFold(rawCat, "exotics") {
			k.mu.Lock()
			k.recorded[c.m.Ticker] = struct{}{}
			k.mu.Unlock()
			continue
		}

		// settlement_ts - close_time (exact from API).
		var settleAt time.Time
		if c.m.SettlementTs != "" {
			settleAt, _ = time.Parse(time.RFC3339Nano, c.m.SettlementTs)
		}
		if settleAt.IsZero() {
			settleAt = time.Now()
		}
		delay := settleAt.Sub(c.ct).Seconds()
		if delay < 0 || delay > float64(kalshiLookbackDays*24*3600) {
			k.mu.Lock()
			k.recorded[c.m.Ticker] = struct{}{}
			k.mu.Unlock()
			continue
		}

		cat := normalizeKalshiCategory(rawCat)

		k.mu.Lock()
		if _, done := k.recorded[c.m.Ticker]; done {
			k.mu.Unlock()
			continue
		}
		k.recorded[c.m.Ticker] = struct{}{}
		delete(k.watched, c.m.Ticker)
		k.mu.Unlock()

		resolutionDelay.WithLabelValues("kalshi", cat, "false").Observe(delay)
		resolutionsTotal.WithLabelValues("kalshi", cat, "false").Inc()
		log.Printf("[kalshi-res] resolved ticker=%s category=%s(%s) delay=%.0fs close=%s settled=%s result=%s",
			c.m.Ticker, cat, rawCat, delay, c.m.CloseTime, settleAt.UTC().Format(time.RFC3339), c.m.Result)
	}
}

func runKalshiResolutionLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()

	tracker := newKalshiTracker()
	// Prime the watch list and backfill immediately on startup.
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
