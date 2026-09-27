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
//	DUNE_MAX_DATA_AGE_DAYS  - how many whole UTC days behind the data day may be, default 3
//
// The cadence is not a knob. One execution per data day, taken once the UTC clock
// is far enough past the indexing lag, retried maxAttemptsPerDay times an hour
// apart if it fails. Credits are metered per execution, so that is the budget.
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
	// Consecutive status-call failures tolerated before a poll gives up on an
	// execution that may still be running.
	maxPollErrors = 5
)

// maxDataAgeDays is how many whole UTC days behind a platform's data day may be
// before the harness stops publishing it: 1 is yesterday, so the default of 3
// leaves room for the Solana indexing lag and for one missed execution without
// letting a frozen source through. A source that stops moving has to make the
// bench read unresponsive, not keep serving its last day as if it were today.
// DUNE_MAX_DATA_AGE_DAYS overrides it.
var maxDataAgeDays = func() int {
	if v := os.Getenv("DUNE_MAX_DATA_AGE_DAYS"); v != "" {
		// Below 2 nothing can ever publish: the target day is yesterday at best and
		// two days back before the indexing lag clears, so every row would fail the
		// window and the retry budget would buy executions that cannot land.
		if d, err := strconv.Atoi(v); err == nil && d >= 2 {
			return d
		}
		fmt.Fprintf(os.Stderr, "[init] ignoring DUNE_MAX_DATA_AGE_DAYS=%q, the window has to be 2 or more\n", v)
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
	// A failure here is not survivable: the old SQL returns no data day, every row
	// is dropped as stale and each retry pays for a query that cannot publish. So
	// it is retried from the tick and no execution runs until it has succeeded.
	synced := trySync(client, queryID, day)

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
		if !synced {
			// Nothing is executed against SQL that may not be ours.
			synced = trySync(client, queryID, targetDay(now))
			if !synced {
				return
			}
		}
		// Before the indexing lag clears, the target day is two days back. That day
		// is complete and inside the window, so it is worth running when the board
		// is empty rather than leaving every bench dark until 10:00 UTC. Once a day
		// is on the board, waiting for yesterday is what holds it to one run a day.
		if !dayIsYesterday(now) && currentPublishedDay() != "" {
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

// trySync makes the SQL in this repo the SQL Dune runs. Reports whether Dune is
// now on it.
func trySync(c *duneClient, queryID string, day time.Time) bool {
	wrote, err := c.syncQuery(queryID, day)
	switch {
	case err != nil:
		fmt.Printf("[sync] could not set query %s SQL, no execution until it works: %v\n", queryID, err)
		return false
	case wrote:
		fmt.Printf("[sync] query %s SQL updated from this build\n", queryID)
	default:
		fmt.Printf("[sync] query %s SQL already matches this build\n", queryID)
	}
	return true
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
		// A run that lands before Dune has finished loading the day comes back
		// partial or empty, and one that runs before prices.day has the day's SOL
		// row comes back with no fee figures. Taking either would throw away a
		// complete, priced day that is still inside the window, and no retry could
		// bring it back because the worse rows would be what is held. Keep the held
		// day instead. publishedDay stays behind the target, so the retries still
		// run, and the guard still ages the held day out when it gets too old.
		now := time.Now()
		newUsable, newPriced := publishableRows(rows, maxDataAgeDays, now)
		heldUsable, heldPriced := publishableRows(lastRows, maxDataAgeDays, now)
		switch {
		case newUsable == 0 && heldUsable > 0:
			fmt.Printf("[%s] result publishes nothing, keeping the day already held\n", tag)
			rows = nil
		case newPriced == 0 && heldPriced > 0:
			fmt.Printf("[%s] result has no SOL price, keeping the priced day already held\n", tag)
			rows = nil
		default:
			lastRows = rows
		}
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
	// A status call that fails is not an execution that failed: the run is still
	// billing and its result is still coming. Giving up on the first error
	// abandoned it and let the next attempt pay for the same day again, so a few
	// consecutive errors are tolerated before the wait is.
	errs := 0
	for range 60 {
		time.Sleep(30 * time.Second)
		state, err := c.executionState(execID)
		if err != nil {
			errs++
			fmt.Printf("[poll] state check failed (%d/%d): %v\n", errs, maxPollErrors, err)
			if errs >= maxPollErrors {
				// The run was paid for and may well have finished. Reading its
				// results costs nothing, and without this the next attempt pays for
				// the same day again.
				publishFrom(c, execID)
				return
			}
			continue
		}
		errs = 0
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
	fmt.Printf("[poll] execution %s timed out waiting, reading its results anyway\n", execID)
	publishFrom(c, execID)
}
