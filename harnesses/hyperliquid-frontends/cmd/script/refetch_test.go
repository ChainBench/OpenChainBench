package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// The behaviour under test is the one that let a half day become permanent:
// the mirror used to take the first copy of a day and never look again, so
// when Hyperliquid published 3 October short and completed it two days
// later, our side would have kept the short one for ever.
func TestRevalidationPicksUpACompletedDay(t *testing.T) {
	short := []byte("short-day-body")
	long := []byte("the-same-day-once-upstream-finished-writing-it")

	body := short
	modified := time.Date(2026, 10, 5, 0, 59, 25, 0, time.UTC)
	var conditional, served int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ims := r.Header.Get("If-Modified-Since"); ims != "" {
			conditional++
			if since, err := http.ParseTime(ims); err == nil && !modified.After(since) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		served++
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	old := feedURLTemplate
	feedURLTemplate = srv.URL + "/%s/%s.csv.lz4"
	defer func() { feedURLTemplate = old }()

	m, err := newMirror(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	addr, day := "0xabc", time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC)

	// First pass: nothing on disk, so no condition is sent and we take the
	// short body the upstream has so far.
	if err := m.fetch(ctx, addr, day); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if conditional != 0 {
		t.Errorf("first fetch sent a condition with nothing on disk")
	}
	if got, _ := os.ReadFile(m.filePath(addr, day)); string(got) != string(short) {
		t.Fatalf("first fetch stored %q", got)
	}

	// Second pass: unchanged upstream. This must cost a 304 and leave the
	// file alone, which is what makes re-checking every recent day cheap
	// enough to do on every sync.
	if err := m.fetch(ctx, addr, day); err != errFeedUnchanged {
		t.Fatalf("revalidation of an unchanged day = %v, want errFeedUnchanged", err)
	}
	if conditional != 1 || served != 1 {
		t.Errorf("conditional=%d served=%d, want 1 and 1: the body was re-sent", conditional, served)
	}

	// Upstream completes the day.
	body = long
	modified = modified.Add(2 * time.Hour)
	if err := m.fetch(ctx, addr, day); err != nil {
		t.Fatalf("fetch after upstream republished: %v", err)
	}
	got, _ := os.ReadFile(m.filePath(addr, day))
	if string(got) != string(long) {
		t.Fatalf("after the upstream completed the day the mirror still holds %q", got)
	}
}

// A day the upstream never had must still read as absent, not as unchanged:
// the two are different answers and the caller treats them differently.
func TestAbsentDayIsNotUnchanged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	old := feedURLTemplate
	feedURLTemplate = srv.URL + "/%s/%s.csv.lz4"
	defer func() { feedURLTemplate = old }()

	m, err := newMirror(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := m.fetch(context.Background(), "0xabc", time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)); err != errFeedAbsent {
		t.Fatalf("403 = %v, want errFeedAbsent", err)
	}
}
