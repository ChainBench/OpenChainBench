package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
)

// fakeSolana serves getSignaturesForAddress from a fixed page and fails
// getTransaction for a signature until it has been asked `failFor` times.
type fakeSolana struct {
	mu      sync.Mutex
	sigs    []string
	failFor map[string]int
	asked   map[string]int
}

func (f *fakeSolana) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Method string `json:"method"`
		Params []any  `json:"params"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	defer f.mu.Unlock()
	switch req.Method {
	case "getSignaturesForAddress":
		out := []map[string]any{}
		for _, s := range f.sigs {
			out = append(out, map[string]any{"signature": s, "slot": 1, "err": nil})
		}
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": out})
		w.Write(b)
	case "getTransaction":
		sig, _ := req.Params[0].(string)
		f.asked[sig]++
		if f.asked[sig] <= f.failFor[sig] {
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32009,"message":"not available"}}`)
			return
		}
		// A readable transaction with no bridge instruction: zero deposits, read ok.
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"slot":1,"blockTime":1800000000,"transaction":{"message":{"accountKeys":[{"pubkey":"x"}]}},"meta":{"innerInstructions":[]}}}`)
	}
}

func readOutcome(outcome string) float64 {
	var d dto.Metric
	if cPumpBridgeRead.WithLabelValues(outcome).Write(&d) != nil {
		return -1
	}
	return d.Counter.GetValue()
}

func testFeed(t *testing.T, fs *fakeSolana) (*pumpBridgeFeed, *rpcClient) {
	t.Helper()
	srv := httptest.NewServer(fs)
	t.Cleanup(srv.Close)
	rpc := &rpcClient{url: srv.URL, http: srv.Client(), calls: func() {}, errors: func() {}}
	return &pumpBridgeFeed{}, rpc
}

// A read that fails is kept and retried, not lost when the cursor moves on.
func TestFailedReadIsRetriedNotLost(t *testing.T) {
	fs := &fakeSolana{sigs: []string{"ok1", "flaky"}, failFor: map[string]int{"flaky": 1}, asked: map[string]int{}}
	f, rpc := testFeed(t, fs)
	q0, r0 := readOutcome("queued"), readOutcome("recovered")

	f.poll(context.Background(), rpc)
	if _, ok := f.retry["flaky"]; !ok {
		t.Fatal("a failed read was not queued: the cursor moved past it and it is gone")
	}
	if f.cursor != "ok1" {
		t.Fatalf("cursor %q, want the newest signature ok1", f.cursor)
	}
	if readOutcome("queued")-q0 != 1 {
		t.Error("queued counter did not move")
	}

	// Next pass: the page is empty (cursor caught up), the retry succeeds.
	fs.mu.Lock()
	fs.sigs = []string{"new"}
	fs.mu.Unlock()
	time.Sleep(1100 * time.Millisecond) // a later second, so the retry is not skipped as just-queued
	f.poll(context.Background(), rpc)
	if _, ok := f.retry["flaky"]; ok {
		t.Fatal("the retry succeeded but the signature is still queued")
	}
	if readOutcome("recovered")-r0 != 1 {
		t.Error("recovered counter did not move")
	}
	if fs.asked["flaky"] != 2 {
		t.Errorf("flaky read %d times, want 2", fs.asked["flaky"])
	}
}

// A signature that never becomes readable is abandoned after the age bound,
// so it cannot sit in the queue forever.
func TestUnreadableSignatureIsAbandonedByAge(t *testing.T) {
	fs := &fakeSolana{sigs: []string{"head"}, failFor: map[string]int{"dead": 1 << 30}, asked: map[string]int{}}
	f, rpc := testFeed(t, fs)
	f.retry = map[string]int64{"dead": time.Now().Unix() - pumpBridgeRetryAge - 1}
	a0 := readOutcome("abandoned")

	f.poll(context.Background(), rpc)
	if _, ok := f.retry["dead"]; ok {
		t.Fatal("a signature past the age bound is still queued")
	}
	if readOutcome("abandoned")-a0 != 1 {
		t.Error("abandoned counter did not move")
	}

	// Under the age bound it stays.
	f.retry = map[string]int64{"dead": time.Now().Unix() - 60}
	f.poll(context.Background(), rpc)
	if _, ok := f.retry["dead"]; !ok {
		t.Fatal("a young failed signature was abandoned early")
	}
}

// The queue is bounded by count; overflow is counted as dropped, not hidden.
func TestRetryQueueIsBoundedAndOverflowCounted(t *testing.T) {
	f := &pumpBridgeFeed{}
	d0 := readOutcome("dropped")
	now := time.Now().Unix()
	for i := 0; i < pumpBridgeRetryMax; i++ {
		if !f.queue(fmt.Sprintf("s%d", i), now) {
			t.Fatalf("queue refused entry %d under the bound", i)
		}
	}
	if f.queue("one-too-many", now) {
		t.Fatal("queue accepted an entry past pumpBridgeRetryMax")
	}
	if len(f.retry) != pumpBridgeRetryMax {
		t.Fatalf("queue holds %d, want %d", len(f.retry), pumpBridgeRetryMax)
	}
	if readOutcome("dropped")-d0 != 1 {
		t.Error("dropped counter did not move")
	}
}
