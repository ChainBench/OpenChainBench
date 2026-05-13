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
	installLogCapture()
	fmt.Println("=== L1 Finality Lag Monitor ===")
	fmt.Println("Bench № 006 — measures wall-clock distance between latest and finalized blocks per chain.")
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

	wg.Add(1)
	go func() {
		defer wg.Done()
		runRefreshLoop(cfg, stop)
	}()

	// WS / SSE wall-clock measurement runs as a separate set of goroutines
	// (one per chain) since polling can't measure sub-poll-cadence finality.
	StartWSFinality()
	StartTONWallClock()
	StartSUIWallClock()
	StartStellarWallClock()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runRefreshLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.Interval)
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
	var wg sync.WaitGroup
	for _, ch := range cfg.Chains {
		ch := ch
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := fetchOne(ch)
			recordSample(s)
			recordDebugSnapshot(s)
			if s.Err != "" {
				fmt.Printf("[L1][%s] ERROR after %dms: %s\n", ch.Slug, s.FetchLatencyMs, s.Err)
			} else {
				fmt.Printf("[L1][%s] lag=%.3fs (block-lag=%d, latest=%d, finalized=%d) in %dms\n",
					ch.Slug, s.LagSeconds, s.BlockLag, s.LatestBlock, s.FinalizedBlock, s.FetchLatencyMs)
			}
		}()
	}
	wg.Wait()
}

func fetchOne(ch ChainConfig) FinalitySample {
	switch ch.Kind {
	case KindEVM:
		return fetchEVM(ch)
	case KindSolana:
		return fetchSolana(ch)
	case KindTron:
		return fetchTron(ch)
	case KindXRP:
		return fetchXRP(ch)
	case KindStellar:
		return fetchStellar(ch)
	case KindHedera:
		return fetchHedera(ch)
	case KindSui:
		return fetchSui(ch)
	case KindTon:
		return fetchTon(ch)
	case KindBitcoinLike:
		return fetchBitcoinLike(ch)
	case KindMonero:
		return fetchMonero(ch)
	case KindCardano:
		return fetchCardano(ch)
	default:
		return FinalitySample{Chain: ch.Slug, Err: "unsupported_kind"}
	}
}
