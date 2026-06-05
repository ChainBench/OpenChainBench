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
// <service>.railway.internal:2112. We deliberately ignore Railway's
// $PORT injection so a Railway-injected public port doesn't move the
// listener away from the address Prometheus expects. Same fix as
// l2-block-time (see mobula-api commit 833026a719).

// currentRegion is the value stamped onto every emitted Prometheus
// label as `region=`. Set once at startup. Resolution order:
//   1. $REGION  (explicit override — set this when running 3 separate
//      Railway services instead of replicas of one)
//   2. $RAILWAY_REPLICA_REGION  (Railway sets this per replica when
//      a single service is scaled across regions via "Add Region")
//   3. "eu-west" (back-compat default for the original single-region
//      deploy that pre-dates region labeling)
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

// Railway exposes replica region as raw GCP-style slugs like
// "us-east4-eqdc4a" / "europe-west4-drams5" / "asia-southeast1-eqsg3a".
// We map them down to the canonical 3-region set the bench publishes
// (us-east / eu-west / sgp) so the Prom label space stays small.
// Unknown values pass through so a new Railway region surfaces in the
// metric instead of silently bucketing as "eu-west".
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
	fmt.Println("=== RPC Capabilities Harness ===")
	fmt.Println("OpenChainBench - public RPC latency, reliability, and archive depth.")
	fmt.Printf("Region: %s (set via $REGION env)\n", currentRegion)
	fmt.Println()

	for _, c := range chains() {
		fmt.Printf("[%s] %d providers\n", c.Slug, len(c.Providers))
		for _, p := range c.Providers {
			fmt.Printf("  - %-12s %s\n", p.Slug, p.URL)
		}
	}
	fmt.Println()
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	StartProbeLoop(ctx)
	StartArchiveLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
