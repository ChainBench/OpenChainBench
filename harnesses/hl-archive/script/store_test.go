package script

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestOldestProcessedDay covers the empty + populated paths so the
// runCatchup gap-fill branch can rely on the helper.
func TestOldestProcessedDay(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "oldest.duckdb"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	got, err := store.OldestProcessedDay(context.Background())
	if err != nil {
		t.Fatalf("empty: %v", err)
	}
	if got != "" {
		t.Fatalf("expected empty oldest, got %q", got)
	}

	for _, day := range []string{"2025-08-01", "2025-09-15", "2026-06-29"} {
		if err := store.CommitDay(context.Background(), parseDay(day), "test", map[string][]AggRow{}, time.Millisecond); err != nil {
			t.Fatalf("commit %s: %v", day, err)
		}
	}
	got, err = store.OldestProcessedDay(context.Background())
	if err != nil {
		t.Fatalf("populated: %v", err)
	}
	if got != "2025-08-01" {
		t.Fatalf("expected 2025-08-01, got %q", got)
	}
}

// TestRunCatchup_GapFill seeds the store with 2025-08-01..2026-06-29,
// sets HL_ARCHIVE_BACKFILL_FROM=2025-07-10, and asserts the catchup
// goroutine fetches the 22 missing pre-Aug days from the CDN before
// falling through to the forward catchup.
func TestRunCatchup_GapFill(t *testing.T) {
	body := lz4Encode(t, []byte(sampleCSV))
	var (
		mu         sync.Mutex
		hitDays    = map[string]int{}
		totalCalls atomic.Int64
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		totalCalls.Add(1)
		// URL path looks like /Mainnet/builder_fills/<addr>/YYYYMMDD.csv.lz4
		// We slice the YYYYMMDD substring at fixed offset from the end.
		p := r.URL.Path
		const suffix = ".csv.lz4"
		if len(p) < 8+len(suffix) || p[len(p)-len(suffix):] != suffix {
			http.NotFound(w, r)
			return
		}
		ymd := p[len(p)-8-len(suffix) : len(p)-len(suffix)]
		day := ymd[0:4] + "-" + ymd[4:6] + "-" + ymd[6:8]
		mu.Lock()
		hitDays[day]++
		mu.Unlock()
		w.Write(body)
	}))
	defer srv.Close()

	prev := HTTPClient
	defer func() { HTTPClient = prev }()
	HTTPClient = srv.Client()
	HTTPClient.Transport = &redirectingTransport{target: srv.URL}

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "gapfill.duckdb")
	t.Setenv("HL_ARCHIVE_DB_PATH", dbPath)
	t.Setenv("HL_ARCHIVE_BACKFILL_FROM", "2025-07-10")

	store, err := OpenStore(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	// Seed processed_days with a synthetic range 2025-08-01..2026-06-29
	// so the gap (2025-07-10..2025-07-31) is the only missing window
	// below today's bound. We commit empty row maps which is fine for
	// the catchup gap-detection logic — it only reads MIN/MAX(day).
	for d := parseDay("2025-08-01"); !d.After(parseDay("2026-06-29")); d = d.AddDate(0, 0, 1) {
		if err := store.CommitDay(context.Background(), d, "seed", map[string][]AggRow{}, time.Millisecond); err != nil {
			t.Fatalf("seed %s: %v", d.Format("2006-01-02"), err)
		}
	}

	// Pin "today" so the forward catchup walks 2026-06-30 .. today-1.
	// We can't override time.Now() without refactoring server.go, so
	// instead we count gap-fill hits explicitly and only assert on the
	// 22 pre-Aug days. Forward catchup will hit additional days but
	// that's fine — the assertion is "gap days were all visited".
	builders := []Builder{{
		Slug: "test", Name: "Test",
		Address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}}

	runCatchup(context.Background(), store, builders)

	mu.Lock()
	defer mu.Unlock()
	for d := parseDay("2025-07-10"); d.Before(parseDay("2025-08-01")); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		if hitDays[key] == 0 {
			t.Errorf("expected gap-fill to fetch %s, but CDN was not hit", key)
		}
	}

	// Sanity check: exactly 22 gap days requested before any post-existing
	// forward catchup work.
	gapHits := 0
	for d := parseDay("2025-07-10"); d.Before(parseDay("2025-08-01")); d = d.AddDate(0, 0, 1) {
		gapHits += hitDays[d.Format("2006-01-02")]
	}
	if gapHits != 22 {
		t.Errorf("expected 22 gap-fill fetches, got %d", gapHits)
	}

	// Existing range must remain processed (gap-fill did not wipe it).
	oldest, err := store.OldestProcessedDay(context.Background())
	if err != nil {
		t.Fatalf("oldest after: %v", err)
	}
	if oldest != "2025-07-10" {
		t.Errorf("expected oldest=2025-07-10 after gap-fill, got %s", oldest)
	}
	if totalCalls.Load() == 0 {
		t.Errorf("CDN was never hit")
	}
}
