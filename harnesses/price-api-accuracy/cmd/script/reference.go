package main

import (
	"context"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The exchange reference: the median of three venues' mids, refreshed every
// few seconds. Median rather than mean, so one venue's wick cannot move it.
//
// Binance quotes these majors against USDT only. A USDT book read as USD
// sits about 12 bps high whenever USDT trades at 0.9988, which it did on
// 2026-10-19, so Binance's mid is converted at the USDT/USD mid (median of
// Coinbase and Kraken) before it enters the median. Coinbase and Kraken
// quote USD directly.

type snapshot struct {
	at   time.Time
	mids map[string]float64
}

type reference struct {
	cfg  config
	mu   sync.RWMutex
	last []snapshot // the six most recent, newest last
}

func newReference(cfg config) *reference { return &reference{cfg: cfg} }

// at returns the snapshot nearest t, and false when none is within the
// configured tolerance.
func (r *reference) at(t time.Time) (snapshot, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var best snapshot
	bestGap := time.Duration(1<<62 - 1)
	for _, s := range r.last {
		g := t.Sub(s.at)
		if g < 0 {
			g = -g
		}
		if g < bestGap {
			best, bestGap = s, g
		}
	}
	return best, len(r.last) > 0 && bestGap <= r.cfg.refTolerance
}

func (r *reference) run(ctx context.Context) {
	t := time.NewTicker(r.cfg.refInterval)
	defer t.Stop()
	for {
		r.poll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

var coinbaseProduct = map[string]string{
	"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD", "BNB": "BNB-USD", "XRP": "XRP-USD",
	"ADA": "ADA-USD", "DOGE": "DOGE-USD", "AVAX": "AVAX-USD", "LINK": "LINK-USD",
}

// Kraken answers under its own pair names, which differ from the ones asked.
var krakenPair = map[string]string{
	"BTC": "XXBTZUSD", "ETH": "XETHZUSD", "SOL": "SOLUSD", "BNB": "BNBUSD", "XRP": "XXRPZUSD",
	"ADA": "ADAUSD", "DOGE": "XDGUSD", "AVAX": "AVAXUSD", "LINK": "LINKUSD",
}

func (r *reference) poll(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	started := time.Now()

	var mu sync.Mutex
	quotes := map[string][]float64{}
	add := func(asset string, mid float64) {
		if mid > 0 {
			mu.Lock()
			quotes[asset] = append(quotes[asset], mid)
			mu.Unlock()
		}
	}

	var wg sync.WaitGroup
	for asset, product := range coinbaseProduct {
		wg.Add(1)
		go func(asset, product string) {
			defer wg.Done()
			var t struct{ Bid, Ask string }
			if err := getJSON(cctx, nil, "https://api.exchange.coinbase.com/products/"+product+"/ticker", nil, &t); err != nil {
				return
			}
			add(asset, midOf(t.Bid, t.Ask))
		}(asset, product)
	}

	// USDT/USD comes from two venues in their own requests, so losing
	// Kraken's USD pairs does not also drop Binance from the median.
	usdts := []float64{}
	addUSDT := func(m float64) {
		if m > 0.9 && m < 1.1 {
			mu.Lock()
			usdts = append(usdts, m)
			mu.Unlock()
		}
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		var t struct{ Bid, Ask string }
		if err := getJSON(cctx, nil, "https://api.exchange.coinbase.com/products/USDT-USD/ticker", nil, &t); err == nil {
			addUSDT(midOf(t.Bid, t.Ask))
		}
	}()
	type krakenTicker struct {
		Error  []string
		Result map[string]struct {
			A []string `json:"a"`
			B []string `json:"b"`
		}
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		var k krakenTicker
		if err := getJSON(cctx, nil, "https://api.kraken.com/0/public/Ticker?pair=USDTZUSD", nil, &k); err == nil && len(k.Error) == 0 {
			if v, ok := k.Result["USDTZUSD"]; ok && len(v.A) > 0 && len(v.B) > 0 {
				addUSDT(midOf(v.B[0], v.A[0]))
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		pairs := make([]string, 0, len(krakenPair))
		for _, p := range krakenPair {
			pairs = append(pairs, p)
		}
		sort.Strings(pairs)
		var k krakenTicker
		if err := getJSON(cctx, nil, "https://api.kraken.com/0/public/Ticker?pair="+strings.Join(pairs, ","), nil, &k); err != nil {
			return
		}
		// Kraken answers 200 with an error array when it rejects a pair;
		// the result is then partial or empty, and the log says why.
		if len(k.Error) > 0 {
			log.Printf("reference: kraken: %v", k.Error)
		}
		for asset, pair := range krakenPair {
			if v, ok := k.Result[pair]; ok && len(v.A) > 0 && len(v.B) > 0 {
				add(asset, midOf(v.B[0], v.A[0]))
			}
		}
	}()

	var binance []struct {
		Symbol   string `json:"symbol"`
		BidPrice string `json:"bidPrice"`
		AskPrice string `json:"askPrice"`
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		syms := make([]string, 0, len(coinbaseProduct))
		for asset := range coinbaseProduct {
			syms = append(syms, `"`+asset+`USDT"`)
		}
		sort.Strings(syms)
		u := "https://api.binance.com/api/v3/ticker/bookTicker?symbols=" + url.QueryEscape("["+strings.Join(syms, ",")+"]")
		if err := getJSON(cctx, nil, u, nil, &binance); err != nil {
			binance = nil
		}
	}()
	wg.Wait()

	// Binance enters only once USDT is priced: a USDT book without the
	// conversion is the 12 bps bias this reference exists to remove.
	if len(usdts) > 0 {
		usdt := median(usdts)
		usdtUSD.Set(usdt)
		for _, b := range binance {
			asset := strings.TrimSuffix(b.Symbol, "USDT")
			add(asset, midOf(b.BidPrice, b.AskPrice)*usdt)
		}
	}

	snap := snapshot{at: started.Add(time.Since(started) / 2), mids: map[string]float64{}}
	for asset, qs := range quotes {
		referenceSources.WithLabelValues(strings.ToLower(asset)).Set(float64(len(qs)))
		if len(qs) < 2 {
			continue
		}
		m := median(qs)
		snap.mids[asset] = m
		referenceMid.WithLabelValues(strings.ToLower(asset)).Set(m)
	}
	if len(snap.mids) == 0 {
		log.Printf("reference: no asset priced by two venues this tick")
		return
	}
	r.mu.Lock()
	r.last = append(r.last, snap)
	// Thirty seconds of snapshots: a multi-call round (CoinPaprika's nine)
	// is scored per answer, and its first answer must still find the
	// snapshot taken when it arrived.
	if len(r.last) > 6 {
		r.last = r.last[len(r.last)-6:]
	}
	r.mu.Unlock()
}

func midOf(bid, ask string) float64 {
	b, err1 := strconv.ParseFloat(bid, 64)
	a, err2 := strconv.ParseFloat(ask, 64)
	if err1 != nil || err2 != nil || b <= 0 || a <= 0 {
		return 0
	}
	return (a + b) / 2
}

func median(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
