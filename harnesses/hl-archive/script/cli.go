// cli.go — subcommand dispatcher + per-day worker pool.
//
// Each subcommand is a tiny function that wires env -> store ->
// ProcessDay/ProcessRange. ProcessDay holds the worker pool that
// drives parse.go concurrently across builders for one day.
package script

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Builder is one entry in data/builders.json. A few builders register
// multiple addresses; AllAddresses returns the deduped set.
type Builder struct {
	Slug      string   `json:"slug"`
	Name      string   `json:"name"`
	Address   string   `json:"address"`
	ValidFrom string   `json:"valid_from"`
	Addresses []string `json:"addresses,omitempty"`
	Notes     string   `json:"notes,omitempty"`
}

func (b Builder) AllAddresses() []string {
	set := map[string]struct{}{}
	if b.Address != "" {
		set[strings.ToLower(b.Address)] = struct{}{}
	}
	for _, a := range b.Addresses {
		if a != "" {
			set[strings.ToLower(a)] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	return out
}

// LoadBuilders reads the JSON file at path.
func LoadBuilders(path string) ([]Builder, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open builders file %s: %w", path, err)
	}
	defer f.Close()
	var out []Builder
	if err := json.NewDecoder(f).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode builders file: %w", err)
	}
	return out, nil
}

// Run is the package entrypoint called from cmd/hl-archive/main.go.
func Run(args []string) error {
	initLogger()
	if len(args) == 0 {
		printUsage()
		return errors.New("missing subcommand")
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "backfill":
		return cmdBackfill(rest)
	case "daily":
		return cmdDaily(rest)
	case "rebuild":
		return cmdRebuild(rest)
	case "serve":
		return cmdServe(rest)
	case "query":
		return cmdQuery(rest)
	case "-h", "--help", "help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown subcommand: %s", cmd)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `hl-archive — Hyperliquid builder fee/volume archive

Usage:
  hl-archive backfill --from YYYY-MM-DD --to YYYY-MM-DD [--workers N]
  hl-archive daily
  hl-archive rebuild --confirm
  hl-archive serve
  hl-archive query --builder 0x... --days N
`)
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func openStoreFromEnv() (*Store, error) {
	path := envDefault("HL_ARCHIVE_DB_PATH", "/data/history.duckdb")
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir db dir: %w", err)
	}
	return OpenStore(path)
}

func dirOf(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "."
}

func loadBuildersFromEnv() ([]Builder, error) {
	path := envDefault("HL_ARCHIVE_BUILDERS_FILE", "./data/builders.json")
	return LoadBuilders(path)
}

func cmdBackfill(args []string) error {
	fs := flag.NewFlagSet("backfill", flag.ExitOnError)
	from := fs.String("from", "", "YYYY-MM-DD (inclusive)")
	to := fs.String("to", "", "YYYY-MM-DD (inclusive)")
	workers := fs.Int("workers", 16, "concurrent builders per day")
	_ = fs.Parse(args)

	if *from == "" || *to == "" {
		return errors.New("--from and --to are required")
	}
	fromT, err := time.Parse("2006-01-02", *from)
	if err != nil {
		return fmt.Errorf("--from: %w", err)
	}
	toT, err := time.Parse("2006-01-02", *to)
	if err != nil {
		return fmt.Errorf("--to: %w", err)
	}
	if toT.Before(fromT) {
		return errors.New("--to is before --from")
	}
	// Today's CDN file is still being written; ingesting it would store
	// a partial day that the cron loop later overwrites. Force callers
	// to use `daily` (which targets yesterday) for the most recent day.
	today := time.Now().UTC().Truncate(24 * time.Hour)
	if !toT.Before(today) {
		return errors.New("--to must be < today UTC (today's CDN file is still growing); use 'daily' instead")
	}

	store, err := openStoreFromEnv()
	if err != nil {
		return err
	}
	defer store.Close()
	builders, err := loadBuildersFromEnv()
	if err != nil {
		return err
	}

	ctx, cancel := signalCtx()
	defer cancel()

	totalRows := int64(0)
	for d := fromT; !d.After(toT); d = d.AddDate(0, 0, 1) {
		if processed, err := store.IsDayProcessed(ctx, d); err == nil && processed {
			Log.Info("skip day (already processed)", "day", d.Format("2006-01-02"))
			continue
		}
		res, err := ProcessDay(ctx, store, builders, d, "backfill", *workers)
		if err != nil {
			Log.Error("backfill day failed", "day", d.Format("2006-01-02"), "err", err)
			continue
		}
		totalRows += res.Rows
		Log.Info("backfill day ok",
			"day", d.Format("2006-01-02"),
			"rows", res.Rows, "builders", res.Builders, "duration_ms", res.Duration.Milliseconds())
	}
	Log.Info("backfill done", "rows_total", totalRows)
	refreshDBGauges(ctx, store)
	return nil
}

func cmdDaily(_ []string) error {
	store, err := openStoreFromEnv()
	if err != nil {
		return err
	}
	defer store.Close()
	builders, err := loadBuildersFromEnv()
	if err != nil {
		return err
	}
	ctx, cancel := signalCtx()
	defer cancel()
	day := time.Now().UTC().AddDate(0, 0, -1)
	res, err := ProcessDay(ctx, store, builders, day, "daily", 16)
	if err != nil {
		return err
	}
	Log.Info("daily ok", "day", day.Format("2006-01-02"), "rows", res.Rows, "builders", res.Builders)
	MetricLastRun.Set(float64(time.Now().Unix()))
	refreshDBGauges(ctx, store)

	payload, err := buildPayload(ctx, store, builders, 0, "")
	if err != nil {
		return err
	}
	return PushUpstash(ctx, payload)
}

