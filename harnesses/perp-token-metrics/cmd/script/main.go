package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type protocol struct {
	slug      string // bench slug / prometheus label
	llamaSlug string // DeFiLlama fees slug
	cgID      string // CoinGecko coin ID (empty = no FDV)
}

var protocols = []protocol{
	{slug: "hyperliquid", llamaSlug: "hyperliquid", cgID: "hyperliquid"},
	{slug: "gmx", llamaSlug: "gmx", cgID: "gmx"},
	{slug: "gains", llamaSlug: "gains-network", cgID: "gains-network"},
	{slug: "dydx", llamaSlug: "dydx", cgID: "dydx"},
	{slug: "drift", llamaSlug: "drift", cgID: "drift-protocol"},
}

func addr() string {
	if v := os.Getenv("METRICS_ADDR"); v != "" {
		return v
	}
	return ":2112"
}

func main() {
	fmt.Println("=== perp-token-metrics harness ===")
	fmt.Println("OpenChainBench #234 — perp DEX token P/E ratios")
	fmt.Printf("Protocols: %d | poll interval: 1h\n", len(protocols))

	go func() {
		if err := startMetricsServer(addr()); err != nil {
			fmt.Fprintf(os.Stderr, "metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	poll()

	ticker := time.NewTicker(60 * time.Minute)
	defer ticker.Stop()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)

	for {
		select {
		case <-ticker.C:
			poll()
		case s := <-sig:
			fmt.Printf("signal %v — exiting\n", s)
			return
		}
	}
}

func poll() {
	fmt.Printf("[%s] polling DeFiLlama + CoinGecko\n", time.Now().UTC().Format(time.RFC3339))

	// collect CoinGecko FDVs in one batch call
	cgIDs := []string{}
	for _, p := range protocols {
		if p.cgID != "" {
			cgIDs = append(cgIDs, p.cgID)
		}
	}
	fdvMap := fetchCGFdvBatch(cgIDs)

	for _, p := range protocols {
		rev24h, avg30d, ok := fetchLlamaRevenue(p.llamaSlug)
		if !ok {
			fmt.Printf("  [%s] DeFiLlama fetch failed\n", p.slug)
			protocolHealth.WithLabelValues(p.slug).Set(0)
			continue
		}

		annualRev := avg30d * 365
		fdv, hasFDV := fdvMap[p.cgID]
		var pe float64
		hasPE := hasFDV && annualRev > 0
		if hasPE {
			pe = fdv / annualRev
		}

		protocolRev24h.WithLabelValues(p.slug).Set(rev24h)
		protocolAnnualRev.WithLabelValues(p.slug).Set(annualRev)
		if hasFDV {
			protocolFDV.WithLabelValues(p.slug).Set(fdv)
		}
		if hasPE {
			protocolPE.WithLabelValues(p.slug).Set(pe)
		}
		protocolHealth.WithLabelValues(p.slug).Set(1)

		fmt.Printf("  [%s] rev24h=$%.0f avg30d=$%.0f annual=$%.0f fdv=$%.0f pe=%.1fx\n",
			p.slug, rev24h, avg30d, annualRev, fdv, pe)
	}
}
