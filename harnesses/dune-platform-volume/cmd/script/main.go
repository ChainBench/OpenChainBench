// dune-platform-volume -- Bench 201
//
// Measures one complete UTC day of Solana trading volume, transactions, platform
// fees and unique wallets per trading platform, with our own SQL over Dune's
// solana.account_activity, dex_solana.trades and prices.day. See querySQL in
// dune.go for the attribution method and for why the third-party daily datasets
// this harness used to read were dropped.
//
// Required env vars:
//
//	DUNE_API_KEY  - Dune Analytics API key
//
// Optional env vars:
//
//	DUNE_QUERY_ID           - existing Dune query to execute; created on first run when unset
//	DUNE_REFRESH_HOURS      - executions are metered per run, default 24
//	DUNE_MAX_DATA_AGE_DAYS  - how many whole UTC days behind the data day may be, default 3
//
// Metrics on :2112/metrics:
//
//	dune_platform_volume_24h_usd{platform}
//	dune_platform_volume_data_day_unix{platform}
//	dune_platform_volume_health{platform}
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	fetchInterval = 15 * time.Minute
	// Retry budget for one data day. A query that cannot run must stop costing
	// credits and let the freshness guard make the benches unresponsive.
	maxAttemptsPerDay = 3
	retryBackoff      = time.Hour
)

// refreshInterval is how often a fresh Dune execution is requested (credits
// are metered per execution; the plan is sized for one a day per query).
// DUNE_REFRESH_HOURS overrides it.
var refreshInterval = func() time.Duration {
	if v := os.Getenv("DUNE_REFRESH_HOURS"); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h > 0 {
			return time.Duration(h) * time.Hour
		}
	}
	return 24 * time.Hour
}()

// maxDataAgeDays is how many whole UTC days behind a platform's data day may be
// before the harness stops publishing it: 1 is yesterday, so the default of 3
// leaves room for the Solana indexing lag and for one missed execution without
// letting a frozen source through. A source that stops moving has to make the
// bench read unresponsive, not keep serving its last day as if it were today.
// DUNE_MAX_DATA_AGE_DAYS overrides it.
var maxDataAgeDays = func() int {
	if v := os.Getenv("DUNE_MAX_DATA_AGE_DAYS"); v != "" {
		if d, err := strconv.Atoi(v); err == nil && d >= 0 {
			return d
		}
	}
	return 3
}()

