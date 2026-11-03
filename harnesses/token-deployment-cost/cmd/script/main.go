package main

import (
	"fmt"
	"math"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Bench token-deployment-cost — live USD cost to bring a fungible token
// into existence on each supported chain, using that chain's canonical
// method (ERC20 deploy, SPL mint, jetton, TokenFactory denom, ...).
//
// Read-only: no transactions broadcast. Each chain has a kind-specific
// sampler that returns (cost_native, gas_units, error). Multiplied by the
// chain's native USD price from Mobula to get the headline metric.

type Sample struct {
	CostNative  float64                                                    // cost in chain's native unit (wei, lamports, ada, ...)
	NativeUnit  string                                                     // human label of the unit ("wei", "lamports", "lovelace", ...)
	GasUnits    float64                                                    // gas/compute units consumed (math.NaN() for fixed-fee chains)
	NativeToUSD func(amountNative float64, pricePerNative float64) float64 // converter; defaults to amount * price
}

type Sampler interface {
	Sample(ch ChainConfig) (Sample, error)
}

var samplers = map[ChainKind]Sampler{}

func registerSampler(k ChainKind, s Sampler) { samplers[k] = s }

// nativePerNative converts an amount in the chain's smallest unit into
// its native (priced) unit. Examples:
//
//	ETH:   1e18 wei      → 1 ETH
//	SOL:   1e9 lamports  → 1 SOL
//	ADA:   1e6 lovelace  → 1 ADA
var nativeDivisor = map[string]float64{
	"wei":       1e18,
	"lamports":  1e9,
	"lovelace":  1e6,
	"stroop":    1e7,
	"sun":       1e6,
	"mist":      1e9,
	"octa":      1e8,
	"uosmo":     1e6,
	"inj":       1e18, // Injective base denom is "inj"; 1 INJ = 1e18 inj
	"untrn":     1e6,
	"ton-nano":  1e9, // 1 GRAM (TON) = 1e9 nanoton
	"microalgo": 1e6,
	"yocto":     1e24, // 1 NEAR = 1e24 yoctoNEAR
	"e8s":       1e8,  // 1 ICP = 1e8 e8s
}

func nativeFromBase(amountBase float64, unit string) float64 {
	d, ok := nativeDivisor[unit]
	if !ok || d == 0 {
		return amountBase
	}
	return amountBase / d
}

func main() {
	installLogCapture()
	fmt.Println("=== Token Deployment Cost Monitor ===")
	fmt.Println("Live USD cost to deploy a fungible token, across EVM and non-EVM L1 chains.")
	fmt.Println()

	cfg := loadConfig()
	fmt.Printf("Chains:          %d\n", len(cfg.Chains))
	fmt.Printf("Sample interval: %s\n", cfg.Interval)
	fmt.Printf("Mobula key set:  %v\n", cfg.MobulaAPIKey != "")
	fmt.Println()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting Prometheus metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	mobula := NewMobulaClient(cfg.MobulaAPIKey)

	// Price loop — one Mobula call covers every chain's native token.
	prices := newPriceCache()
	wg.Add(1)
	go func() {
		defer wg.Done()
		runPriceLoop(cfg, mobula, prices)
	}()
	// Wait one tick so prices populate before first sample.
	time.Sleep(2 * time.Second)

	// Per-chain sampler goroutine.
	for _, ch := range cfg.Chains {
		ch := ch
		wg.Add(1)
		go func() {
			defer wg.Done()
			runChainLoop(ch, cfg.Interval, prices)
		}()
	}

	<-sigChan
	fmt.Println("\nShutting down...")
	os.Exit(0)
}

const (
	// 6 misses x 5 min: a chain whose sampler or price has failed for 30
	// minutes stops publishing a USD cost.
	staleAfter = 6
	// A price older than this is treated as missing (Mobula down for an
	// hour must not keep converting at an old rate).
	priceMaxAge = time.Hour
)

type priceCache struct {
	mu  sync.RWMutex
	m   map[string]float64
	at  map[string]time.Time
	now func() time.Time
}

func newPriceCache() *priceCache {
	return &priceCache{m: map[string]float64{}, at: map[string]time.Time{}, now: time.Now}
}

func (p *priceCache) get(slug string) (float64, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	v, ok := p.m[slug]
	if !ok || p.now().Sub(p.at[slug]) > priceMaxAge {
		return 0, false
	}
	return v, true
}

func (p *priceCache) setAll(m map[string]float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	t := p.now()
	for k, v := range m {
		p.m[k] = v
		p.at[k] = t
	}
}

func runPriceLoop(cfg *Config, m *MobulaClient, cache *priceCache) {
	slugSet := map[string]bool{}
	for _, c := range cfg.Chains {
		if c.MobulaSymbol != "" {
			slugSet[c.MobulaSymbol] = true
		}
	}
	slugs := make([]string, 0, len(slugSet))
	for s := range slugSet {
		slugs = append(slugs, s)
	}

	tick := time.NewTicker(cfg.PriceRefresh)
	defer tick.Stop()

	doFetch := func() {
		p, err := m.FetchPrices(slugs)
		if err != nil {
			fmt.Printf("[price] fetch error: %v\n", err)
			return
		}
		cache.setAll(p)
		// Emit per-chain price gauge so dashboards can sanity-check.
		for _, c := range cfg.Chains {
			if v, ok := p[c.MobulaSymbol]; ok {
				nativePrice.WithLabelValues(c.Slug).Set(v)
			}
		}
	}
	doFetch()
	for range tick.C {
		doFetch()
	}
}

func runChainLoop(ch ChainConfig, interval time.Duration, prices *priceCache) {
	// Stagger initial start so we don't hammer all RPCs at the same instant.
	time.Sleep(time.Duration(hashStr(ch.Slug)%5000) * time.Millisecond)

	tick := time.NewTicker(interval)
	defer tick.Stop()

	// A failing upstream used to leave the last good gauge in place for
	// ever: Sui's JSON-RPC was retired and the page kept quoting a days-old
	// figure as live. After staleAfter consecutive misses (no sample or no
	// fresh price) the USD gauge is dropped, so the row reads as down
	// instead of current.
	misses := 0
	miss := func() {
		misses++
		if misses >= staleAfter {
			costUSD.DeleteLabelValues(ch.Slug, ch.Layer, string(ch.Kind))
		}
	}

	sample := func() {
		t0 := time.Now()
		s, err := samplers[ch.Kind].Sample(ch)
		sampleLatency.WithLabelValues(ch.Slug).Set(time.Since(t0).Seconds())
		if err != nil {
			samplesTotal.WithLabelValues(ch.Slug, "error").Inc()
			fmt.Printf("[%s] sample error: %v\n", ch.Slug, err)
			miss()
			return
		}
		samplesTotal.WithLabelValues(ch.Slug, "ok").Inc()

		costNative.WithLabelValues(ch.Slug, ch.Layer, string(ch.Kind), s.NativeUnit).Set(s.CostNative)
		if math.IsNaN(s.GasUnits) {
			gasUnits.DeleteLabelValues(ch.Slug, ch.Layer, string(ch.Kind))
		} else {
			gasUnits.WithLabelValues(ch.Slug, ch.Layer, string(ch.Kind)).Set(s.GasUnits)
		}

		price, ok := prices.get(ch.MobulaSymbol)
		if !ok || price <= 0 {
			fmt.Printf("[%s] no fresh USD price for %s\n", ch.Slug, ch.MobulaSymbol)
			miss()
			return
		}
		misses = 0
		native := nativeFromBase(s.CostNative, s.NativeUnit)
		usd := native * price
		costUSD.WithLabelValues(ch.Slug, ch.Layer, string(ch.Kind)).Set(usd)
		fmt.Printf("[%s] cost=%.6f %s (~$%.4f) gas=%v\n", ch.Slug, native, s.NativeUnit, usd, s.GasUnits)
	}

	sample()
	for range tick.C {
		sample()
	}
}

func hashStr(s string) uint32 {
	var h uint32
	for i := 0; i < len(s); i++ {
		h = h*31 + uint32(s[i])
	}
	return h
}
