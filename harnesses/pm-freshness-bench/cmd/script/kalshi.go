package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Kalshi public trade feed. The /v1/social/trades endpoint is the same one
// kalshi.com homepage trade ticker hits; it is unauthenticated, CloudFront
// fronted (max-age=10s), no geo block on read, no auth header required.
//
// Why REST and not the official WebSocket: the WS at
// external-api-ws.kalshi.com requires RSA-PSS signed headers from an
// account with US KYC, and returns 403 from non-US IPs even with valid
// auth. The social/trades JSON carries `create_date` at microsecond
// precision -- that IS the venue T0, independent of our poll cadence.
// The poller's only job is to surface trade signatures so the correlator
// can match them against Codex's Kalshi stream.
//
// Calling without `series_ticker` returns a global feed of the most
// recent ~100 trades across all series, so a single HTTP call per cycle
// covers every active market. The Kalshi basket (used by codex.go to
// filter Kalshi events on its firehose) is built dynamically from the
// tickers actually seen in those trades, which auto-targets the active
// markets without needing a separate /markets call that returns zero
// volumes on most rows.
const kalshiSocialTradesURL = "https://api.elections.kalshi.com/v1/social/trades"

func runKalshi(ctx context.Context, cfg Config, codexKalshiCh chan<- []Market) {
	every := time.Duration(cfg.KalshiPollIntervalSec) * time.Second
	if every < 2*time.Second {
		every = 5 * time.Second
	}

	seen := newSeenCache(8192)
	tickerFreq := newTickerFreq(cfg.BasketSize)

	appendLog("[kalshi] REST poller started (global feed), interval=%s", every)
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if err := pollKalshiGlobal(ctx, seen, tickerFreq, codexKalshiCh); err != nil {
			fetchErrors.WithLabelValues("kalshi", "kalshi", classify(err)).Inc()
			health.WithLabelValues("kalshi", "kalshi").Set(0)
			appendLog("[kalshi] poll err: %v", err)
		}
	}
}

// pollKalshiGlobal pages through /v1/social/trades following the
// returned cursor until either every trade in a page is already in the
// seen cache (we caught up with last cycle) or we hit the page cap.
// One call returns ~100 trades covering ~3 seconds of venue time; with
// a 5 s poll cadence two pages cover the gap with overlap, the cap of
// 5 is generous headroom for traffic spikes.
const kalshiMaxPagesPerPoll = 5

func pollKalshiGlobal(ctx context.Context, seen *seenCache, freq *tickerFreq, codexKalshiCh chan<- []Market) error {
	cursor := ""
	for page := 0; page < kalshiMaxPagesPerPoll; page++ {
		newOnThisPage, nextCursor, err := fetchKalshiPage(ctx, cursor, seen, freq)
		if err != nil {
			return fmt.Errorf("page %d: %w", page+1, err)
		}
		// Stop once a whole page returns zero new trades -- means we
		// crossed back into the previous poll's window.
		if newOnThisPage == 0 {
			break
		}
		if nextCursor == "" {
			break
		}
		cursor = nextCursor
	}
	// Push the latest observed-tickers basket so codex.go's isKnownKalshi
	// accepts the same set of markets we're polling. The channel send is
	// non-blocking; codex.go re-reads currentKalshiBasket on (re)connect
	// anyway, so dropping an update is safe — the next poll will retry.
	basket := freq.topTickers()
	basketMu.Lock()
	kalshiBasket = basket
	basketMu.Unlock()
	basketSize.WithLabelValues("kalshi").Set(float64(len(basket)))
	if codexKalshiCh != nil && len(basket) > 0 {
		select {
		case codexKalshiCh <- basket:
		default:
		}
	}
	return nil
}