func main() {
	fmt.Println("=== dune-platform-volume harness ===")
	fmt.Println("OpenChainBench Bench 201 -- Solana trading platform daily metrics, our own SQL over Dune's tables.")

	apiKey := os.Getenv("DUNE_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "[fatal] DUNE_API_KEY not set")
		os.Exit(1)
	}

	queryID := os.Getenv("DUNE_QUERY_ID")
	client := newDuneClient(apiKey)
	day := targetDay(time.Now())

	if queryID == "" {
		fmt.Println("[init] DUNE_QUERY_ID not set, creating Dune query...")
		id, err := client.createQuery(day)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[fatal] failed to create Dune query: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[init] Dune query created: %s\n", id)
		fmt.Printf("[init] Set DUNE_QUERY_ID=%s and restart the harness.\n", id)
		os.Exit(0)
	}

	// Make the SQL in this repo the SQL Dune runs, so a deploy cannot leave an
	// older query behind. Writing it costs nothing, but it does bump the query
	// version and drop the cached result, so it only happens when the SQL differs.
	switch wrote, err := client.syncQuery(queryID, day); {
	case err != nil:
		fmt.Printf("[init] could not sync query %s SQL: %v\n", queryID, err)
	case wrote:
		fmt.Printf("[init] query %s SQL updated from this build\n", queryID)
	default:
		fmt.Printf("[init] query %s SQL already matches this build\n", queryID)
	}

	go func() {
		if err := startMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	// One execution for each data day, and only once the UTC clock is far enough
	// past the indexing lag for the target day to be yesterday: a container that
	// happens to start at 02:00 UTC would otherwise spend its run measuring the day
	// before that. The gate is the day itself, not the age of the cached result:
	// an age gate measured from Dune's own end time drifts a quarter of an hour
	// later every day and eventually walks a run past midnight, skipping a day
	// altogether, and it cannot tell a failed execution from one never tried.
	var inFlight atomic.Bool
	var attemptDay string
	var attempts int
	var lastAttempt time.Time
	maybeRefresh := func() {
		if inFlight.Load() {
			return
		}
		now := time.Now()
		if !dayIsYesterday(now) {
			return
		}
		d := targetDay(now)
		want := dayString(d)
		// Already on the board.
		if currentPublishedDay() == want {
			return
		}
		if attemptDay != want {
			attemptDay, attempts = want, 0
		}
		// A deterministic failure, a renamed Spellbook column say, must not turn
		// into a run every fetch tick until midnight. Three tries a day, an hour
		// apart, then the freshness guard takes over and the benches go
		// unresponsive, which is the correct outcome for a query that cannot run.
		if attempts >= maxAttemptsPerDay {
			return
		}
		if !lastAttempt.IsZero() && now.Sub(lastAttempt) < retryBackoff {
			return
		}
		attempts++
		lastAttempt = now
		execID, err := client.execute(queryID, d)
		if err != nil {
			fmt.Printf("[refresh] execute for %s failed (attempt %d/%d): %v\n", want, attempts, maxAttemptsPerDay, err)
			return
		}
		fmt.Printf("[refresh] execution %s started for %s (attempt %d/%d)\n", execID, want, attempts, maxAttemptsPerDay)
		inFlight.Store(true)
		go func() {
			defer inFlight.Store(false)
			pollUntilDone(client, queryID, execID)
		}()
	}

	// Unresponsive until something is fetched, rather than absent.
	markAllUnresponsive(publishedPlatforms)
	// One read of whatever ran last, so a restart picks the board back up without
	// spending an execution. After this, figures only arrive from an execution this
	// harness ran and read back by its own id: re-reading the unparameterized
	// /query/{id}/results on a timer could only overwrite them with an older day.
	runFetch(client, queryID)
	// No execution on start. A deploy waits one tick, which keeps a restart loop
	// during a failing day from spending the per-day retry budget again each time
	// the process comes up: that budget lives in memory and does not survive a
	// restart, so the 15 minutes is the only thing bounding it.
	tick := time.NewTicker(fetchInterval)
	defer tick.Stop()

	for {
		select {
		case <-sig:
			fmt.Println("[shutdown] received signal")
			return
		case <-tick.C:
			// Re-run the guard over what is held, so figures age out on their own
			// clock even when no execution succeeds.
			publish("guard", nil)
			maybeRefresh()
		}
	}
}

// lastRows is what the last successful read returned. Every tick re-runs the
// freshness guard over it, so a fetch that starts failing, on a rotated key or a
// Dune outage, does not leave the previous day's figures on the board reading as
// healthy: the guard ages them out on its own clock and the benches go
// unresponsive.
//
// The main loop and the polling goroutine both reach this, and the loop keeps
// ticking while an execution is in flight, so lastRows, publishedDay and the
// publishRows call itself are all behind publishMu.
var (
	publishMu sync.Mutex
	lastRows  []duneRow
)

// publish applies the guard and reports what landed. rows nil means "re-run the
// guard over what is already held", which is what a failed read does.
func publish(tag string, rows []duneRow) {
	publishMu.Lock()
	defer publishMu.Unlock()
	if rows != nil {
		lastRows = rows
	}
	if lastRows == nil {
		return
	}
	published, dropped := publishRows(lastRows, maxDataAgeDays, time.Now(), publishedPlatforms)
	fmt.Printf("[%s] published %d platform(s): %v\n", tag, len(published), published)
	if len(dropped) > 0 {
		fmt.Printf("[%s] dropped %d platform(s) past the %d-day freshness window or absent from the result: %v\n",
			tag, len(dropped), maxDataAgeDays, dropped)
	}
}

// currentPublishedDay is the data day on the board, or "" when nothing is.
func currentPublishedDay() string {
	publishMu.Lock()
	defer publishMu.Unlock()
	return publishedDay
}

func runFetch(c *duneClient, queryID string) {
	rows, err := c.latestResult(queryID)
	if err != nil {
		fmt.Printf("[fetch] failed: %v\n", err)
		publish("stale", nil)
		return
	}
	publish("fetch", rows)
}

// publishFrom publishes the results of one execution, read back by its own id so
// the day that ran is the day that lands.
func publishFrom(c *duneClient, execID string) {
	rows, err := c.executionResult(execID)
	if err != nil {
		fmt.Printf("[poll] reading execution %s results failed: %v\n", execID, err)
		publish("stale", nil)
		return
	}
	publish("poll", rows)
}

func pollUntilDone(c *duneClient, queryID, execID string) {
	for range 60 {
		time.Sleep(30 * time.Second)
		state, err := c.executionState(execID)
		if err != nil {
			fmt.Printf("[poll] state check failed: %v\n", err)
			return
		}
		switch state {
		case "QUERY_STATE_COMPLETED":
			fmt.Printf("[poll] execution %s complete\n", execID)
			publishFrom(c, execID)
			return
		case "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED":
			fmt.Printf("[poll] execution %s ended with state %s\n", execID, state)
			return
		}
	}
	fmt.Printf("[poll] execution %s timed out waiting\n", execID)
}
