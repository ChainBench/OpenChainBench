// perp-volume-history: daily perp DEX volume per venue, UTC-day buckets,
// backfilled and kept current, the way DeFiLlama's derivatives page cuts
// it but without the paid endpoint.
//
// DeFiLlama's perp volume API went behind the paid plan in 2026 (402 on
// /overview/derivatives and /summary/derivatives/*). Its adapters are
// open source though (github.com/DefiLlama/dimension-adapters), so this
// harness reads the same upstream each adapter reads, on the same UTC
// day boundaries. With DEFILLAMA_API_KEY set it reads the Pro API
// instead and every venue becomes DeFiLlama's own number.
//
// Outputs:
//   - Prometheus gauges on :2112/metrics (last closed day, 7d, 30d sums,
//     cohort share, history depth, health) for bench 266.
//   - JSON history on :2112/v1/history (all venues, every stored day)
//     for the site's compare hero and venue pages. The same document is
//     mirrored to HISTORY_FILE_PUBLIC when set, so Caddy can serve it as
//     a static file.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	fmt.Println("=== perp-volume-history harness ===")
	fmt.Println("OpenChainBench #266: daily perp DEX volume, UTC days, backfilled")

	storePath := env("HISTORY_FILE", "/data/perp-volume-history.json")
	publicPath := env("HISTORY_FILE_PUBLIC", "")
	backfillDays := envInt("BACKFILL_DAYS", 400)
	refreshDays := envInt("REFRESH_DAYS", 3)
	tick := time.Duration(envInt("TICK_MINUTES", 60)) * time.Minute
	llamaKey := os.Getenv("DEFILLAMA_API_KEY")

	store, err := openStore(storePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "store: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("store: %s (%d venues, %d day-points)\n", storePath, store.venueCount(), store.pointCount())

	sources := buildSources(llamaKey)
	currentSources = sources
	fmt.Printf("sources: %d venues | backfill %dd | refresh last %dd | tick %s | defillama pro: %v\n",
		len(sources), backfillDays, refreshDays, tick, llamaKey != "")

	go func() {
		if err := startServer(env("METRICS_ADDR", ":2112"), store); err != nil {
			fmt.Fprintf(os.Stderr, "http server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Publish whatever the store already holds before the first sweep so
	// a restart never blanks the gauges while a slow source backfills.
	publish(store, sources)
	go func() {
		if publicPath != "" {
			_ = store.writePublic(publicPath, sources)
		}
	}()

	go runLoop(ctx, store, sources, backfillDays, refreshDays, tick, publicPath)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Println("shutting down")
	cancel()
	_ = store.flush()
}

// runLoop backfills every venue that has less history than requested,
// then on every tick re-reads the last refreshDays closed days (sources
// restate D-1 for a day or two) and publishes the gauges.
func runLoop(ctx context.Context, store *Store, sources []Source, backfillDays, refreshDays int, tick time.Duration, publicPath string) {
	for {
		start := time.Now()
		today := utcDay(time.Now())
		lastClosed := today.AddDate(0, 0, -1)

		// Every source runs in its own goroutine: they are independent
		// HTTP fan-outs and one slow or rate-limited venue (dYdX on
		// 2026-09-14) must not hold the others back. The store and the
		// gauges are mutex-safe; each venue flushes and publishes as soon
		// as it lands.
		var wg sync.WaitGroup
		for _, src := range sources {
			if ctx.Err() != nil {
				return
			}
			from := lastClosed.AddDate(0, 0, -(refreshDays - 1))
			// A venue that has no data yet, or whose oldest stored day is
			// younger than the backfill horizon, is walked back to the
			// horizon (bounded by the source's own start date).
			horizon := today.AddDate(0, 0, -backfillDays)
			if s := src.Start(); s.After(horizon) {
				horizon = s
			}
			backfill := false
			if oldest, ok := store.oldest(src.Slug()); (!ok || oldest.After(horizon)) && !store.backfilledTo(src.Slug(), horizon) {
				from = horizon
				backfill = true
			}
			wg.Add(1)
			go func(src Source, from, horizon time.Time, backfill bool) {
				defer wg.Done()
				if runSource(ctx, store, src, from, lastClosed) && backfill {
					store.markBackfilled(src.Slug(), horizon)
				}
				if err := store.flush(); err != nil {
					fmt.Fprintf(os.Stderr, "store flush: %v\n", err)
				}
				publish(store, sources)
			}(src, from, horizon, backfill)
		}
		wg.Wait()

		publish(store, sources)
		if err := store.flush(); err != nil {
			fmt.Fprintf(os.Stderr, "store flush: %v\n", err)
		}
		if publicPath != "" {
			if err := store.writePublic(publicPath, sources); err != nil {
				fmt.Fprintf(os.Stderr, "public write: %v\n", err)
			}
		}
		lastTick.Set(float64(time.Now().Unix()))
		fmt.Printf("[sweep] done in %s\n", time.Since(start).Round(time.Second))

		select {
		case <-ctx.Done():
			return
		case <-time.After(tick):
		}
	}
}

// runSource fetches one venue over [from, to] and stores what came
// back. It reports whether the fetch succeeded (a zero-day success still
// counts: the source simply has no history that far back).
func runSource(ctx context.Context, store *Store, src Source, from, to time.Time) bool {
	t0 := time.Now()
	points, err := src.Daily(ctx, from, to)
	if err != nil {
		fetchErrors.WithLabelValues(src.Slug(), src.Name()).Inc()
		fmt.Printf("[%s][%s] %s..%s err: %v\n", src.Slug(), src.Name(), fmtDay(from), fmtDay(to), err)
		return false
	}
	n := 0
	for day, usd := range points {
		if usd < 0 {
			continue
		}
		store.set(src.Slug(), day, usd, src.Name())
		n++
	}
	lastRefresh.WithLabelValues(src.Slug(), src.Name()).Set(float64(time.Now().Unix()))
	fmt.Printf("[%s][%s] %s..%s ok: %d days in %s\n", src.Slug(), src.Name(), fmtDay(from), fmtDay(to), n, time.Since(t0).Round(time.Millisecond))
	return true
}

// publish derives the bench gauges from the store: last closed UTC day,
// trailing 7 and 30 closed days, share of the cohort on each window, and
// how many days of history each venue holds.
func publish(store *Store, sources []Source) {
	lastClosed := utcDay(time.Now()).AddDate(0, 0, -1)
	type agg struct{ d1, d7, d30 float64 }
	per := map[string]agg{}
	var cohort agg
	for _, src := range sources {
		slug := src.Slug()
		d1, ok1 := store.get(slug, lastClosed)
		d7, n7 := store.sum(slug, lastClosed.AddDate(0, 0, -6), lastClosed)
		d30, n30 := store.sum(slug, lastClosed.AddDate(0, 0, -29), lastClosed)
		days := store.days(slug)

		historyDays.WithLabelValues(slug).Set(float64(days))
		if ok1 {
			volume.WithLabelValues(slug, "1d").Set(d1)
			health.WithLabelValues(slug).Set(1)
		} else {
			volume.DeleteLabelValues(slug, "1d")
			// A venue whose last closed day is missing is late, not down:
			// the D-1 row usually lands within hours. Health drops only
			// when nothing arrived for three days.
			if _, ok := store.get(slug, lastClosed.AddDate(0, 0, -3)); ok {
				health.WithLabelValues(slug).Set(1)
			} else {
				health.WithLabelValues(slug).Set(0)
			}
		}
		// A window is published only when every day inside it is present,
		// so a partial backfill never reads as a low week.
		if n7 == 7 {
			volume.WithLabelValues(slug, "7d").Set(d7)
		} else {
			volume.DeleteLabelValues(slug, "7d")
		}
		if n30 == 30 {
			volume.WithLabelValues(slug, "30d").Set(d30)
		} else {
			volume.DeleteLabelValues(slug, "30d")
		}
		a := agg{}
		if ok1 {
			a.d1 = d1
		}
		if n7 == 7 {
			a.d7 = d7
		}
		if n30 == 30 {
			a.d30 = d30
		}
		per[slug] = a
		cohort.d1 += a.d1
		cohort.d7 += a.d7
		cohort.d30 += a.d30
		sourceUsed.WithLabelValues(slug, src.Name()).Set(1)
	}
	for slug, a := range per {
		setShare(slug, "1d", a.d1, cohort.d1)
		setShare(slug, "7d", a.d7, cohort.d7)
		setShare(slug, "30d", a.d30, cohort.d30)
	}
	cohortVolume.WithLabelValues("1d").Set(cohort.d1)
	cohortVolume.WithLabelValues("7d").Set(cohort.d7)
	cohortVolume.WithLabelValues("30d").Set(cohort.d30)
}

func setShare(slug, window string, v, total float64) {
	if v > 0 && total > 0 {
		share.WithLabelValues(slug, window).Set(v / total * 100)
	} else {
		share.DeleteLabelValues(slug, window)
	}
}

// utcDay truncates t to midnight UTC.
func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func fmtDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

func parseDay(s string) (time.Time, error) {
	return time.Parse("2006-01-02", s)
}
