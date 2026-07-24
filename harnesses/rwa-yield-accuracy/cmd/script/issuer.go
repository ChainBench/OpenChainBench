package main

import (
	"context"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
)

// Measurement is one probe result for a single token on a single
// chain. All three delivered-yield windows are computed together so
// the caller (main loop) writes them atomically to Prometheus.
type Measurement struct {
	Token   string
	Issuer  string
	Chain   string

	// All yields in basis points (530 = 5.30%).
	DeliveredBps30d      int
	DeliveredBps7d       int
	DeliveredBpsLifetime int

	// totalSupply in the token's own base units (usually 1e18 or 1e6).
	TotalSupplyUnits float64

	// AUM in USD (totalSupply × share price, evaluated per issuer).
	AUMUSD float64

	// Cumulative USDC distributions counted during THIS probe for
	// dividend-model tokens. Rebase/NAV probes return 0.
	NewDistributionsUSD float64

	MeasuredAt time.Time
}

// IssuerProbe is the per-token measurement contract. Each implementation
// encodes the specific on-chain read path for that issuer's yield
// mechanism (rebase, dividend, NAV appreciation).
//
// Measure MUST be safe to call in parallel with itself for different
// tokens; probes typically hold their own RPC client. It MUST NOT
// mutate Prometheus metrics — the caller owns metric writes so a
// single probe error doesn't wipe healthy gauges.
type IssuerProbe interface {
	Slug() string  // token slug, e.g. "usdy"
	Issuer() string // issuer slug, e.g. "ondo"
	Chain() string  // chain slug, e.g. "ethereum"

	// Measure reads the on-chain state (and any off-chain NAV source
	// for NAV-model tokens) and returns a fully-populated Measurement.
	// Should honor ctx cancellation for graceful shutdown.
	Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error)
}
