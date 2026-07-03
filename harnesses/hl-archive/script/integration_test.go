package script

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Full end-to-end: mocked CDN -> ProcessDay -> CommitDay -> Stats.
func TestProcessDay_EndToEnd(t *testing.T) {
	body := lz4Encode(t, []byte(sampleCSV))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	prev := HTTPClient
	defer func() { HTTPClient = prev }()
	HTTPClient = srv.Client()
	HTTPClient.Transport = &redirectingTransport{target: srv.URL}

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.duckdb")
	os.Setenv("HL_ARCHIVE_DB_PATH", dbPath)

	store, err := OpenStore(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	builders := []Builder{{
		Slug: "test", Name: "Test",
		Address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}}
	day := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	res, err := ProcessDay(context.Background(), store, builders, day, "test", 2)
	if err != nil {
		t.Fatalf("process day: %v", err)
	}
	if res.Rows != 2 { // BTC + ETH buckets
		t.Fatalf("rows: %d", res.Rows)
	}
	processed, err := store.IsDayProcessed(context.Background(), day)
	if err != nil || !processed {
		t.Fatalf("not marked processed: err=%v processed=%v", err, processed)
	}
	st, err := store.Stats(context.Background())
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.BuildersCount != 1 {
		t.Errorf("builders count: %d", st.BuildersCount)
	}
	if st.DaysCount != 1 {
		t.Errorf("days count: %d", st.DaysCount)
	}
}