func fetchKalshiPage(ctx context.Context, cursor string, seen *seenCache, freq *tickerFreq) (int, string, error) {
	url := kalshiSocialTradesURL
	if cursor != "" {
		url += "?cursor=" + cursor
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "openchainbench-pm-freshness-bench")
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, "", fmt.Errorf("status_%d", resp.StatusCode)
	}
	var payload struct {
		Trades []struct {
			TradeID    string `json:"trade_id"`
			Ticker     string `json:"ticker"`
			Price      int    `json:"price"`
			CreateDate string `json:"create_date"`
		} `json:"trades"`
		Cursor string `json:"cursor"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, "", err
	}
	newCount := 0
	for _, t := range payload.Trades {
		if t.TradeID == "" || t.Ticker == "" {
			continue
		}
		if seen.contains(t.TradeID) {
			continue
		}
		seen.add(t.TradeID)
		ts, err := time.Parse(time.RFC3339Nano, t.CreateDate)
		if err != nil {
			continue
		}
		newCount++
		eventsTotal.WithLabelValues("kalshi", "kalshi", "trade").Inc()
		health.WithLabelValues("kalshi", "kalshi").Set(1)
		markAlive("kalshi", "kalshi")

		tickerLower := strings.ToLower(t.Ticker)
		freq.bump(tickerLower)

		sig := EventSig{
			Venue:       "kalshi",
			ConditionId: tickerLower,
			PriceMilli:  t.Price * 10,
			BucketSec:   bucketSec(float64(ts.UnixNano()) / 1e9),
		}
		logSigSample("kalshi", sig)
		correlator.Add(sig, Arrival{Provider: "kalshi", Kind: "trade", RecvUnix: float64(ts.UnixNano()) / 1e9})
	}
	return newCount, payload.Cursor, nil
}

// tickerFreq tracks how often each market_ticker has appeared in the
// recent trade stream, with exponential decay so quiet markets fade.
// We expose the top N as the "active basket" -- Codex's firehose filter
// reads from this set.
type tickerFreq struct {
	mu      sync.Mutex
	counts  map[string]float64
	cap     int
	lastDec time.Time
}

func newTickerFreq(cap int) *tickerFreq {
	return &tickerFreq{counts: map[string]float64{}, cap: cap, lastDec: time.Now()}
}

func (f *tickerFreq) bump(ticker string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.decayLocked()
	f.counts[ticker]++
}

// decayLocked applies an exponential decay so a market that stops
// trading drops out of the top-N after a few minutes. Tuned so a market
// at "1 trade per minute" decays past a 0.1 floor in ~10 minutes.
func (f *tickerFreq) decayLocked() {
	now := time.Now()
	elapsed := now.Sub(f.lastDec).Seconds()
	if elapsed < 30 {
		return
	}
	f.lastDec = now
	decay := 0.95 * (elapsed / 60) // ~5% per minute
	if decay > 0.5 {
		decay = 0.5
	}
	factor := 1 - decay
	for k, v := range f.counts {
		nv := v * factor
		if nv < 0.1 {
			delete(f.counts, k)
		} else {
			f.counts[k] = nv
		}
	}
}

func (f *tickerFreq) topTickers() []Market {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.decayLocked()
	type kv struct {
		ticker string
		score  float64
	}
	all := make([]kv, 0, len(f.counts))
	for t, c := range f.counts {
		all = append(all, kv{t, c})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	if len(all) > f.cap {
		all = all[:f.cap]
	}
	out := make([]Market, len(all))
	for i, kv := range all {
		out[i] = Market{Slug: kv.ticker, ConditionId: kv.ticker, Vol24h: kv.score}
	}
	return out
}

// seenCache is a small FIFO set just enough to dedup trade_id across polls.
// Each poll typically returns ~100 trades and we re-fetch every 5s, so 8k
// entries covers ~7 minutes of unique IDs at peak.
type seenCache struct {
	mu    sync.Mutex
	set   map[string]struct{}
	order []string
	cap   int
}

func newSeenCache(cap int) *seenCache {
	return &seenCache{set: make(map[string]struct{}, cap), cap: cap}
}

func (s *seenCache) contains(k string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.set[k]
	return ok
}

func (s *seenCache) add(k string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.set[k]; ok {
		return
	}
	s.set[k] = struct{}{}
	s.order = append(s.order, k)
	if len(s.order) > s.cap {
		old := s.order[0]
		s.order = s.order[1:]
		delete(s.set, old)
	}
}
