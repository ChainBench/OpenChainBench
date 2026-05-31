package main

import "context"

// Provider is the contract every quote-latency adapter satisfies.
//
// Probe quotes USDC -> tokenOut on the provider's Solana endpoint and returns:
//   - latencyMs measured around the HTTP round-trip on a warm (keep-alive)
//     connection. Only meaningful when ok == true.
//   - ok=true ONLY when the response body parsed AND contained a usable
//     out-amount field for tokenOut.
//   - ok=false on any failure where the latency is NOT representative of a
//     successful quote. Implementations record the failure into the right
//     counter (RecordAuthError / RecordThrottled / RecordNoRoute /
//     RecordOtherError) before returning so the scheduler only has to
//     record latency for the happy path.
type Provider interface {
	Slug() string
	Probe(ctx context.Context, tokenOut TrendingToken) (latencyMs int64, ok bool, err error)
}
