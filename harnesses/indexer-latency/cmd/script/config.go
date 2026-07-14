package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// indexer-latency — bench №084.
//
// Cohort: indexing INFRASTRUCTURE (HyperSync, The Graph, Alchemy raw
// data API). Deliberately zero provider overlap with bench 070
// (indexing-freshness), which races wallet-data APIs (Zerion, Moralis,
// Allium, GoldRush, Mobula). Same measured question, different layer of
// the stack: how fast does new onchain data become queryable through
// each indexing pipeline.

// Provider is one indexing pipeline we race. Enabled reports whether
// the required credential is present; a provider without one runs in
// the "disabled" state (counted, health=0) so the harness degrades
// gracefully instead of exiting.
//
// EveryN throttles participation for quota-tight free tiers: the
// provider only joins every Nth probe event. Budget is the monthly
// API-call budget for the guard (90% cutoff, calendar-month reset).
type Provider struct {
	Slug    string
	EveryN  int
	Budget  int64
	Enabled func() bool
	// Check asks the provider whether the probe event (USDC Transfer
	// tx in block bn) is queryable yet. The probed entity differs per
	// provider (raw log vs subgraph block head) — disclosed in the
	// bench methodology; the question is identical: "is block N data
	// queryable at time T?".
	Check func(bn uint64, txHash string) (bool, error)
}

var cohort = []Provider{
	// HyperSync free tier (token required since Nov 2025) is sized in
	// the hundreds of millions of rows/month; our row volume is tiny,
	// so the guard is request-count based with wide headroom.
	{Slug: "hypersync", EveryN: 1, Budget: 400_000, Enabled: func() bool { return hypersyncToken() != "" }, Check: checkHyperSync},
	// The Graph free plan: 100k gateway queries/month. EveryN=2 on the
	// 5-min event cadence = 1 probe event / 10 min → 144 events/day ×
	// 14 polls ≈ 60k queries/month worst case, inside the 90k budget.
	{Slug: "thegraph", EveryN: 2, Budget: 90_000, Enabled: func() bool { return graphAPIKey() != "" }, Check: checkTheGraph},
	// Alchemy free tier: 30M CU/month; alchemy_getAssetTransfers ≈ 150
	// CU/call. 288 events/day × 14 polls ≈ 121k calls/month ≈ 18M CU.
	// Budget 180k calls ≈ 27M CU keeps the guard inside the tier.
	{Slug: "alchemy", EveryN: 1, Budget: 180_000, Enabled: func() bool { return alchemyAPIKey() != "" }, Check: checkAlchemy},
}

const chainSlug = "ethereum"

// USDC on Ethereum mainnet + the ERC-20 Transfer topic — the natural
// high-frequency event stream we piggyback on (no canary contract, $0).
const (
	usdcContract  = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
	transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
)

func hypersyncToken() string { return strings.TrimSpace(os.Getenv("HYPERSYNC_TOKEN")) }
func graphAPIKey() string    { return strings.TrimSpace(os.Getenv("GRAPH_API_KEY")) }
func alchemyAPIKey() string  { return strings.TrimSpace(os.Getenv("ALCHEMY_API_KEY")) }

// rpcHTTP: OUR keyless reference RPC. T0 = the instant it first shows
// the block containing the probe event. publicnode by default; never a
// cohort member's RPC (that would gift them a head start).
func rpcHTTP() string {
	if v := strings.TrimSpace(os.Getenv("INDEXER_RPC_HTTP")); v != "" {
		return v
	}
	return "https://ethereum-rpc.publicnode.com"
}

// eventInterval: one probe event (fresh USDC Transfer picked from a new
// block) per interval. 5 min default → 288 events/day, which keeps
// every provider inside its monthly free quota given the poll schedule
// (The Graph additionally joins only every 2nd event).
func eventInterval() time.Duration {
	if v := strings.TrimSpace(os.Getenv("IDX_EVENT_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 30 {
			return time.Duration(n) * time.Second
		}
	}
	return 5 * time.Minute
}

// pollSchedule: seconds after T0 at which each provider is polled.
// Front-loaded because HyperSync claims sub-second freshness while
// subgraph pipelines can lag minutes; capped at 240s (< event interval)
// after which the event counts as "timeout". Measured lag is an upper
// bound with resolution equal to the gap between consecutive polls.
var pollSchedule = []int{1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180, 240}
