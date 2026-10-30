package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// Metrics server listens on :2112 — the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112.

var currentRegion = loadRegion()

func loadRegion() string {
	if r := strings.TrimSpace(os.Getenv("REGION")); r != "" {
		return r
	}
	if r := normalizeRailwayRegion(os.Getenv("RAILWAY_REPLICA_REGION")); r != "" {
		return r
	}
	return "eu-west"
}

func normalizeRailwayRegion(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return ""
	}
	switch {
	case strings.HasPrefix(raw, "us-"), strings.HasPrefix(raw, "northamerica"):
		return "us-east"
	case strings.HasPrefix(raw, "europe"), strings.HasPrefix(raw, "eu-"):
		return "eu-west"
	case strings.HasPrefix(raw, "asia"), strings.HasPrefix(raw, "ap-"):
		return "sgp"
	default:
		return raw
	}
}

func main() {
	fmt.Println("=== RPC Keyed Free-Tier Latency Harness ===")
	fmt.Println("OpenChainBench - latency of signup-gated free-tier RPC endpoints.")
	fmt.Printf("Region: %s | probe interval: %s | quota guard at 90%%\n", currentRegion, probeInterval())
	fmt.Println()

	eps := endpoints()
	if len(eps) == 0 {
		fmt.Println("[fatal] no RPC_KEYED_URL_* env vars set — nothing to probe")
		os.Exit(1)
	}
	for _, e := range eps {
		fmt.Printf("  - %-12s %-10s budget(region)=%d req/mo\n", e.Provider, e.Chain, budgetFor(e.Provider))
	}
	fmt.Println()
	addr := ":2112"
	if v := strings.TrimSpace(os.Getenv("METRICS_ADDR")); v != "" {
		addr = v
	}
	fmt.Printf("Metrics server: %s/metrics\n", addr)
	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Before trusting the region label on anything this probe publishes, check
	// that the traffic really leaves from that part of the world. See egress.go
	// for the ninety minutes of Singapore numbers served from California.
	StartEgressWatch(ctx)
	StartProbeLoop(ctx)
	// Bench 310, API coverage. Gated to one region by RPC_KEYED_COVERAGE
	// because capability is a property of the plan, not of where the caller
	// sits, so three regions would pay three times for one answer.
	StartCoverageLoop(ctx)
	// The two eth_call legs again, hourly, in the coverage region only. The
	// capability pass answers a question that changes monthly; the work term
	// is a measurement and needs samples, and four readings a day cannot say
	// whether it separates providers. See heavycall.go for the arithmetic
	// that kept this to two probes rather than all twelve.
	StartHeavyLane(ctx)
	// The WebSocket arm shares this process on purpose: its headline metric is
	// a race between providers on the same block, and arrival times from
	// separate processes would compare clocks. See ws.go.
	StartWSLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
