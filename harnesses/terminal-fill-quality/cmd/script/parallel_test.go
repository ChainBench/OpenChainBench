package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Results must come back in INPUT order, not completion order.
//
// This is the property the samplers depend on. They apply st.reject and the
// append by walking the input again, so if readParallel returned results in
// whatever order the endpoints answered, the window's contents would depend
// on which RPC was fast that minute. Here the first item is deliberately the
// slowest, so a completion-ordered implementation puts it last and fails.
func TestReadParallelKeepsInputOrder(t *testing.T) {
	in := []int{0, 1, 2, 3, 4, 5, 6, 7}
	out := readParallel(context.Background(), in, 4, func(_ context.Context, i int) int {
		if i == 0 {
			time.Sleep(40 * time.Millisecond)
		}
		return i * 10
	})
	for i, v := range out {
		if v != i*10 {
			t.Fatalf("out[%d] = %d, want %d: results are not in input order", i, v, i*10)
		}
	}
}

// No more than `workers` may be in flight. The rate limiter is the backstop
// for the endpoints, but a pool that ignored its own bound would also ignore
// the tick's memory budget.
func TestReadParallelRespectsItsBound(t *testing.T) {
	const workers = 3
	var inFlight, peak int64
	in := make([]int, 40)
	readParallel(context.Background(), in, workers, func(_ context.Context, _ int) int {
		n := atomic.AddInt64(&inFlight, 1)
		for {
			p := atomic.LoadInt64(&peak)
			if n <= p || atomic.CompareAndSwapInt64(&peak, p, n) {
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
		atomic.AddInt64(&inFlight, -1)
		return 0
	})
	if peak > workers {
		t.Fatalf("%d calls were in flight at once, bound is %d", peak, workers)
	}
	if peak < 2 {
		t.Fatalf("peak concurrency was %d: the pool is not actually parallel", peak)
	}
}

// Cancellation must leave the unread items at their ZERO result, and the
// caller must be able to tell that apart from a read that returned nothing.
// For the samplers both are a nil *Swap and both mean "not measured", which
// is why this is safe; a caller that treated zero as data would publish
// cancelled reads as empty ones.
func TestReadParallelOnCancellationLeavesZeroes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	in := make([]int, 200)
	var done int64
	out := readParallel(ctx, in, 2, func(c context.Context, _ int) int {
		if atomic.AddInt64(&done, 1) == 3 {
			cancel()
		}
		if c.Err() != nil {
			return 0
		}
		time.Sleep(time.Millisecond)
		return 7
	})
	if len(out) != len(in) {
		t.Fatalf("returned %d results for %d items", len(out), len(in))
	}
	zeroes := 0
	for _, v := range out {
		if v == 0 {
			zeroes++
		}
	}
	if zeroes == 0 {
		t.Fatal("cancellation read everything anyway, so the context is not honoured")
	}
}

// Empty and single-item inputs must not deadlock or spawn a worker per item.
func TestReadParallelHandlesTrivialInputs(t *testing.T) {
	if out := readParallel(context.Background(), []int(nil), 8, func(_ context.Context, i int) int { return i }); len(out) != 0 {
		t.Fatalf("nil input returned %d results", len(out))
	}
	out := readParallel(context.Background(), []int{5}, 8, func(_ context.Context, i int) int { return i + 1 })
	if len(out) != 1 || out[0] != 6 {
		t.Fatalf("single item returned %v", out)
	}
}

// The workers share the caches the real pricers share, so this runs the kind
// of access the samplers make and leaves the race detector to judge it. Run
// the suite with -race for this to mean anything.
func TestReadParallelUnderSharedState(t *testing.T) {
	var mu sync.Mutex
	cache := map[int]int{}
	in := make([]int, 60)
	for i := range in {
		in[i] = i % 7 // deliberate key collisions
	}
	out := readParallel(context.Background(), in, 8, func(_ context.Context, k int) int {
		mu.Lock()
		v, hit := cache[k]
		mu.Unlock()
		if hit {
			return v
		}
		v = k * 3
		mu.Lock()
		cache[k] = v
		mu.Unlock()
		return v
	})
	for i, v := range out {
		if v != in[i]*3 {
			t.Fatalf("out[%d] = %d, want %d", i, v, in[i]*3)
		}
	}
}

// The worker count is clamped, because it is settable and a typo must not
// open 4,000 sockets or stop the pool dead.
func TestSampleWorkersIsClamped(t *testing.T) {
	t.Setenv("SAMPLE_WORKERS", "0")
	if n := sampleWorkers(); n < 1 {
		t.Fatalf("SAMPLE_WORKERS=0 gave %d workers, which reads nothing", n)
	}
	t.Setenv("SAMPLE_WORKERS", "100000")
	if n := sampleWorkers(); n > 32 {
		t.Fatalf("SAMPLE_WORKERS=100000 gave %d workers", n)
	}
}