func cmdRebuild(args []string) error {
	fs := flag.NewFlagSet("rebuild", flag.ExitOnError)
	confirm := fs.Bool("confirm", false, "must be set to actually wipe the DB")
	_ = fs.Parse(args)
	if !*confirm {
		return errors.New("refusing to rebuild without --confirm")
	}
	store, err := openStoreFromEnv()
	if err != nil {
		return err
	}
	defer store.Close()
	if err := store.Wipe(context.Background()); err != nil {
		return err
	}
	from := envDefault("HL_ARCHIVE_BACKFILL_FROM", "2025-07-10")
	to := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	return cmdBackfill([]string{"--from", from, "--to", to})
}

func cmdServe(_ []string) error {
	apiKey := strings.TrimSpace(os.Getenv("HL_ARCHIVE_API_KEY"))
	if apiKey == "" {
		return errors.New("HL_ARCHIVE_API_KEY is required for serve mode")
	}
	addr := envDefault("HL_ARCHIVE_HTTP_ADDR", "0.0.0.0:2114")

	store, err := openStoreFromEnv()
	if err != nil {
		return err
	}
	defer store.Close()
	builders, err := loadBuildersFromEnv()
	if err != nil {
		return err
	}

	ctx, cancel := signalCtx()
	defer cancel()
	refreshDBGauges(ctx, store)
	return Serve(ctx, store, builders, apiKey, addr)
}

func cmdQuery(args []string) error {
	fs := flag.NewFlagSet("query", flag.ExitOnError)
	builder := fs.String("builder", "", "0x address")
	days := fs.Int("days", 30, "number of days back")
	_ = fs.Parse(args)
	if *builder == "" {
		return errors.New("--builder is required")
	}
	store, err := openStoreFromEnv()
	if err != nil {
		return err
	}
	defer store.Close()
	rows, err := store.QueryBuilderTimeseries(context.Background(), strings.ToLower(*builder), *days)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(rows)
}

func signalCtx() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		Log.Info("signal received, cancelling")
		cancel()
	}()
	return ctx, cancel
}

// DayResult summarises one ProcessDay call.
type DayResult struct {
	Rows     int64
	Builders int
	Duration time.Duration
}

// ProcessDay parses every builder for `day` concurrently and commits
// the aggregated rows in a single DuckDB transaction. Returns even
// when individual builders 404'd (those just contribute zero rows).
func ProcessDay(ctx context.Context, store *Store, builders []Builder, day time.Time, source string, workers int) (DayResult, error) {
	if workers <= 0 {
		workers = 16
	}
	start := time.Now()
	dayStr := day.UTC().Format("2006-01-02")

	type job struct {
		builderAddr string
		builderName string
	}
	jobs := make(chan job, workers*2)

	var (
		mu          sync.Mutex
		rowsByAddr  = map[string][]AggRow{}
		wg          sync.WaitGroup
		dbPath      = envDefault("HL_ARCHIVE_DB_PATH", "/data/history.duckdb")
	)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				agg := NewDayAggregator(dayStr, strings.ToLower(j.builderAddr))
				n, err := FetchDay(ctx, j.builderAddr, day, func(f Fill) error {
					agg.Add(f)
					return nil
				})
				switch {
				case errors.Is(err, ErrNotFound):
					MetricFilesProcessed.WithLabelValues("cdn", "notfound").Inc()
					mu.Lock()
					rowsByAddr[strings.ToLower(j.builderAddr)] = nil
					mu.Unlock()
					continue
				case err != nil:
					Log.Error("fetch day failed",
						"builder", j.builderAddr, "day", dayStr, "err", err)
					if strings.Contains(err.Error(), "lz4") {
						DeadLetter(dbPath, j.builderAddr, dayStr, err.Error())
					}
					MetricFilesProcessed.WithLabelValues("cdn", "error").Inc()
					continue
				}
				MetricFilesProcessed.WithLabelValues("cdn", "ok").Inc()
				rows := agg.Rows()
				mu.Lock()
				rowsByAddr[strings.ToLower(j.builderAddr)] = rows
				mu.Unlock()
				Log.Debug("builder done", "builder", j.builderAddr, "day", dayStr, "fills", n, "rows", len(rows))
			}
		}()
	}

	seen := map[string]bool{}
	for _, b := range builders {
		if !builderActiveOn(b, day) {
			continue
		}
		for _, addr := range b.AllAddresses() {
			if seen[addr] {
				continue
			}
			seen[addr] = true
			jobs <- job{builderAddr: addr, builderName: b.Name}
		}
	}
	close(jobs)
	wg.Wait()

	if err := ctx.Err(); err != nil {
		return DayResult{}, err
	}

	if err := store.CommitDay(ctx, day, source, rowsByAddr, time.Since(start)); err != nil {
		return DayResult{}, err
	}

	var totalRows int64
	for _, rows := range rowsByAddr {
		totalRows += int64(len(rows))
	}
	return DayResult{
		Rows:     totalRows,
		Builders: len(rowsByAddr),
		Duration: time.Since(start),
	}, nil
}

func builderActiveOn(b Builder, day time.Time) bool {
	if b.ValidFrom == "" {
		return true
	}
	vf, err := time.Parse("2006-01-02", b.ValidFrom)
	if err != nil {
		return true
	}
	return !day.Before(vf)
}
