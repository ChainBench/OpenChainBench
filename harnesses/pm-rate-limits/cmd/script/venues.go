package main

import (
	"context"
	"net/http"
	"time"
)

// Pin is the market each venue's book/price probes target. Re-pinned daily at
// 00:00 UTC (near-the-money, most liquid, expiry >24h out) and immediately on
// probe_invalid so a resolved market never counts against the venue.
type Pin struct {
	Market    string // slug / ticker / contract id (logs + re-pin avoidance)
	Token     string // Polymarket CLOB token id
	Condition string // Polymarket conditionId (0x-hex) — Codex marketId; "" elsewhere
	Expiry    time.Time
}

type Class struct {
	Name     string
	Interval time.Duration
	Timeout  time.Duration
	URL      func(p Pin) string
}

// Venue defines the probe matrix for one native prediction-market API.
// Classes[0] is the primary class (drives pmapi_health and the cold probe).
// RampRates are requests per 10 s window per tier; nil excludes the venue
// from the daily ramp (Myriad: keyless 30 req/10s budget, ramping it would
// just measure our own quota).
type Venue struct {
	Slug        string
	Classes     []Class
	PinFunc     func(ctx context.Context, c *http.Client, avoid string) (Pin, error)
	StalenessMs func(class string, body []byte) (int64, bool)
	RampRates   []int
	StopOn429   bool     // Kalshi: documented token bucket, stop at first 429
	InvalidBody []string // 4xx body substrings that mark a probe_invalid (stale pin)

	state *venueState // wired at startup
}

func venues() []*Venue {
	return []*Venue{
		{
			Slug: "polymarket",
			Classes: []Class{
				{Name: "book", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string { return "https://clob.polymarket.com/book?token_id=" + p.Token }},
				{Name: "price", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string { return "https://clob.polymarket.com/midpoint?token_id=" + p.Token }},
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string {
						return "https://gamma-api.polymarket.com/markets?limit=20&order=volume24hr&ascending=false&closed=false"
					}},
			},
			PinFunc:     pinPolymarket,
			StalenessMs: stalenessPolymarket,
			RampRates:   []int{25, 50, 100}, // 1.7-6.7% of the documented 1500/10s book budget
			InvalidBody: []string{"No orderbook exists"},
		},
		{
			Slug: "kalshi",
			Classes: []Class{
				{Name: "book", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.elections.kalshi.com/trade-api/v2/markets/" + p.Market + "/orderbook"
					}},
				{Name: "price", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.elections.kalshi.com/trade-api/v2/markets/" + p.Market
					}},
				// The list endpoint sits behind CloudFront with max-age=15: it
				// measures the edge, not the API. Disclosed in the methodology,
				// cache label records it on every sample.
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string {
						return "https://api.elections.kalshi.com/trade-api/v2/markets?limit=100&status=open"
					}},
			},
			PinFunc:   pinKalshi,
			RampRates: []int{25, 50, 100},
			StopOn429: true,
		},
		{
			Slug: "limitless",
			Classes: []Class{
				{Name: "book", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.limitless.exchange/markets/" + p.Market + "/orderbook"
					}},
				{Name: "price", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string { return "https://api.limitless.exchange/markets/" + p.Market }},
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string { return "https://api.limitless.exchange/markets/active?limit=20" }},
			},
			PinFunc: pinLimitless,
			// Undocumented limits, errors CDN-cached 4h: conservative tiers + the
			// global abort guard.
			RampRates:   []int{10, 20, 40},
			InvalidBody: []string{"Market is not active", "does not support orderbook", "not found", "Not Found"},
		},
		{
			Slug: "manifold",
			Classes: []Class{
				// AMM venue: the closest thing to a book is the bets feed.
				{Name: "book", Interval: 7 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.manifold.markets/v0/bets?contractId=" + p.Market + "&limit=50"
					}},
				{Name: "price", Interval: 7 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string { return "https://api.manifold.markets/v0/market/" + p.Market }},
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string {
						return "https://api.manifold.markets/v0/markets?limit=50&sort=last-bet-time"
					}},
			},
			PinFunc:     pinManifold,
			StalenessMs: stalenessManifold,
			// Everything sits behind max-age=5 + swr=10 (Google frontend): probes
			// spaced 7s per URL so we mostly see origin, cache label flags the rest.
			// 500 req/min/IP documented, bots welcome: tiers clamped to 15/30/60.
			RampRates: []int{15, 30, 60},
		},
		{
			Slug: "myriad",
			Classes: []Class{
				// No orderbook endpoint (AMM, no bets feed either): price + list only.
				// That absence is a leaderboard column, not a gap in the harness.
				{Name: "price", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string { return "https://api-v2.myriadprotocol.com/markets/" + p.Market }},
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string { return "https://api-v2.myriadprotocol.com/markets?state=open&limit=20" }},
			},
			PinFunc:   pinMyriad,
			RampRates: nil,
		},
		{
			Slug: "predictit",
			Classes: []Class{
				// PredictIt documents 5 req/min. 15s interval gives 4 req/min with safety margin.
				// No book endpoint exists on their API.
				{Name: "price", Interval: 15 * time.Second, Timeout: 12 * time.Second,
					URL: func(p Pin) string {
						return "https://www.predictit.org/api/marketdata/markets/" + p.Market
					}},
				{Name: "list", Interval: 15 * time.Second, Timeout: 12 * time.Second,
					URL: func(Pin) string {
						return "https://www.predictit.org/api/marketdata/all"
					}},
			},
			PinFunc:   pinPredictIt,
			RampRates: nil, // rate-limited: no ramp; probing at their published cap already
			StopOn429: true,
		},
		{
			Slug: "smarkets",
			Classes: []Class{
				{Name: "book", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.smarkets.com/v3/markets/" + p.Market + "/quotes/"
					}},
				{Name: "price", Interval: 5 * time.Second, Timeout: 8 * time.Second,
					URL: func(p Pin) string {
						return "https://api.smarkets.com/v3/markets/" + p.Market + "/"
					}},
				{Name: "list", Interval: 30 * time.Second, Timeout: 15 * time.Second,
					URL: func(Pin) string {
						// Popular events listing, no event-ID dependency for the list probe
						return "https://api.smarkets.com/v3/events/?type_domain=politics&sort=popular&per_page=20&state=upcoming"
					}},
			},
			PinFunc:   pinSmarkets,
			RampRates: []int{10, 25, 50},
		},
	}
}

