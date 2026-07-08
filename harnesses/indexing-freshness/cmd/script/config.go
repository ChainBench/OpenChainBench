package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Provider is one wallet-data API we race. Keys come exclusively from
// env (INDEXING_KEY_<PROVIDER>); a provider without a key is skipped.
//
// EveryN throttles participation for quota-tight free tiers: the
// provider only joins every Nth probe event. Budget is the monthly
// API-call budget for the guard (90% cutoff, calendar-month reset) —
// derived from each free tier's documented quota with headroom.
type Provider struct {
	Slug   string
	EveryN int
	Budget int64
}

var providers = []Provider{
	{Slug: "mobula", EveryN: 1, Budget: 250_000},
	{Slug: "zerion", EveryN: 1, Budget: 55_000},
	// Moralis free tier: 40k CU/day; /wallets/{addr}/history costs 25 CU
	// per call, so full participation (144 events × 16 polls = 2,304
	// calls = 57.6k CU/day) blows the daily cap ~2/3 through the day
	// (the API then 401s until the UTC midnight reset). EveryN 2 keeps
	// it at ~28.8k CU/day. Budget = 40k/25 CU × 30 days in calls.
	{Slug: "moralis", EveryN: 2, Budget: 48_000},
	{Slug: "goldrush", EveryN: 1, Budget: 90_000},
	// Allium free tier: 20k calls/month, aggressive per-second limits.
	{Slug: "allium", EveryN: 3, Budget: 18_000},
}

func keyFor(slug string) string {
	return strings.TrimSpace(os.Getenv("INDEXING_KEY_" + strings.ToUpper(slug)))
}

func activeProviders() []Provider {
	var out []Provider
	for _, p := range providers {
		if keyFor(p.Slug) != "" {
			out = append(out, p)
		}
	}
	return out
}

const chainSlug = "base"

func rpcHTTP() string { return strings.TrimSpace(os.Getenv("INDEXING_RPC_HTTP")) }
func rpcWSS() string  { return strings.TrimSpace(os.Getenv("INDEXING_RPC_WSS")) }

// eventInterval: one probe event (fresh organic tx picked from a new
// block) per interval. 10 min default → 144 events/day, which keeps
// every provider inside its monthly free quota given the poll schedule.
func eventInterval() time.Duration {
	if v := strings.TrimSpace(os.Getenv("INDEXING_EVENT_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 60 {
			return time.Duration(n) * time.Second
		}
	}
	return 10 * time.Minute
}

// pollSchedule: seconds after T0 at which each provider is polled.
// Front-loaded because the interesting race happens in the first
// seconds; capped at 120s after which the event counts as "missed".
// Precision note for the methodology: measured lag is an upper bound
// with resolution equal to the gap between consecutive polls.
var pollSchedule = []int{1, 2, 3, 4, 6, 8, 11, 15, 20, 26, 34, 45, 60, 80, 100, 120}
