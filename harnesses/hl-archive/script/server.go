// server.go — HTTP API + internal cron loop.
//
// Three public endpoints:
//   GET /health                — open, JSON snapshot of store stats
//   GET /metrics               — open, Prometheus text format
//   GET /v1/aggregates?window= — auth required (X-API-Key), JSON
//
// Auth: any non-open route requires X-API-Key matching the env
// HL_ARCHIVE_API_KEY. Empty env aborts serve mode at startup.
//
// Cron loop: a single goroutine sleeps until HL_ARCHIVE_CRON_HOUR
// UTC every day, then runs DailyJob.
package script

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const serviceVersion = "1.0.0"

// Serve blocks until ctx is cancelled.
func Serve(ctx context.Context, store *Store, builders []Builder, apiKey, addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", instrument("/health", handleHealth(store)))
	mux.Handle("/metrics", instrument("/metrics", promhttp.Handler().ServeHTTP))
	mux.HandleFunc("/v1/aggregates", instrument("/v1/aggregates", authGate(apiKey, handleAggregates(store, builders))))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	// Catch up any days missed while the pod was down. Sequential on
	// purpose (one ProcessDay at a time) so we don't hammer the CDN at
	// boot. Runs before the cron loop so the regular tick starts from
	// a clean state.
	go func() {
		runCatchup(ctx, store, builders)
		cronLoop(ctx, store, builders)
	}()

	Log.Info("http server listening", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func instrument(path string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		h(rec, r)
		MetricHTTPRequests.WithLabelValues(path, strconv.Itoa(rec.code)).Inc()
	}
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(c int) { s.code = c; s.ResponseWriter.WriteHeader(c) }

func authGate(apiKey string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-API-Key")
		if apiKey == "" || got == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(apiKey)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

func handleHealth(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, err := store.Stats(r.Context())
		status := "ok"
		if err != nil || s.LagHours > 48 {
			status = "degraded"
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":              status,
			"last_processed_day":  s.LastProcessedDay,
			"lag_hours":           round2(s.LagHours),
			"db_size_bytes":       s.DBSizeBytes,
			"builders_count":      s.BuildersCount,
			"days_count":          s.DaysCount,
			"version":             serviceVersion,
		})
	}
}

func handleAggregates(store *Store, builders []Builder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		window := strings.TrimSpace(r.URL.Query().Get("window"))
		days, ok := windowToDays(window)
		if window != "" && !ok {
			http.Error(w, "invalid window", http.StatusBadRequest)
			return
		}

		payload, err := buildPayload(r.Context(), store, builders, days, window)
		if err != nil {
			Log.Error("aggregates query failed", "err", err)
			http.Error(w, "internal", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, payload)
	}
}

// buildPayload constructs the Upstash-shaped JSON. When a single window
// is requested we still emit the full `windows` map (cheap) but limit
// the timeseries to that window's day count.
func buildPayload(ctx context.Context, store *Store, builders []Builder, days int, _ string) (UpstashPayload, error) {
	windows := standardWindows()
	wm, err := store.QueryWindowsForAllBuilders(ctx, windows)
	if err != nil {
		return UpstashPayload{}, err
	}
	tsDays := days
	if tsDays <= 0 || tsDays > 400 {
		tsDays = 400
	}
	ts, err := store.QueryDailyTimeseriesAllBuilders(ctx, tsDays)
	if err != nil {
		return UpstashPayload{}, err
	}

	out := UpstashPayload{
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Builders:  map[string]UpstashBuilder{},
	}
	nameByAddr := map[string]string{}
	for _, b := range builders {
		for _, a := range b.AllAddresses() {
			nameByAddr[strings.ToLower(a)] = b.Name
		}
	}
	for addr, wins := range wm {
		out.Builders[addr] = UpstashBuilder{
			Name:            nameByAddr[strings.ToLower(addr)],
			Windows:         wins,
			TimeseriesDaily: ts[addr],
		}
	}
	return out, nil
}

func standardWindows() map[string]int {
	return map[string]int{
		"24h": 1, "7d": 7, "30d": 30, "90d": 90,
		"180d": 180, "1y": 365, "all": 0,
	}
}

func windowToDays(w string) (int, bool) {
	switch w {
	case "":
		return 0, true
	case "24h":
		return 1, true
	case "7d":
		return 7, true
	case "30d":
		return 30, true
	case "90d":
		return 90, true
	case "180d":
		return 180, true
	case "1y":
		return 365, true
	case "all":
		return 0, true
	}
	return 0, false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func round2(f float64) float64 {
	return float64(int64(f*100)) / 100
}

// runCatchup ingests every UTC day from (last_processed + 1) up to
// (today - 1) one at a time. Today's CDN file is still growing so it
// is intentionally excluded; the cron loop will pick it up tomorrow.
//
// Before the forward pass, if HL_ARCHIVE_BACKFILL_FROM is older than the
// oldest day in the DB we first fill the gap on the LEFT of the existing
// range. This lets ops bump BACKFILL_FROM and have the next boot auto-fetch
// the new history without a manual `rebuild --confirm`.
func runCatchup(ctx context.Context, store *Store, builders []Builder) {
	stats, err := store.Stats(ctx)
	if err != nil {
		Log.Error("cron catchup stats failed", "err", err)
		return
	}

	from := envDefault("HL_ARCHIVE_BACKFILL_FROM", "2025-07-10")
	fromT, fromErr := time.Parse("2006-01-02", from)
	if fromErr != nil {
		Log.Error("cron catchup parse backfill_from failed", "value", from, "err", fromErr)
	}

	// Left-side gap-fill: BACKFILL_FROM < oldest_processed_day. Runs only
	// when the DB already has data and the env var was bumped backward.
	if fromErr == nil && stats.LastProcessedDay != "" {
		oldest, err := store.OldestProcessedDay(ctx)
		if err != nil {
			Log.Error("cron catchup oldest day failed", "err", err)
		} else if oldest != "" {
			oldestT, err := time.Parse("2006-01-02", oldest)
			if err != nil {
				Log.Error("cron catchup parse oldest day failed", "day", oldest, "err", err)
			} else if fromT.Before(oldestT) {
				Log.Info("cron catchup gap-fill", "from", from, "to", oldestT.AddDate(0, 0, -1).Format("2006-01-02"))
				for d := fromT; d.Before(oldestT); d = d.AddDate(0, 0, 1) {
					if err := ctx.Err(); err != nil {
						return
					}
					res, err := ProcessDay(ctx, store, builders, d, "gap-fill", 16)
					if err != nil {
						Log.Error("cron catchup gap-fill failed", "day", d.Format("2006-01-02"), "err", err)
						continue
					}
					Log.Info("cron catchup gap-fill day", "day", d.Format("2006-01-02"), "rows", res.Rows)
				}
			}
		}
	}

	var startDay time.Time
	if stats.LastProcessedDay == "" {
		// Cold DB: seed from HL_ARCHIVE_BACKFILL_FROM. Goroutine off the
		// serve path so /health stays responsive while the multi-hour
		// initial backfill walks forward day-by-day in the background.
		if fromErr != nil {
			return
		}
		startDay = fromT
		Log.Info("cron catchup cold start", "from", from)
	} else {
		last, err := time.Parse("2006-01-02", stats.LastProcessedDay)
		if err != nil {
			Log.Error("cron catchup parse last day failed", "day", stats.LastProcessedDay, "err", err)
			return
		}
		startDay = last.AddDate(0, 0, 1)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	for d := startDay; d.Before(today); d = d.AddDate(0, 0, 1) {
		if err := ctx.Err(); err != nil {
			return
		}
		res, err := ProcessDay(ctx, store, builders, d, "catchup", 16)
		if err != nil {
			Log.Error("cron catchup failed", "day", d.Format("2006-01-02"), "err", err)
			continue
		}
		Log.Info("cron catchup", "day", d.Format("2006-01-02"), "rows", res.Rows)
	}
	refreshDBGauges(ctx, store)
	// Push the rebuilt snapshot to Upstash after catchup so OCB sees the
	// data without waiting until the next cron tick at HL_ARCHIVE_CRON_HOUR.
	// Cold-boot from an empty DB would otherwise hold the published snapshot
	// stale for up to 24 hours.
	pushCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	payload, err := buildPayload(pushCtx, store, builders, 0, "")
	if err != nil {
		Log.Error("post-catchup payload build failed", "err", err)
		return
	}
	if err := PushUpstash(pushCtx, payload); err != nil {
		Log.Error("post-catchup upstash push failed", "err", err)
	}
}

// cronLoop fires DailyJob once a day at HL_ARCHIVE_CRON_HOUR UTC.
func cronLoop(ctx context.Context, store *Store, builders []Builder) {
	hour := 2
	if v := os.Getenv("HL_ARCHIVE_CRON_HOUR"); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h >= 0 && h < 24 {
			hour = h
		}
	}
	for {
		next := nextCronAt(time.Now().UTC(), hour)
		Log.Info("cron next fire", "at", next.Format(time.RFC3339))
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(next)):
		}
		runCron(ctx, store, builders)
	}
}

