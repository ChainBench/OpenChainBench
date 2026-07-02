package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Bench № tbd — current native-transfer transaction fee per chain.
//
// One process scrapes 11 L1 chains. For each chain we compute the current
// USD cost of a "standard" native-token transfer (an ETH transfer, a SOL
// transfer, an ADA transfer, etc.) every 30 s and expose it as Prometheus
// gauges. The same list as the L1 finality bench so users can compare
// "how fast does my transaction land" vs "how much does my transaction
// cost" head-to-head.
//
// Headline metric per chain:
//   tx_fee_native_transfer_usd{chain, tier}
//
// where tier is one of slow/std/fast for chains with a priority market,
// or "single" for deterministic chains (Cardano, Stellar, TRON bandwidth).

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Transaction Fee Monitor ===")
	fmt.Println("Native-transfer USD cost across 11 L1 chains.")
	fmt.Println()

	cfg := loadConfig()

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

	// Price refresher — pull all 11 prices in one Mobula call.
	wg.Add(1)
	go func() {
		defer wg.Done()
		runPriceLoop(cfg, mobula)
	}()

	// Wait one tick so prices are populated before first fee sample.
	time.Sleep(2 * time.Second)

	// Per-chain sampler goroutine.
	for _, ch := range cfg.Chains {
		ch := ch
		wg.Add(1)
		go func() {
			defer wg.Done()
			runChainLoop(ch, cfg.Interval)
		}()
	}

	<-sigChan
	fmt.Println("\nShutting down...")
	os.Exit(0)
}

func runPriceLoop(cfg *Config, m *MobulaClient) {
	slugs := make([]string, 0, len(cfg.Chains))
	seen := map[string]bool{}
	for _, c := range cfg.Chains {
		if !seen[c.MobulaSlug] {
			slugs = append(slugs, c.MobulaSlug)
			seen[c.MobulaSlug] = true
		}
	}

	tick := func() {
		prices, err := m.FetchPrices(slugs)
		if err != nil {
			fmt.Printf("[PRICE] fetch error: %v\n", err)
			return
		}
		for slug, p := range prices {
			setPrice(slug, p)
		}
		fmt.Printf("[PRICE] refreshed %d prices\n", len(prices))
	}

	tick()
	t := time.NewTicker(cfg.PriceRefresh)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

func runChainLoop(ch ChainConfig, interval time.Duration) {
	fetcher := getFetcher(ch)
	if fetcher == nil {
		fmt.Printf("[%s] no fetcher for kind=%s, skipping\n", ch.Slug, ch.Kind)
		healthOK.WithLabelValues(ch.Slug, ch.Layer).Set(0)
		return
	}

	tick := func() {
		samples, err := fetcher.Sample(ch)
		if err != nil {
			fmt.Printf("[%s] fetch error: %v\n", ch.Slug, err)
			fetchErrors.WithLabelValues(ch.Slug, classifyErr(err), ch.Layer).Inc()
			healthOK.WithLabelValues(ch.Slug, ch.Layer).Set(0)
			return
		}
		price := getPrice(ch.MobulaSlug)
		if price <= 0 {
			fmt.Printf("[%s] missing USD price for %s, skipping emit\n", ch.Slug, ch.MobulaSlug)
			healthOK.WithLabelValues(ch.Slug, ch.Layer).Set(0)
			return
		}
		priceUSDGauge.WithLabelValues(ch.Slug, ch.Layer).Set(price)
		for _, s := range samples {
			feeNativeGauge.WithLabelValues(ch.Slug, s.Tier, ch.Layer).Set(s.NativeFee)
			usd := s.UsdFee
			if usd == 0 {
				// Fetcher returned native units only; multiply now.
				usd = nativeToUSD(ch, s.NativeFee, price)
			}
			feeUSDGauge.WithLabelValues(ch.Slug, s.Tier, ch.Layer).Set(usd)
			if s.GasPrice > 0 {
				gasPriceGauge.WithLabelValues(ch.Slug, s.Tier, ch.Layer).Set(s.GasPrice)
			}
		}
		lastRefreshGauge.WithLabelValues(ch.Slug, ch.Layer).Set(float64(time.Now().Unix()))
		healthOK.WithLabelValues(ch.Slug, ch.Layer).Set(1)
	}

	tick()
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

// nativeToUSD converts native smallest-unit fee to USD using the chain's
// known decimals. Each chain has its own scale.
func nativeToUSD(ch ChainConfig, native, priceUSD float64) float64 {
	var decimals int
	switch ch.Kind {
	case KindEVM:
		decimals = 18 // wei
	case KindSolana:
		decimals = 9 // lamport
	case KindCardano:
		decimals = 6 // lovelace
	case KindStellar:
		decimals = 7 // stroop
	case KindTron:
		decimals = 6 // sun
	case KindSui:
		decimals = 9 // MIST
	case KindTon:
		decimals = 9 // nanoton
	case KindUTXO:
		decimals = 8 // satoshi (Litecoin)
	case KindMonero:
		decimals = 12 // atomic units
	default:
		decimals = 18
	}
	scale := 1.0
	for i := 0; i < decimals; i++ {
		scale *= 10
	}
	return (native / scale) * priceUSD
}

// classifyErr returns a short error_type label for Prom counters.
func classifyErr(err error) string {
	s := err.Error()
	switch {
	case containsAny(s, "timeout", "deadline exceeded", "EOF"):
		return "timeout"
	case containsAny(s, "connection refused", "no such host", "lookup"):
		return "network"
	case containsAny(s, "http 4"):
		return "http4xx"
	case containsAny(s, "http 5"):
		return "http5xx"
	case containsAny(s, "decode", "unmarshal", "JSON"):
		return "parse"
	default:
		return "other"
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if len(s) >= len(sub) && (indexOf(s, sub) >= 0) {
			return true
		}
	}
	return false
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// Fetcher is implemented by each per-chain sampler.
type Fetcher interface {
	Sample(ch ChainConfig) ([]FeeSample, error)
}

// getFetcher picks the right fetcher implementation for a chain.
// Wired up by per-chain files via init() registering into this map.
var fetcherRegistry = map[ChainKind]Fetcher{}

func registerFetcher(k ChainKind, f Fetcher) {
	fetcherRegistry[k] = f
}

func getFetcher(ch ChainConfig) Fetcher {
	return fetcherRegistry[ch.Kind]
}
