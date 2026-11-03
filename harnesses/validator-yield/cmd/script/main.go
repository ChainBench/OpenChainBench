package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Port hardcoded :2112 per the OCB Railway convention. The shared
// Prometheus scrapes every harness at <svc>.railway.internal:2112; if
// we let Railway's $PORT inject we'd silently lose scrape coverage.
// Same pattern as gas-estimation / l2-block-time.

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Validator Economics Harness ===")
	fmt.Println("OpenChainBench bench #026: net yield = gross APR x uptime, net of commission")
	fmt.Println("Scope: Solana, Hyperliquid, Ethereum, Cardano, Sui, Cosmos Hub, Avalanche, Aptos, NEAR, Kaia, Algorand, ICP, Gram, Sei, Cronos")
	fmt.Println()

	// VAL_ECON_METRICS_ADDR exists only for local runs next to another
	// :2112 process; deployments leave it unset.
	addr := envDefault("VAL_ECON_METRICS_ADDR", ":2112")
	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()
	fmt.Printf("Metrics server: %s/metrics, %s/health\n", addr, addr)
	fmt.Println()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := &http.Client{Timeout: httpTimeout}

	// Per-chain scrape goroutines. They tick on the same interval but
	// hit independent upstreams so there's no rate-limit interaction.
	go runChainScraper(ctx, client, "solana", scrapeSolana)
	go runChainScraper(ctx, client, "hyperliquid", scrapeHyperliquid)
	go runChainScraper(ctx, client, "ethereum", scrapeEthereum)
	go runChainScraper(ctx, client, "cardano", scrapeCardano)
	go runChainScraper(ctx, client, "sui", scrapeSui)
	go runChainScraper(ctx, client, "avalanche", scrapeAvalanche)
	for _, c := range cosmosChains {
		go runChainScraper(ctx, client, c.Chain, scrapeCosmosChain(c))
	}
	go runChainScraper(ctx, client, "aptos", scrapeAptos)
	go runChainScraper(ctx, client, "near", scrapeNear)
	go runChainScraper(ctx, client, "kaia", scrapeKaia)
	go runChainScraper(ctx, client, "algorand", scrapeAlgorand)
	go runChainScraper(ctx, client, "icp", scrapeICP)
	go runChainScraper(ctx, client, "gram", scrapeGram)
	// Somnia and Stellar are deliberately absent: see README.md.

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}

// runChainScraper invokes fn immediately, then every scrapeInterval.
// Each fn is expected to wrap its own HTTP calls in a context derived
// from the caller's so cancel propagates cleanly on shutdown.
func runChainScraper(ctx context.Context, client *http.Client, label string, fn func(context.Context, *http.Client)) {
	// VAL_ECON_ONLY=near,aptos runs a subset (local debugging only).
	if only := envDefault("VAL_ECON_ONLY", ""); only != "" && !strings.Contains(","+only+",", ","+label+",") {
		return
	}
	tick := func() {
		scrapeCtx, cancel := context.WithTimeout(ctx, httpTimeout*2)
		defer cancel()
		fn(scrapeCtx, client)
	}
	tick()
	t := time.NewTicker(scrapeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}
