package main

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"time"
)

// Realized dilution: circulating supply today against 30 and 90 days ago.
//
// CoinGecko's free tier has no supply history endpoint, but /market_chart
// returns daily prices and daily circulating market caps for the same
// timestamps, and their ratio is the circulating supply CoinGecko held
// that day. That is what a token holder actually experienced: unlocks
// that reached the float, emissions, burns. It is not an unlock schedule,
// so a cliff next month is invisible here until it happens.
//
// Budget. One /market_chart call per token per UTC day, paced so the
// whole cohort fits inside the free tier's rate limit: the series is
// daily, so a second read the same day returns the same numbers. The
// cache is in memory and rebuilt once after a restart.
const (
	cgMarketChart = cgAPI + "/coins/%s/market_chart"
	// 91 days gives 92 daily points plus today's intraday point, which is
	// one day of slack over the 90-day window when a series starts late.
	chartDays = 91
	// The public tier, no key, allows somewhere between 5 and 30 calls a
	// minute from one address depending on load, and the address is shared
	// with the other harnesses on the host. The pacer starts at 10 a
	// minute (180 rows in 18 minutes, once a day), doubles the gap on a
	// 429 and halves it back after a run of clean calls, so it settles
	// wherever the headroom is on the day.
	cgMinGap  = 6 * time.Second
	cgMaxGap  = 60 * time.Second
	cgRetries = 3
	// Clean calls in a row before the gap is halved back toward cgMinGap.
	cgRelaxAfter = 20
	// A 429 without a Retry-After header backs off this long before the
	// next attempt.
	cgBackoff = 65 * time.Second
	// How long one tick keeps fetching supply series before leaving the
	// rest to the next tick. The address is shared with other harnesses
	// and throttled on some days, so a pass that ran to completion could
	// outlast the hourly tick; bounded, it fills the cohort over a few
	// ticks and republishes as it goes.
	supplyPassBudget = 40 * time.Minute
	// Rows republished this often during a pass, so the first dilution
	// columns appear minutes after a restart rather than at the end.
	supplyPublishEvery = 10
)

// supplyPoint is one day of circulating supply, derived as mcap / price.
type supplyPoint struct {
	T    time.Time
	Circ float64
}

// supplyCache keeps one series per token for the current UTC day.
type supplyCache struct {
	mu      sync.Mutex
	day     string
	entries map[string][]supplyPoint
}

func newSupplyCache() *supplyCache {
	return &supplyCache{entries: map[string][]supplyPoint{}}
}

// get returns the cached series for id if it was fetched today.
func (c *supplyCache) get(id, day string) ([]supplyPoint, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.day != day {
		// Midnight UTC: every entry is a day old, so the next tick
		// refetches the cohort once.
		c.day = day
		c.entries = map[string][]supplyPoint{}
		return nil, false
	}
	s, ok := c.entries[id]
	return s, ok
}

func (c *supplyCache) put(id, day string, s []supplyPoint) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.day != day {
		c.day = day
		c.entries = map[string][]supplyPoint{}
	}
	c.entries[id] = s
}

func (c *supplyCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// cgPacer spaces CoinGecko calls so the whole harness stays under the
// free tier's limit whatever the cohort size, and adapts the spacing to
// what the address is actually allowed today.
type cgPacer struct {
	mu     sync.Mutex
	last   time.Time
	gap    time.Duration
	streak int
}

var pacer = &cgPacer{gap: cgMinGap}

func (p *cgPacer) wait() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if d := time.Until(p.last.Add(p.gap)); d > 0 {
		time.Sleep(d)
	}
	p.last = time.Now()
}

// throttled doubles the gap after a 429, up to cgMaxGap.
func (p *cgPacer) throttled() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.streak = 0
	if p.gap = p.gap * 2; p.gap > cgMaxGap {
		p.gap = cgMaxGap
	}
	pvCoinGeckoGap.Set(p.gap.Seconds())
}

// ok halves the gap back toward cgMinGap after cgRelaxAfter clean calls.
func (p *cgPacer) ok() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.streak++
	if p.streak >= cgRelaxAfter && p.gap > cgMinGap {
		p.streak = 0
		if p.gap = p.gap / 2; p.gap < cgMinGap {
			p.gap = cgMinGap
		}
		pvCoinGeckoGap.Set(p.gap.Seconds())
	}
}

