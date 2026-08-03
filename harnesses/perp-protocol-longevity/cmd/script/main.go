// perp-protocol-longevity -- Bench 119
//
// Computes a live "days clean" counter for each perp DEX based on a
// versioned incident registry seeded from rekt.news / DeFiLlama post-mortems.
// The registry is enriched daily by polling https://api.llama.fi/hacks so new
// incidents are picked up without a harness redeploy.
//
// Metrics exposed on :2112/metrics:
//
//	perp_protocol_days_clean{venue}                        -- primary, higher is better
//	perp_protocol_incidents_total{venue}
//	perp_protocol_incident_amount_usd{venue}
//	perp_protocol_launch_timestamp_seconds{venue}
//	perp_protocol_registry_last_updated_timestamp_seconds
//	perp_protocol_health{venue}
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	fmt.Println("=== perp-protocol-longevity harness ===")
	fmt.Println("Bench 119 -- days clean counter, enriched daily from DeFiLlama.")

	registry = enrichFromDefiLlama(registry)
	lastEnriched := time.Now()

	fmt.Printf("Registry date: %s. Venues: %d.\n", registryUpdatedAt.Format("2006-01-02"), len(registry))
	fmt.Println("Exposes /metrics, /health on :2112.")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("metrics server error: %v\n", err)
			os.Exit(1)
		}
	}()

	publishAll()
	logCurrentCounts()

	tick := time.NewTicker(time.Hour)
	defer tick.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Println("shutting down")
			return
		case <-tick.C:
			if time.Since(lastEnriched) >= 24*time.Hour {
				registry = enrichFromDefiLlama(registry)
				lastEnriched = time.Now()
			}
			publishAll()
			logCurrentCounts()
		}
	}
}

func logCurrentCounts() {
	now := float64(time.Now().Unix())
	for _, vr := range registry {
		streakStart := float64(cleanStreakStart(vr))
		days := (now - streakStart) / 86400
		if len(vr.Incidents) == 0 {
			fmt.Printf("[LONGEVITY][%s] %.1f days clean since launch (%s), 0 incidents\n",
				vr.Slug, days, vr.Launched.Format("2006-01-02"))
		} else {
			fmt.Printf("[LONGEVITY][%s] %.1f days since last incident, %d total incident(s), $%.0f net lost\n",
				vr.Slug, days, len(vr.Incidents), totalIncidentAmount(vr))
		}
	}
}
