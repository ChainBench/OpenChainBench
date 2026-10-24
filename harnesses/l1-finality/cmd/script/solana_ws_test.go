package main

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestParseSolanaNotifications(t *testing.T) {
	slot, root, ok := parseSolanaNotification([]byte(`{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":9,"root":5,"slot":10},"subscription":1}}`))
	if !ok || slot != 10 || root != 0 {
		t.Fatalf("slot: got %d %d %v", slot, root, ok)
	}
	slot, root, ok = parseSolanaNotification([]byte(`{"jsonrpc":"2.0","method":"rootNotification","params":{"result":42,"subscription":2}}`))
	if !ok || slot != 0 || root != 42 {
		t.Fatalf("root: got %d %d %v", slot, root, ok)
	}
	if _, _, ok := parseSolanaNotification([]byte(`{"jsonrpc":"2.0","result":7,"id":1}`)); ok {
		t.Fatal("a subscription ack is not a notification")
	}
}

func TestParseSolanaFrozen(t *testing.T) {
	if s, ok := parseSolanaFrozen([]byte(`{"jsonrpc":"2.0","method":"slotsUpdatesNotification","params":{"result":{"slot":77,"timestamp":1,"type":"frozen","stats":{}},"subscription":3}}`)); !ok || s != 77 {
		t.Fatalf("frozen: got %d %v", s, ok)
	}
	for _, m := range []string{
		`{"jsonrpc":"2.0","method":"slotsUpdatesNotification","params":{"result":{"slot":77,"timestamp":1,"type":"createdBank","parent":76},"subscription":3}}`,
		`{"jsonrpc":"2.0","method":"rootNotification","params":{"result":42,"subscription":2}}`,
	} {
		if _, ok := parseSolanaFrozen([]byte(m)); ok {
			t.Errorf("not a frozen event: %s", m)
		}
	}
}

// The split must add up to the headline and drop a slot whose frozen event
// does not sit between seen and root.
func TestSolanaStageSplit(t *testing.T) {
	st := &wsState{slug: "solana", firstSeen: map[int64]time.Time{}, frozen: map[int64]time.Time{}}
	t0 := time.Now()
	st.firstSeen[10] = t0
	st.frozen[10] = t0.Add(170 * time.Millisecond)
	st.firstSeen[11] = t0
	st.frozen[11] = t0.Add(-time.Millisecond) // frozen before seen: no split
	before := testutil.ToFloat64(solanaStageSamples.WithLabelValues("vote"))
	st.recordFinalSolana(11, t0.Add(420*time.Millisecond))
	if got := testutil.ToFloat64(solanaStageSamples.WithLabelValues("vote")) - before; got != 1 {
		t.Fatalf("want 1 split sample, got %v", got)
	}
	if b, v := testutil.ToFloat64(solanaStageGauge.WithLabelValues("block")), testutil.ToFloat64(solanaStageGauge.WithLabelValues("vote")); b != 170 || v != 250 {
		t.Fatalf("block %v vote %v, want 170 and 250", b, v)
	}
	if len(st.frozen) != 0 {
		t.Error("frozen entries at or below the root must be dropped")
	}
}