// getCoinGecko is getJSON with the pacer and a 429 backoff. The retry
// honours Retry-After when CoinGecko sends one.
func getCoinGecko(rawURL string, out any) error {
	var err error
	for attempt := 0; attempt < cgRetries; attempt++ {
		pacer.wait()
		pvCoinGeckoCalls.Inc()
		var res httpResult
		res, err = getJSONStatus(rawURL, out)
		if err == nil {
			pacer.ok()
			return nil
		}
		if res.status != http.StatusTooManyRequests {
			return err
		}
		pvCoinGecko429s.Inc()
		pacer.throttled()
		wait := cgBackoff
		if res.retryAfter > 0 {
			wait = res.retryAfter
		}
		fmt.Printf("[coingecko] 429, backing off %v (attempt %d/%d)\n", wait, attempt+1, cgRetries)
		time.Sleep(wait)
	}
	return err
}

// fetchSupplySeries reads /market_chart for one coin and turns it into a
// daily circulating-supply series.
func fetchSupplySeries(id string) ([]supplyPoint, error) {
	q := url.Values{}
	q.Set("vs_currency", "usd")
	q.Set("days", strconv.Itoa(chartDays))
	q.Set("interval", "daily")
	var chart struct {
		Prices     [][2]float64 `json:"prices"`
		MarketCaps [][2]float64 `json:"market_caps"`
	}
	if err := getCoinGecko(fmt.Sprintf(cgMarketChart, url.PathEscape(id))+"?"+q.Encode(), &chart); err != nil {
		return nil, err
	}
	return supplySeries(chart.Prices, chart.MarketCaps), nil
}

// supplySeries pairs prices and market caps by timestamp and divides.
// Pure, so the derivation is testable on a fixture. A day where either
// side is zero has no supply: CoinGecko carries a price before it carries
// a market cap for a new listing, and 0 / price would read as a burn to
// zero.
func supplySeries(prices, mcaps [][2]float64) []supplyPoint {
	priceAt := make(map[int64]float64, len(prices))
	for _, p := range prices {
		priceAt[int64(p[0])] = p[1]
	}
	out := make([]supplyPoint, 0, len(mcaps))
	for _, m := range mcaps {
		ts := int64(m[0])
		price, ok := priceAt[ts]
		if !ok || price <= 0 || m[1] <= 0 {
			continue
		}
		out = append(out, supplyPoint{T: time.UnixMilli(ts).UTC(), Circ: m[1] / price})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T.Before(out[j].T) })
	return out
}

// supplyChangePct is the percent change of circulating supply between the
// latest point and the last point at or before now minus the window.
// False when the series does not reach back that far: a token listed six
// weeks ago has no 90-day dilution, and a zero would read as "none".
func supplyChangePct(series []supplyPoint, now time.Time, window time.Duration) (float64, bool) {
	if len(series) < 2 {
		return 0, false
	}
	latest := series[len(series)-1]
	cutoff := now.Add(-window)
	var then *supplyPoint
	for i := range series {
		if series[i].T.After(cutoff) {
			break
		}
		then = &series[i]
	}
	if then == nil || then.Circ <= 0 || latest.Circ <= 0 || !latest.T.After(then.T) {
		return 0, false
	}
	return 100 * (latest.Circ/then.Circ - 1), true
}

// attachSupplyChange fills the dilution fields of every row, fetching the
// series the cache does not hold for today, for at most supplyPassBudget.
// onProgress is called every supplyPublishEvery fetches so the caller can
// republish the rows filled so far. Returns how many fetches it made.
func attachSupplyChange(rows []Row, cache *supplyCache, now time.Time, onProgress func()) int {
	day := now.UTC().Format("2006-01-02")
	start := time.Now()
	fetched, misses := 0, 0
	for i := range rows {
		id := rows[i].GeckoID
		series, ok := cache.get(id, day)
		if !ok {
			if time.Since(start) > supplyPassBudget {
				// Left to the next hourly tick; the rows still fill from
				// whatever the cache holds.
				misses++
				continue
			}
			s, err := fetchSupplySeries(id)
			if err != nil {
				pvFetchErrors.WithLabelValues("coingecko_chart").Inc()
				fmt.Printf("[supply] %s: %v (retried next tick)\n", id, err)
				misses++
				continue
			}
			fetched++
			cache.put(id, day, s)
			series = s
		}
		rows[i].SupplyChg30d, rows[i].HasSupply30d = supplyChangePct(series, now, 30*24*time.Hour)
		rows[i].SupplyChg90d, rows[i].HasSupply90d = supplyChangePct(series, now, 90*24*time.Hour)
		if fetched > 0 && fetched%supplyPublishEvery == 0 && onProgress != nil {
			onProgress()
		}
	}
	if misses > 0 {
		fmt.Printf("[supply] %d rows without a series this tick, next tick continues\n", misses)
	}
	return fetched
}
