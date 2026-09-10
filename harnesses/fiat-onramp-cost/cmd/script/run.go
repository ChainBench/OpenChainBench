package main

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// cellKey identifies one provider × dims series so a cell that stops
// answering is purged instead of freezing at its last value.
type cellKey string

func keyOf(l prometheus.Labels) cellKey {
	keys := make([]string, 0, len(l))
	for k := range l {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	s := ""
	for _, k := range keys {
		s += k + "=" + l[k] + ";"
	}
	return cellKey(s)
}

type cycleResult struct {
	adapter Adapter
	req     QuoteRequest
	quotes  []NormalizedQuote
	latency time.Duration
	err     error
}

// grid expands the persona into one QuoteRequest per asset × notional ×
// payment method, on each asset's primary network.
func grid(cfg *Config) []QuoteRequest {
	var out []QuoteRequest
	for _, a := range cfg.Assets {
		for _, n := range cfg.Notionals {
			for _, m := range cfg.PaymentMethods {
				out = append(out, QuoteRequest{Asset: a, Network: a.Network, PaymentMethod: m, Notional: n})
			}
		}
	}
	return out
}

// quoteCell asks one adapter for one cell, falling back to the asset's
// secondary network when the primary is not listed. A fallback sample keeps
// its real network label so the reader sees what was actually quoted.
func quoteCell(ctx context.Context, a Adapter, req QuoteRequest) cycleResult {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	qs, lat, err := a.Quote(cctx, req)
	if err == ErrNoQuote && req.Asset.Fallback != "" && req.Asset.Fallback != req.Network {
		fb := req
		fb.Network = req.Asset.Fallback
		qs2, lat2, err2 := a.Quote(cctx, fb)
		if err2 == nil {
			return cycleResult{adapter: a, req: fb, quotes: qs2, latency: lat + lat2}
		}
		lat += lat2
	}
	return cycleResult{adapter: a, req: req, quotes: qs, latency: lat, err: err}
}

// runCycle fetches spot, quotes every enabled adapter in parallel (one
// semaphore per provider so no provider sees more than cfg.ProviderSemaphore
// in flight), emits metrics and returns the set of cells seen.
func runCycle(ctx context.Context, cfg *Config, adapters []Adapter, prev map[cellKey]prometheus.Labels) map[cellKey]prometheus.Labels {
	start := time.Now()
	spot := fetchSpot(ctx)
	cells := grid(cfg)

	results := make(chan cycleResult, len(cells)*len(adapters))
	var wg sync.WaitGroup
	for _, a := range adapters {
		if !a.Enabled() {
			continue
		}
		a := a
		sem := make(chan struct{}, cfg.ProviderSemaphore)
		for _, req := range cells {
			req := req
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				results <- quoteCell(ctx, a, req)
			}()
		}
	}
	wg.Wait()
	close(results)

	seen := map[cellKey]prometheus.Labels{}
	ok, failed := 0, 0
	for r := range results {
		slug := r.adapter.Slug()
		if r.latency > 0 {
			quoteLatency.WithLabelValues(slug).Observe(float64(r.latency.Milliseconds()))
		}
		if r.err != nil {
			failed++
			reason := classifyErr(r.err)
			quoteErrors.WithLabelValues(slug, reason).Inc()
			// A direct provider's failed cell is a success=0 sample on its
			// own series. An aggregator's failure cannot be attributed to a
			// member, so it is recorded on the aggregator slug.
			l := labelsFor(NormalizedQuote{
				Provider: slug, Cohort: r.adapter.Cohort(), Via: viaOf(r.adapter),
				Asset: r.req.Asset.Asset, Network: r.req.Network, PaymentMethod: r.req.PaymentMethod,
				Notional: r.req.Notional, CountrySource: r.adapter.CountrySource(),
			})
			quoteSuccess.With(l).Set(0)
			seen[keyOf(l)] = l
			if reason != "no_quote" {
				fmt.Printf("[ERR] %s %s/%s %s %.0f: %v\n", slug, r.req.Asset.Asset, r.req.Network, r.req.PaymentMethod, r.req.Notional, r.err)
			}
			continue
		}
		for _, q := range r.quotes {
			ok++
			emitQuote(q, spot)
			l := labelsFor(q)
			seen[keyOf(l)] = l
		}
		// An aggregator that returned at least one member quote is itself a
		// success on its own slug, so the spec can read success for direct
		// and aggregator rows with the same selector shape.
		if r.adapter.Cohort() == "aggregator" && len(r.quotes) > 0 {
			l := labelsFor(NormalizedQuote{
				Provider: slug, Cohort: "aggregator", Via: slug,
				Asset: r.req.Asset.Asset, Network: r.req.Network, PaymentMethod: r.req.PaymentMethod,
				Notional: r.req.Notional, CountrySource: r.adapter.CountrySource(),
			})
			quoteSuccess.With(l).Set(1)
			seen[keyOf(l)] = l
		}
	}
	// Purge cells that answered last cycle and are absent now (a member ramp
	// that dropped out of an aggregator's list, or a direct provider that
	// vanished without an error path).
	for k, l := range prev {
		if _, still := seen[k]; !still {
			DeleteQuoteSeries(l)
			quoteSuccess.With(l).Set(0)
			seen[k] = l
		}
	}
	lastCycleTS.Set(float64(time.Now().Unix()))
	fmt.Printf("[CYCLE] %s: %d quotes, %d failed cells, spot kraken=%d pyth=%d, %.1fs\n",
		start.UTC().Format(time.RFC3339), ok, failed, len(spot.Kraken), len(spot.Pyth), time.Since(start).Seconds())
	return seen
}

