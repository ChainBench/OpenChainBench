package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// main.go — wiring layer. Owns:
//   * the SQLite store (./data.db unless RELAY_DB_PATH set)
//   * the HTTP server on :2112 (always — hard-coded per OCB convention)
//   * the 60s polling loop, ctx-cancelled by SIGINT/SIGTERM
//   * the 5min metrics refresh goroutine
//
// Backfill is LAZY by default — empty DB means we start from now. Set
// RELAY_BACKFILL_HOURS to opt into a deeper history walk. The bench
// page is expected to show "warming up" until 24h of data accumulate
// either way.

const (
	defaultDBPath     = "/app/data.db"
	pollCadence       = 60 * time.Second
	lagWindowSeconds  = 180 // re-fetch the 3-min p99 createdAt → success lag
	listenAddr        = ":2112"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Relay Revenue Harness ===")
	fmt.Println("OpenChainBench — implied margin tracker for Relay.link cross-chain swaps.")
	fmt.Println()

	dbPath := envDefault("RELAY_DB_PATH", defaultDBPath)
	store, err := OpenStore(dbPath)
	if err != nil {
		fmt.Printf("[fatal] open store at %s: %v\n", dbPath, err)
		os.Exit(1)
	}
	defer store.Close()
	fmt.Printf("Store: %s\n", dbPath)

	backfillHours := envIntDefault("RELAY_BACKFILL_HOURS", 0)
	if backfillHours < 0 {
		backfillHours = 0
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// HTTP server. Hardcoded :2112 per OCB convention; we deliberately
	// ignore $PORT so the shared Prom can scrape on the expected port.
	go func() {
		fmt.Printf("Metrics + logs server: %s/metrics\n", listenAddr)
		if err := startMetricsServer(listenAddr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	go startMetricsRefresh(ctx, store)

	client := NewRelayClient()
	pricer := buildPricer()

	// Resolve resume point. Order of preference:
	//   1. DB has data → max(created_at) - lag window
	//   2. Backfill opt-in via env → now - hours
	//   3. Lazy → 0 (loop won't filter by timestamp; will paginate
	//      until it hits a known id, which on first run = never; the
	//      relayPageMax cap protects us).
	resumeAt, err := store.resumeSince(ctx)
	if err != nil {
		fmt.Printf("[warn] resume lookup failed: %v\n", err)
		resumeAt = 0
	}
	if resumeAt == 0 && backfillHours > 0 {
		resumeAt = time.Now().Add(-time.Duration(backfillHours) * time.Hour).Unix()
		fmt.Printf("Backfill: starting from %s (-%dh)\n",
			time.Unix(resumeAt, 0).UTC().Format(time.RFC3339), backfillHours)
	} else if resumeAt > 0 {
		fmt.Printf("Resuming from %s (max - %ds)\n",
			time.Unix(resumeAt, 0).UTC().Format(time.RFC3339), lagWindowSeconds)
	} else {
		fmt.Println("Lazy start: no DB history, no RELAY_BACKFILL_HOURS — accumulating from now.")
	}
	fmt.Println()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sig
		fmt.Printf("\n[shutdown] received %v\n", s)
		cancel()
	}()

	runPollLoop(ctx, client, pricer, store, resumeAt)
	fmt.Println("[shutdown] poll loop exited cleanly")
}

// runPollLoop is the supervisor. It calls runOneCycle() every
// pollCadence; each cycle walks pagination until either (a) we hit an
// id we already have, or (b) the per-cycle page cap fires.
func runPollLoop(ctx context.Context, client *RelayClient, pricer Pricer, store *Store, startResume int64) {
	cycleStart := time.NewTimer(2 * time.Second) // first cycle fires fast
	defer cycleStart.Stop()
	ticker := time.NewTicker(pollCadence)
	defer ticker.Stop()
	resumeAt := startResume

	for {
		select {
		case <-ctx.Done():
			return
		case <-cycleStart.C:
			runOneCycle(ctx, client, pricer, store, &resumeAt)
		case <-ticker.C:
			runOneCycle(ctx, client, pricer, store, &resumeAt)
		}
	}
}

// runOneCycle walks newest-first pagination until catch-up or page cap.
// Each fetched request goes through ComputeMargin; success swaps that
// price cleanly are upserted with priced=1, pending / unpriced swaps
// land as priced=0 placeholders so the next cycle can re-price them.
//
// The function is conservative w.r.t. the resume marker: it only
// advances resumeAt forward, never backward, so a transient failure
// can't permanently lose ground.
func runOneCycle(ctx context.Context, client *RelayClient, pricer Pricer, store *Store, resumeAt *int64) {
	start := time.Now()
	var (
		continuation = ""
		newSuccess   = 0
		newPending   = 0
		pages        = 0
	)
	maxSeen := *resumeAt

	for pages < relayPageMax {
		select {
		case <-ctx.Done():
			return
		default:
		}

		opts := FetchPageOptions{
			Continuation: continuation,
		}
		if *resumeAt > 0 && continuation == "" {
			// Only set startTimestamp on the first request of a cycle;
			// the continuation cursor preserves the timestamp filter
			// server-side for subsequent pages.
			opts.StartTimestamp = *resumeAt
		}

		page, err := client.FetchPage(ctx, opts)
		if err != nil {
			fmt.Printf("[poll] fetch error: %v\n", err)
			break
		}
		pages++

		if len(page.Requests) == 0 {
			break
		}

		caughtUp := false
		for _, r := range page.Requests {
			exists, err := store.Exists(ctx, r.ID)
			if err != nil {
				fmt.Printf("[poll] store.exists(%s): %v\n", r.ID, err)
				continue
			}
			if exists {
				// We've reached known territory — stop paginating to
				// avoid burning quota on already-seen pages.
				caughtUp = true
				break
			}

			if !strings.EqualFold(r.Status, "success") {
				// Pending / failure: record a thin row so we know we
				// observed it; re-process on later cycle.
				thin := Swap{
					ID:        r.ID,
					CreatedAt: parseTSOrNow(r.CreatedAt),
					Status:    r.Status,
					ChainIn:   r.Data.Metadata.CurrencyIn.Currency.ChainID,
					ChainOut:  r.Data.Metadata.CurrencyOut.Currency.ChainID,
					Priced:    false,
				}
				if err := store.Upsert(ctx, thin); err != nil {
					fmt.Printf("[poll] upsert pending %s: %v\n", r.ID, err)
				}
				newPending++
				if thin.CreatedAt > maxSeen {
					maxSeen = thin.CreatedAt
				}
				continue
			}

			sw, err := ComputeMargin(ctx, r, pricer)
			if err != nil {
				fmt.Printf("[poll] compute %s: %v\n", r.ID, err)
				continue
			}
			if err := store.Upsert(ctx, sw); err != nil {
				fmt.Printf("[poll] upsert %s: %v\n", r.ID, err)
				continue
			}
			newSuccess++
			if sw.CreatedAt > maxSeen {
				maxSeen = sw.CreatedAt
			}
		}

		if caughtUp || page.Continuation == "" {
			break
		}
		continuation = page.Continuation
	}

	// Advance resume marker by max(seen) - lag window. Only ever
	// forward, never back.
	if maxSeen > 0 {
		candidate := maxSeen - lagWindowSeconds
		if candidate > *resumeAt {
			*resumeAt = candidate
		}
	}

	dur := time.Since(start)
	relayLastPollTimestamp.Set(float64(time.Now().Unix()))
	relayPollDurationSeconds.Set(dur.Seconds())
	relayNewSwapsPerCycle.Set(float64(newSuccess))
	fmt.Printf("[poll] cycle done in %s: pages=%d new_success=%d new_pending=%d resume=%d\n",
		dur.Round(time.Millisecond), pages, newSuccess, newPending, *resumeAt)
}

func parseTSOrNow(s string) int64 {
	v, err := parseRelayTimestamp(s)
	if err != nil {
		return time.Now().Unix()
	}
	return v
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envIntDefault(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
