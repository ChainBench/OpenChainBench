package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// The bound must actually bind, across every caller.
//
// This is the property parallel.go claimed before it was true. RPC_RPS paces
// the Solana client; evmCall never went through it, so parallelising the EVM
// samplers multiplied their load with nothing in between and no counter to
// show it. The tick went from 1m0.6s to 1m49.6s while the only rate I was
// watching stayed at 3.6 a second.
func TestEvmCallsAreBoundedInFlight(t *testing.T) {
	const bound = 3
	prev := evmInflight
	evmInflight = make(chan struct{}, bound)
	defer func() { evmInflight = prev }()

	var inFlight, peak int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&inFlight, 1)
		for {
			p := atomic.LoadInt64(&peak)
			if n <= p || atomic.CompareAndSwapInt64(&peak, p, n) {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
		atomic.AddInt64(&inFlight, -1)
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "0x1"})
	}))
	defer srv.Close()

	httpc := &http.Client{Timeout: 5 * time.Second}
	done := make(chan struct{})
	for i := 0; i < 12; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			var out string
			_ = evmCall(context.Background(), httpc, []string{srv.URL}, "eth_blockNumber", []any{}, &out)
		}()
	}
	for i := 0; i < 12; i++ {
		<-done
	}
	if peak > bound {
		t.Fatalf("%d EVM calls were in flight at once, bound is %d", peak, bound)
	}
	if peak < 2 {
		t.Fatalf("peak was %d: the calls are not actually concurrent, so the test proves nothing", peak)
	}
}

// A call that every endpoint refused must count as an error. Without this,
// raising concurrency and reading only the call counter would show more
// throughput while the sample got worse.
func TestEvmCallCountsItsFailures(t *testing.T) {
	before := metricValue(cEvmCallErrors)
	var out string
	err := evmCall(context.Background(), &http.Client{Timeout: time.Second},
		[]string{"http://127.0.0.1:1"}, "eth_blockNumber", []any{}, &out)
	if err == nil {
		t.Fatal("a call to a closed port returned no error")
	}
	if after := metricValue(cEvmCallErrors); after <= before {
		t.Fatalf("tfq_evm_call_errors_total did not move: %v then %v", before, after)
	}
}

// And a successful call must count as a call, or the volume the bound is
// meant to govern is invisible.
func TestEvmCallCountsItsCalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "0x2"})
	}))
	defer srv.Close()
	before := metricValue(cEvmCalls)
	var out string
	if err := evmCall(context.Background(), &http.Client{Timeout: 5 * time.Second},
		[]string{srv.URL}, "eth_blockNumber", []any{}, &out); err != nil {
		t.Fatalf("call failed: %v", err)
	}
	if after := metricValue(cEvmCalls); after <= before {
		t.Fatalf("tfq_evm_calls_total did not move: %v then %v", before, after)
	}
}

// A cancelled context must not be able to slip past the bound by waiting
// forever for a slot.
func TestEvmCallHonoursCancellationAtTheGate(t *testing.T) {
	prev := evmInflight
	evmInflight = make(chan struct{}, 1)
	evmInflight <- struct{}{} // full
	defer func() { evmInflight = prev }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out string
	if err := evmCall(ctx, &http.Client{}, []string{"http://127.0.0.1:1"}, "eth_blockNumber", []any{}, &out); err == nil {
		t.Fatal("a cancelled call waited for a slot instead of returning")
	}
}