func viaOf(a Adapter) string {
	if a.Cohort() == "aggregator" {
		return a.Slug()
	}
	return "direct"
}

// emitQuote writes every gauge for one normalized quote. The premium is
// emitted once per spot reference that answered this cycle, so the two
// series are never mixed and a missing reference simply leaves a gap.
func emitQuote(q NormalizedQuote, spot SpotSnapshot) {
	l := labelsFor(q)
	declared, derr := DeclaredFeeBps(q)
	if derr != nil {
		quoteErrors.WithLabelValues(q.Provider, "parse").Inc()
		return
	}
	declaredFee.With(l).Set(declared)
	cryptoOut.With(l).Set(q.CryptoOut)
	quoteTTL.With(l).Set(q.TTLSeconds)
	quoteSuccess.With(l).Set(1)
	quoteSamples.With(l).Inc()
	if q.MinFiat > 0 {
		limitsMinFiat.WithLabelValues(q.Provider, q.PaymentMethod, q.Asset).Set(q.MinFiat)
	}
	if q.MaxFiat > 0 {
		limitsMaxFiat.WithLabelValues(q.Provider, q.PaymentMethod, q.Asset).Set(q.MaxFiat)
	}
	for ref, m := range map[string]map[string]float64{"kraken_eur": spot.Kraken, "pyth": spot.Pyth} {
		s, ok := m[q.Asset]
		if !ok || s <= 0 {
			allInPremium.Delete(withRef(l, ref))
			hiddenSpread.Delete(withRef(l, ref))
			continue
		}
		allIn, aerr := AllInPremiumBps(q.FiatIn, q.CryptoOut, s)
		if aerr != nil {
			allInPremium.Delete(withRef(l, ref))
			hiddenSpread.Delete(withRef(l, ref))
			continue
		}
		allInPremium.With(withRef(l, ref)).Set(allIn)
		hiddenSpread.With(withRef(l, ref)).Set(HiddenSpreadBps(allIn, declared))
	}
}

func runMain() {
	cfg := loadConfig()
	cfg.Print()
	adapters := buildAdapters(cfg)
	enabled := 0
	for _, a := range adapters {
		if a.Enabled() {
			enabled++
			fmt.Printf("[INIT] %s enabled (%s)\n", a.Slug(), a.Cohort())
		} else {
			fmt.Printf("[INIT] %s skipped: no credential\n", a.Slug())
		}
	}
	if enabled == 0 {
		fmt.Println("[INIT] no provider enabled; serving spot references only")
	}

	go func() {
		if err := StartMetricsServer(cfg.ListenAddr, cfg); err != nil {
			fmt.Printf("[FATAL] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx := context.Background()
	prev := map[cellKey]prometheus.Labels{}
	once := os.Getenv("ONCE") == "1"
	for {
		prev = runCycle(ctx, cfg, adapters, prev)
		if once {
			return
		}
		// ±10 % jitter so six providers never see a fixed-period pattern
		// from one IP.
		jitter := time.Duration(rand.Int63n(int64(cfg.Cycle())/5)) - cfg.Cycle()/10
		time.Sleep(cfg.Cycle() + jitter)
	}
}
