package main

// PerpSample is one observation of opening cost on a venue × asset pair.
type PerpSample struct {
	Venue            string  `json:"venue"`
	Asset            string  `json:"asset"`
	MidPrice         float64 `json:"mid_price"`
	TakerFeeBps      float64 `json:"taker_fee_bps"`        // from API, not hardcoded
	SpreadBps        float64 `json:"spread_bps"`            // half-spread + impact at $1000 notional
	AllInBps         float64 `json:"all_in_bps"`            // taker + spread
	FundingRatePerHrBps float64 `json:"funding_rate_per_hour_bps"` // signed; >0 means longs pay
	FetchLatencyMs   int64   `json:"fetch_latency_ms"`
	At               string  `json:"at"`
	Err              string  `json:"error,omitempty"`
}

// VenueConfig describes one venue × asset pair the harness should measure.
type VenueConfig struct {
	Slug       string  // unique label for Prom metrics
	Display    string  // human-readable name
	Asset      string  // "ETH", "BTC", "SOL"
	NotionalUSD float64 // trade size to simulate, e.g. 1000 for $1k
}
