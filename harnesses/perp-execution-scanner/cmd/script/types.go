package main

// Level is a single orderbook price level with size in base units.
type Level struct {
	Price float64
	Size  float64
}

// OrderBook is a normalized orderbook snapshot for one (venue, asset) pair.
//
// Bids are sorted descending by price, asks ascending. ScrapeTs is the wall
// clock at fetch return in unix seconds; used both as a freshness signal
// and to publish perp_execution_last_scrape_ts to Prom.
type OrderBook struct {
	Venue    string
	Asset    string
	Bids     []Level
	Asks     []Level
	ScrapeTs int64
}
