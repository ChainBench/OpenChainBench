package main

import (
	"strings"
	"testing"
	"time"
)

func TestTargetDay(t *testing.T) {
	cases := []struct {
		now  string
		want string
	}{
		// Before the indexing lag has cleared, yesterday is not readable yet.
		{"2026-09-27T02:00:00Z", "2026-09-25"},
		{"2026-09-27T09:59:00Z", "2026-09-25"},
		// Ten hours after the day closed, yesterday is the target.
		{"2026-09-27T10:00:00Z", "2026-09-26"},
		{"2026-09-27T23:59:00Z", "2026-09-26"},
	}
	for _, c := range cases {
		now, err := time.Parse(time.RFC3339, c.now)
		if err != nil {
			t.Fatal(err)
		}
		if got := dayString(targetDay(now)); got != c.want {
			t.Errorf("targetDay(%s) = %s, want %s", c.now, got, c.want)
		}
		wantYesterday := c.want == dayString(now.UTC().AddDate(0, 0, -1))
		if got := dayIsYesterday(now); got != wantYesterday {
			t.Errorf("dayIsYesterday(%s) = %v, want %v", c.now, got, wantYesterday)
		}
	}
}

// The day has to reach Dune as a macro it substitutes before planning. A
// block_date filter that is not a folded constant reads every partition: the
// same query cost 583 credits that way against 10 pinned.
func TestQuerySQLPinsEveryPartitionFilterToTheDayMacro(t *testing.T) {
	macro := "CAST('{{" + dayParam + "}}' AS date)"
	if n := strings.Count(querySQL, "block_date = "+macro); n != 3 {
		t.Errorf("block_date filters pinned to the macro = %d, want 3", n)
	}
	for _, banned := range []string{"MAX(block_date)", "now()", "current_date"} {
		if strings.Contains(querySQL, banned) {
			t.Errorf("querySQL must not derive the day from %q; the filter stops folding to a constant", banned)
		}
	}
	if !strings.Contains(querySQL, "to_unixtime(CAST("+macro+" AS timestamp))") {
		t.Error("querySQL must return the data day it measured, so the freshness guard has something to gate on")
	}
}

func TestQueryParametersDeclareTheDay(t *testing.T) {
	ps := queryParameters(time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC))
	if len(ps) != 1 {
		t.Fatalf("parameters = %d, want 1", len(ps))
	}
	p, ok := ps[0].(map[string]any)
	if !ok {
		t.Fatalf("parameter is %T, want a map", ps[0])
	}
	if p["key"] != dayParam || p["value"] != "2026-09-26" || p["type"] != "text" {
		t.Errorf("parameter = %v, want key=%s value=2026-09-26 type=text", p, dayParam)
	}
}
