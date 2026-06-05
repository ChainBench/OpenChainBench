package main

import "context"

// Provider is the chain-aware quote adapter contract. Each adapter declares
// which chains it supports via Supports() so the scheduler can skip the
// (provider, pair) combos that would always fail. Mobula supports the full
// V1 basket; some providers like Bebop don't ship every chain.
//
// Probe MUST return ok=true ONLY when the response was parsed AND a usable
// output amount was extracted. ok=false on any failure where the latency is
// not representative — the adapter is responsible for recording the right
// counter (auth / throttle / no-route / other) before returning.
type Provider interface {
	Slug() string
	Supports(chainId int) bool
	Probe(ctx context.Context, pair TestPair) (latencyMs int64, ok bool, err error)
}
