package main

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	region := loadRegion()
	fmt.Printf("=== pm-geographic-access harness (region=%s) ===\n", region)
	fmt.Println("HTTP probes to each venue's market listing endpoint. 200 OK = accessible, 4xx/error = blocked.")
	fmt.Println("Exposes /metrics on :2112.")

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[pm-geographic-access] metrics server error: %v\n", err)
			os.Exit(1)
		}
	}()

	// First probe immediately at startup.
	runAllProbes(region)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Println("[pm-geographic-access] shutting down")
			return
		case <-ticker.C:
			runAllProbes(region)
		}
	}
}

// loadRegion reads the probe region from env vars. Same resolution order
// as pm-rate-limits so the Prometheus label space is consistent.
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
