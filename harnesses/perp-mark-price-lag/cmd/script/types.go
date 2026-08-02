package main

// MarkSample holds one mark-price observation for a venue x asset pair.
type MarkSample struct {
	Venue       string
	Asset       string
	MarkPrice   float64 // venue's published mark / oracle price
	RefPrice    float64 // Binance spot mid (reference)
	DeviationBps float64 // abs(mark - ref) / ref * 10000
	SignedBps   float64 // (mark - ref) / ref * 10000
	FetchLatMs  int64
	Err         string
}

// VenueConfig describes one venue x asset combination.
type VenueConfig struct {
	Slug  string // PromQL label
	Asset string // "ETH", "BTC", "SOL"
}
