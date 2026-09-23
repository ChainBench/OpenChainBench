package main

// fundingAssets is the asset set the native funding sources publish on
// perp_venue_funding_24h_bps: the assets the /perps/<asset> pages and the
// funding benches read. Mobula's aggregator publishes more; a native
// source keeps the label cardinality to what the site consumes.
var fundingAssets = map[string]bool{"BTC": true, "ETH": true, "SOL": true}

// fundingBps24h converts a rate per funding interval to the cost, in
// basis points, of holding a long for 24 hours at that rate.
func fundingBps24h(ratePerInterval, intervalHours float64) float64 {
	if intervalHours <= 0 {
		return 0
	}
	return ratePerInterval * (24 / intervalHours) * 10000
}
