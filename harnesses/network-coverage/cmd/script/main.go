package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Network Coverage Monitor ===")
	fmt.Println("Counts the chains/networks each onchain data provider officially supports.")
	fmt.Println("Bench № 005 (network-coverage) — exposes /metrics on :2112.")
	fmt.Println()

	cfg := loadConfig()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting Prometheus metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	// Run one fetch immediately, then re-fetch every cfg.RefreshInterval.
	wg.Add(1)
	go func() {
		defer wg.Done()
		runRefreshLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runRefreshLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.RefreshInterval)
	defer tick.Stop()

	fetchAll(cfg)

	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAll(cfg)
		}
	}
}

func fetchAll(cfg *Config) {
	type job struct {
		name string
		fn   func(*Config) ProviderResult
	}
	jobs := []job{
		{"geckoterminal", fetchGeckoTerminal},
		{"mobula", fetchMobula},
		{"codex", fetchCodex},
		{"coinpaprika", fetchCoinPaprika},
		{"dune", fetchSimDune},
		{"coinstats", fetchCoinStats},
		{"coingecko", fetchCoinGecko},
		{"defillama", fetchDefiLlama},
		{"dexpaprika", fetchDexPaprika},
	}

	var wg sync.WaitGroup
	for _, j := range jobs {
		j := j
		wg.Add(1)
		go func() {
			defer wg.Done()
			start := time.Now()
			res := j.fn(cfg)
			dur := time.Since(start)

			recordResult(j.name, res, dur)

			if res.Err != "" {
				fmt.Printf("[FETCH][%s] ERROR after %v: %s\n", j.name, dur.Round(time.Millisecond), res.Err)
			} else {
				fmt.Printf("[FETCH][%s] %d networks in %v\n", j.name, len(res.Networks), dur.Round(time.Millisecond))
			}
		}()
	}
	wg.Wait()
}
