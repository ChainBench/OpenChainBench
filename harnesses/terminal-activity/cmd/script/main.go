// terminal-activity -- benches 203, 206, 207 and 232
//
// Daily routed volume, swap transactions, platform fees and distinct wallets per
// trading terminal, per chain, from the public tehcscreener API (Allium-backed,
// no key). See api.go for the source and why it is not a cheaper route to Dune.
//
// This replaces harnesses/dune-platform-volume as the source for these four
// benches. They were gated to staging on 2026-10-02 when the Dune trial ended,
// under the note "these four have no free equivalent for what they measure".
// The four figures they need are all here, and two of them come out richer: the
// source is per chain rather than Solana-only, and it carries fees for every
// chain rather than only where a SOL close was available.
//
// What this harness does NOT cover, so bench 203 keeps one dark panel: the share
// of trades that actually paid a fee. The source reports fee totals, not the
// fee-paying share of transactions, and no arithmetic on the fields here
// recovers it.
//
// Optional env vars:
//
//	TERMINAL_ACTIVITY_ADDR       - listen address, default :2116
//	TERMINAL_ACTIVITY_INTERVAL   - cycle period, default 30m
//	TERMINAL_ACTIVITY_MAX_AGE    - whole UTC days the data day may lag, default 3
//	TEHCSCREENER_BASE            - API base, default https://tehcscreener.com/api/v1
//
// The cadence is not a knob worth turning down. The source syncs once a day, so
// polling faster buys nothing; 30 minutes exists so a deploy or a late sync is
// picked up within the hour rather than the next day.
//
// Metrics on :2116/metrics:
//
//	terminal_volume_usd{platform,chain}
//	terminal_txns{platform,chain}
//	terminal_fees_usd{platform,chain}
//	terminal_wallets{platform,chain}
//	terminal_avg_trade_usd{platform,chain}
//	terminal_fee_rate_pct{platform,chain}
//	terminal_trades_per_wallet{platform,chain}
//	terminal_volume_per_wallet_usd{platform,chain}
//	terminal_chain_breadth{platform}
//	terminal_data_day_unix{platform,chain}
//	terminal_activity_health{platform,chain}
//	terminal_activity_last_success_unix
//	terminal_fee_column_ok{chain}
//	terminal_fee_withheld{platform,chain}
package main

import (
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const (
	defaultAddr     = ":2116"
	defaultInterval = 30 * time.Minute
	httpTimeout     = 45 * time.Second
	// Pause between per-bot calls. The API allows 120 requests a minute and a
	// cycle makes one call plus one per bot, about a dozen, so this is politeness
	// rather than necessity: a free keyless endpoint that a harness hammers is a
	// free keyless endpoint that stops being free.
	perBotPause = 300 * time.Millisecond
)

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// maxDataAgeDays is how many whole UTC days behind the data day may be before a
// pair stops publishing. The source's `through` is normally yesterday, so 1 is
// the healthy state and the default of 3 absorbs a missed sync without letting a
// frozen feed through. Below 2 nothing could ever publish.
func maxDataAgeDays() int {
	if v := os.Getenv("TERMINAL_ACTIVITY_MAX_AGE"); v != "" {
		if d, err := strconv.Atoi(v); err == nil && d >= 2 {
			return d
		}
		log.Printf("TERMINAL_ACTIVITY_MAX_AGE=%q ignored, must be an integer >= 2", v)
	}
	return 3
}

func main() {
	addr := envDefault("TERMINAL_ACTIVITY_ADDR", defaultAddr)
	interval := defaultInterval
	if v := os.Getenv("TERMINAL_ACTIVITY_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= time.Minute {
			interval = d
		} else {
			log.Printf("TERMINAL_ACTIVITY_INTERVAL=%q ignored, must be a duration >= 1m", v)
		}
	}
	client := newAPIClient(envDefault("TEHCSCREENER_BASE", apiBase), httpTimeout)

	go func() {
		log.Printf("metrics on %s", addr)
		if err := startMetricsServer(addr); err != nil {
			log.Fatalf("metrics server: %v", err)
		}
	}()

	cycle(client)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case <-ticker.C:
			cycle(client)
		case <-stop:
			log.Printf("shutting down")
			return
		}
	}
}

// cycle reads the roster, then each bot, and publishes one day per pair.
//
// A failed roster read returns without touching a gauge. That is deliberate: the
// previous cycle's figures carry a data_day_unix and a health of 1 that are both
// still true, and the freshness gate on the next successful cycle, or the
// last_success timestamp on a spec, is what makes a prolonged outage visible.
// Dropping the board because one HTTP call failed would turn a blip into an
// empty page.
func cycle(client *apiClient) {
	roster, err := client.roster()
	if err != nil {
		log.Printf("roster: %v (keeping the previous cycle's figures)", err)
		return
	}
	if len(roster) == 0 {
		log.Printf("roster empty, keeping the previous cycle's figures")
		return
	}

	var samples []sample
	failed := 0
	for i, id := range roster {
		if i > 0 {
			time.Sleep(perBotPause)
		}
		d, err := client.bot(id)
		if err != nil {
			log.Printf("bot %s: %v", id, err)
			failed++
			continue
		}
		samples = append(samples, latestSamples(d)...)
	}

	// Every per-bot call failing while the roster call worked is not a quiet
	// market, it is the API having changed shape or started refusing us. Publish
	// nothing rather than drop every row, for the same reason cycle returns early
	// on a roster error.
	if failed == len(roster) {
		log.Printf("all %d per-bot reads failed, keeping the previous cycle's figures", failed)
		return
	}

	published, chains := publish(samples, canonicalRoster(roster), maxDataAgeDays(), time.Now())
	if published > 0 {
		lastSuccessUnix.SetToCurrentTime()
	}
	log.Printf("cycle complete: %d rows across %d chains (%v), %d of %d bots read, %d read errors",
		published, len(chains), chains, len(roster)-failed, len(roster), failed)
}
