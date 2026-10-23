package main

// Reading sampled swaps several at a time.
//
// WHY, measured rather than assumed. Asked for more datapoints, the first
// thing checked was the rate limit: 3.31 RPC calls a second against a ceiling
// of 8, with zero errors. So the limit was not binding and the daily targets
// were. Those were raised (150 to 400 on Solana, 600 to 2000 on the EVM rows,
// RPC_RPS 8 to 24) and the rate went to 6.5 calls a second, still zero errors,
// but one tick in five then took 57.9 s of its 60 s budget.
//
// That moves the constraint from "how many swaps are we allowed to ask for" to
// "how long does a tick take", and raising the target past that point buys
// nothing: the tick cannot consume it. The reason is not the rate limiter.
// pace() releases its lock before the HTTP round trip, so concurrent callers
// are paced but not serialised. What serialises us is the sampler loop: each
// swap waits for several sequential round trips before the next swap starts,
// so throughput is one swap per (calls x latency) however much headroom the
// limiter has.
//
// So the work goes several at a time. The claim this comment USED to make,
// that RPC_RPS is the backstop, was true for the Solana client and false for
// the EVM path, which is the path these samplers actually read: evmCall had
// no pacing and no counter, so RPC_RPS never applied to it and
// tfq_rpc_calls_total never saw it. Reading 3.59 calls a second and calling
// it headroom was therefore reading the wrong number, and the tick went from
// 1m0.6s to 1m49.6s while that number did not move.
//
// The backstop now exists: tfq_evm_calls_total counts them and
// EVM_MAX_INFLIGHT bounds them process-wide, samplers and feeds together,
// because they share the endpoints. Raising SAMPLE_WORKERS past that bound
// buys nothing, which is the property the comment claimed before it was
// true.
//
// WHAT IS NOT SAFE TO SHARE, checked before writing this rather than after:
// poolCache and erc20Cache both hold a mutex, pumpBlockTime holds one,
// rpcClient.pace() holds one, and Prometheus collectors are safe. State is
// NOT: it has no lock and `st.Swaps = append(...)` and st.reject() both
// mutate it. So a worker returns its Swap and the caller applies every state
// change afterwards, in order. That is the whole discipline here, and it is
// also why the results come back in the input's order: a parallel sampler
// that reordered its rows would make the window depend on which read finished
// first.

import (
	"context"
	"sync"
)

// sampleWorkers: how many sampled swaps are read at once.
//
// Default 6. At the measured ~200 ms a call that is about 30 calls a second
// offered against RPC_RPS 24, so the limiter is what decides the rate and this
// only decides whether we reach it. Settable because the right number depends
// on endpoint latency, which differs per chain and per provider, and because
// the honest way to raise throughput further is to measure this against
// tfq_rpc_errors_total rather than to guess.
func sampleWorkers() int {
	n := envInt("SAMPLE_WORKERS", 6)
	if n < 1 {
		n = 1
	}
	if n > 32 {
		n = 32 // past this the tick's own memory and the endpoints, not us
	}
	return n
}

// readParallel applies fn to every item with at most `workers` in flight and
// returns the results IN INPUT ORDER.
//
// fn must not touch State, must not write an unguarded shared map, and must
// be safe to abandon: on ctx cancellation the remaining items are left at
// their zero result, which the caller must treat as "not read" rather than as
// "read and empty".
func readParallel[T any, R any](ctx context.Context, items []T, workers int, fn func(context.Context, T) R) []R {
	out := make([]R, len(items))
	if len(items) == 0 {
		return out
	}
	if workers < 1 {
		workers = 1
	}
	if workers > len(items) {
		workers = len(items)
	}
	idx := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				if ctx.Err() != nil {
					return
				}
				out[i] = fn(ctx, items[i])
			}
		}()
	}
	for i := range items {
		if ctx.Err() != nil {
			break
		}
		idx <- i
	}
	close(idx)
	wg.Wait()
	return out
}