// ProbeSource is one (venue, source) cell the aggregator harness probes
// once a tick. Source is the Prometheus label value ("mobula" |
// "predexon" | "codex"). AuthMutator stamps the credential header on the
// request (no-op when the key env var is empty). Throttle blocks until
// the next call may proceed (Predexon enforces a 1 rps global cap, the
// other providers leave it nil). Method defaults to GET; Codex needs
// POST with a GraphQL body, so BodyFunc + ContentType cover that.
type ProbeSource struct {
	Venue       string
	Source      string
	Class       string // probe class label, currently "price"
	Interval    time.Duration
	Timeout     time.Duration
	URL         func(pin Pin) string
	AuthMutator func(*http.Request)
	Throttle    func()
	Method      string           // "GET" (default) or "POST"
	BodyFunc    func(pin Pin) []byte
	ContentType string
}

// aggregatorProbes returns the (venue, source) pairs the harness probes
// alongside the direct venue gateways. Coverage as of build:
//   - mobula:   polymarket
//   - predexon: polymarket, kalshi, limitless
//   - codex:    polymarket, kalshi   (GraphQL POST + JWT)
//
// Codex pairs use Method=POST + BodyFunc to send the GraphQL query, and
// the AuthMutator mints (or reuses) a JWT from DEFINED_SESSION_COOKIE.
// They share the same venueState pin as the direct probes so every
// regression stays apples to apples. Codex's predictionMarketPrice
// marketId is Pin.Condition for Polymarket (the 0x-hex conditionId
// populated by pinPolymarket from gamma) and Pin.Market for Kalshi
// (the ticker, used directly). When DEFINED_SESSION_COOKIE is empty
// the Codex pairs aren't appended at all, so no probe ever runs without
// a credential path.
func aggregatorProbes(cfg Config) []ProbeSource {
	var out []ProbeSource
	if cfg.MobulaAPIKey != "" {
		out = append(out, ProbeSource{
			Venue: "polymarket", Source: "mobula", Class: "price",
			Interval:    5 * time.Second,
			Timeout:     8 * time.Second,
			URL:         func(pin Pin) string { return mobulaPolymarketURL("polymarket", pin) },
			AuthMutator: mobulaAuth(cfg.MobulaAPIKey),
		})
	}
	if cfg.PredexonAPIKey != "" {
		out = append(out,
			ProbeSource{
				Venue: "polymarket", Source: "predexon", Class: "price",
				Interval:    5 * time.Second,
				Timeout:     8 * time.Second,
				URL:         func(pin Pin) string { return predexonPolymarketURL("polymarket", pin) },
				AuthMutator: predexonAuth(cfg.PredexonAPIKey),
				Throttle:    throttlePredexon,
			},
			ProbeSource{
				Venue: "kalshi", Source: "predexon", Class: "price",
				Interval:    5 * time.Second,
				Timeout:     8 * time.Second,
				URL:         func(pin Pin) string { return predexonKalshiURL("kalshi", pin) },
				AuthMutator: predexonAuth(cfg.PredexonAPIKey),
				Throttle:    throttlePredexon,
			},
			ProbeSource{
				Venue: "limitless", Source: "predexon", Class: "price",
				Interval:    5 * time.Second,
				Timeout:     8 * time.Second,
				URL:         func(pin Pin) string { return predexonLimitlessURL("limitless", pin) },
				AuthMutator: predexonAuth(cfg.PredexonAPIKey),
				Throttle:    throttlePredexon,
			},
		)
	}
	if cfg.DefinedSessionCookie != "" {
		out = append(out,
			ProbeSource{
				Venue: "polymarket", Source: "codex", Class: "price",
				Interval:    5 * time.Second,
				Timeout:     8 * time.Second,
				URL:         func(Pin) string { return codexGraphQLURL },
				BodyFunc:    func(pin Pin) []byte { return codexBody(codexPolymarketMarketID(pin.Token)) },
				AuthMutator: codexAuth(cfg.DefinedSessionCookie),
				Method:      "POST",
				ContentType: "application/json",
			},
			ProbeSource{
				Venue: "kalshi", Source: "codex", Class: "price",
				Interval:    5 * time.Second,
				Timeout:     8 * time.Second,
				URL:         func(Pin) string { return codexGraphQLURL },
				BodyFunc:    func(pin Pin) []byte { return codexBody(codexKalshiMarketID(pin.Market)) },
				AuthMutator: codexAuth(cfg.DefinedSessionCookie),
				Method:      "POST",
				ContentType: "application/json",
			},
		)
	}
	return out
}
