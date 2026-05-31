package main

import "context"

// Provider is the contract every quote-latency adapter satisfies.
// Implementations MUST:
//   - return latencyMs measured from the moment we begin building the request
//     (or initiating the dial) until the response body has been parsed and
//     accepted as a real quote.
//   - return ok=false (and the corresponding RecordAuthError / RecordThrottled
//     / RecordOtherError already recorded) on 401/403/429 or any failure where
//     the latency value is NOT representative of a successful quote. The
//     scheduler will NOT record the histogram in that case.
//   - return ok=true ONLY when the response body parsed and contained a valid
//     quote payload.
type Provider interface {
	Slug() string
	Probe(ctx context.Context) (latencyMs int64, ok bool, err error)
}
