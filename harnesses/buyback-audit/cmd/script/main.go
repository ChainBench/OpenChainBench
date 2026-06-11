package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Metrics server listens on :2112 — the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112. We deliberately ignore Railway's
// $PORT injection so a Railway-injected public port doesn't move the
// listener away from the address Prometheus expects.

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Buyback Execution Audit Harness (OCB #018) ===")
	fmt.Println("Measures executed_USD / promised_USD on-chain per protocol over 7d & 30d.")
	fmt.Println()

	if etherscanAPIKey() == "" {
		fmt.Println("[warn] ETHERSCAN_API_KEY not set — Etherscan-backed protocols (gmx, sky) will emit 0 until provided.")
	}

	for _, p := range protocols {
		fmt.Printf("[%s] treasury=%s chainid=%d share=%.0f%% llama=%s price=%s\n",
			p.Slug, p.Treasury, p.ChainID, p.BuybackShare*100, p.LlamaSlug, p.PriceID)
	}
	fmt.Println()
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	// Initialize gauges to 0 so /metrics never returns a blank scrape,
	// even before the first scrape completes.
	for _, p := range protocols {
		for _, w := range windows {
			buybackExecutedUSD.WithLabelValues(p.Slug, w.Name).Set(0)
			buybackPromisedUSD.WithLabelValues(p.Slug, w.Name).Set(0)
			buybackRatio.WithLabelValues(p.Slug, w.Name).Set(0)
		}
		buybackLastScrape.WithLabelValues(p.Slug).Set(0)
	}

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Stagger the first scrape per protocol so we don't fan-out three
	// simultaneous DeFiLlama / CoinGecko / Etherscan calls at t=0.
	for i, p := range protocols {
		p := p
		i := i
		go func() {
			time.Sleep(time.Duration(i) * 2 * time.Second)
			scrapeProtocol(ctx, p)
			t := time.NewTicker(scrapeInterval)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					scrapeProtocol(ctx, p)
				}
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}

// scrapeProtocol runs all the upstream calls for one protocol and
// writes the resulting 7d/30d gauges. Failures on any single window are
// scoped — the others still publish.
func scrapeProtocol(ctx context.Context, p Protocol) {
	scrapeCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	fmt.Printf("[%s] scrape start\n", p.Slug)

	// --- prices (shared across windows) ---
	prices, err := coingeckoUSD(scrapeCtx, p.PriceID)
	if err != nil {
		buybackScrapeErrors.WithLabelValues(p.Slug, "coingecko").Inc()
		fmt.Printf("[%s] coingecko err: %v\n", p.Slug, err)
	}
	tokenUSD := prices[p.PriceID]
	// For Hyperliquid we prefer the on-chain oracle price (matches the
	// price the AF actually paid). For other protocols we use CG.
	if p.Slug == "hyperliquid" {
		if px, err := hyperliquidHYPEOraclePrice(scrapeCtx); err == nil && px > 0 {
			tokenUSD = px
		} else if err != nil {
			buybackScrapeErrors.WithLabelValues(p.Slug, "hyperliquid_info").Inc()
			fmt.Printf("[%s] hl oracle err: %v\n", p.Slug, err)
		}
	}

	// For GMX/Sky "native chain currency price" (ETH on Arbitrum L2, ETH
	// on mainnet) we also need ETH/USD to convert outflow gas-token
	// transfers. Treasuries occasionally move ETH; the spec calls for
	// USD-ifying every outflow.
	ethPrice := 0.0
	if p.ChainID == 1 || p.ChainID == 42161 {
		if px, err := coingeckoUSD(scrapeCtx, "ethereum"); err == nil {
			ethPrice = px["ethereum"]
		} else {
			buybackScrapeErrors.WithLabelValues(p.Slug, "coingecko").Inc()
		}
	}

	for _, w := range windows {
		// --- promised side: fee_share * revenue ---
		rev, err := defillamaRevenueWindow(scrapeCtx, p.LlamaSlug, w.Dur)
		if err != nil {
			buybackScrapeErrors.WithLabelValues(p.Slug, "defillama").Inc()
			fmt.Printf("[%s][%s] defillama err: %v\n", p.Slug, w.Name, err)
		}
		promised := rev * p.BuybackShare
		buybackPromisedUSD.WithLabelValues(p.Slug, w.Name).Set(promised)

		// --- executed side: protocol-specific ---
		var executed float64
		switch p.Slug {
		case "hyperliquid":
			usd, err := hyperliquidBuybackUSD(scrapeCtx, p.Treasury, w.Dur)
			if err != nil {
				buybackScrapeErrors.WithLabelValues(p.Slug, "hyperliquid_info").Inc()
				fmt.Printf("[%s][%s] hl fills err: %v\n", p.Slug, w.Name, err)
			}
			executed = usd
		default:
			// EVM treasury: two paths.
			//   TokenAddr set → executor RECEIVES the bought-back token
			//     (e.g. Sky SBE receives SKY purchased on Uniswap). We
			//     sum ERC20 inflows × the token's CG price.
			//   TokenAddr unset → executor SPENDS native gas token; we
			//     sum native outflows × ETH price.
			if p.TokenAddr != "" {
				units, err := etherscanTokenInflows(scrapeCtx, p.ChainID, p.Treasury, p.TokenAddr, p.TokenDec, w.Dur)
				if err != nil {
					buybackScrapeErrors.WithLabelValues(p.Slug, "etherscan").Inc()
					fmt.Printf("[%s][%s] etherscan tokentx err: %v\n", p.Slug, w.Name, err)
				}
				executed = units * tokenUSD
			} else {
				outEth, err := etherscanOutflows(scrapeCtx, p.ChainID, p.Treasury, w.Dur)
				if err != nil {
					buybackScrapeErrors.WithLabelValues(p.Slug, "etherscan").Inc()
					fmt.Printf("[%s][%s] etherscan err: %v\n", p.Slug, w.Name, err)
				}
				executed = outEth * ethPrice
			}
		}
		buybackExecutedUSD.WithLabelValues(p.Slug, w.Name).Set(executed)

		ratio := 0.0
		if promised > 0 {
			ratio = executed / promised
		}
		buybackRatio.WithLabelValues(p.Slug, w.Name).Set(ratio)

		fmt.Printf("[%s][%s] promised=$%.0f executed=$%.0f ratio=%.3f (tokenUSD=%.2f)\n",
			p.Slug, w.Name, promised, executed, ratio, tokenUSD)
	}

	buybackLastScrape.WithLabelValues(p.Slug).Set(float64(time.Now().Unix()))
}

// keep the once import used by sync.Once if we add it later
var _ = sync.Once{}