func nextCronAt(now time.Time, hourUTC int) time.Time {
	candidate := time.Date(now.Year(), now.Month(), now.Day(), hourUTC, 0, 0, 0, time.UTC)
	if !candidate.After(now) {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate
}

func runCron(ctx context.Context, store *Store, builders []Builder) {
	day := time.Now().UTC().AddDate(0, 0, -1)
	dayStr := day.Format("2006-01-02")
	// Skip if the catchup loop or a prior cron tick already ingested this day,
	// so a pod restart at the cron hour doesn't double-hit the CDN.
	if processed, err := store.IsDayProcessed(ctx, day); err == nil && processed {
		Log.Info("cron skip already processed", "day", dayStr)
		return
	}
	res, err := ProcessDay(ctx, store, builders, day, "cron", 16)
	if err != nil {
		Log.Error("cron run failed", "err", err)
		MetricCronRuns.WithLabelValues("err").Inc()
		return
	}
	MetricCronRuns.WithLabelValues("ok").Inc()
	MetricLastRun.Set(float64(time.Now().Unix()))
	Log.Info("cron run ok", "day", day.Format("2006-01-02"), "rows", res.Rows, "builders", res.Builders)

	pushCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	payload, err := buildPayload(pushCtx, store, builders, 0, "")
	if err != nil {
		Log.Error("post-cron payload build failed", "err", err)
		return
	}
	if err := PushUpstash(pushCtx, payload); err != nil {
		Log.Error("upstash push failed", "err", err)
	}
	refreshDBGauges(ctx, store)
}

func refreshDBGauges(ctx context.Context, store *Store) {
	s, err := store.Stats(ctx)
	if err != nil {
		return
	}
	MetricDBSize.Set(float64(s.DBSizeBytes))
	MetricBuildersCount.Set(float64(s.BuildersCount))
	MetricDaysCount.Set(float64(s.DaysCount))
	MetricLagHours.Set(s.LagHours)
}

