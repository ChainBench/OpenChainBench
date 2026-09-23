package main

// Venue is one OCB-tracked prediction market venue with its routing tags.
// The Slug field MUST match the OCB site's PM venue registry so the Prom
// selector `{venue="<slug>"}` matches what the bench page reads.
//
// Type: "onchain" or "offchain". Drives which fetcher writes the gauges:
//   - polymarket: onchain (its own dedicated gamma-api fetcher)
//   - kalshi:    offchain (its own dedicated Kalshi REST fetcher)
//   - limitless: onchain, no public dedicated API yet, fed by DefiLlama
//   - manifold:  offchain, fed by DefiLlama protocols aggregate
//   - myriad:    offchain (its own dedicated api-v2.myriadprotocol.com
//     fetcher; PTS-token rows are filtered to avoid
//     non-monetary inflation of USD-denominated gauges)
//
// Chain: native settlement chain for onchain venues. Empty for offchain.
// Today: Polymarket on polygon, Limitless on base.
type Venue struct {
	Slug  string
	Name  string
	Type  string
	Chain string
}

// Registry is the canonical list of OCB-tracked PM venues.
// Order = display order in the PM hub.
// Adding a new venue: append here, append on the OCB site, redeploy both.
var Registry = []Venue{
	{Slug: "polymarket", Name: "Polymarket", Type: "onchain", Chain: "polygon"},
	{Slug: "polymarket-us", Name: "Polymarket US", Type: "offchain", Chain: ""},
	{Slug: "kalshi", Name: "Kalshi", Type: "offchain", Chain: ""},
	{Slug: "limitless", Name: "Limitless", Type: "onchain", Chain: "base"},
	{Slug: "manifold", Name: "Manifold", Type: "offchain", Chain: ""},
	{Slug: "myriad", Name: "Myriad", Type: "onchain", Chain: "abstract"},

	// Venues fed by the DefiLlama aggregate, added 2026-09-23 to take the
	// cohort from five rows with data to sixteen. A five-row board where
	// three rows are under $1M of open interest is not a ranking, it is a
	// list with two entries and some noise. Each DefiLlama name below was
	// verified against a live read of /protocols.
	//
	// Trueo publishes no REST or GraphQL API and no subgraph: api.trueo.com
	// answers {"service":"truth-market-api","status":"ok"} and 404s every
	// market path, and the front end calls relative Next.js routes. What it
	// does publish is the full Base deployment, including
	// TruthMarketManager 0x61A98Bef11867c69489B91f340fE545eEfc695d7, whose
	// clones are the live markets (docs.trueo.com/deployments). A native
	// fetcher is therefore buildable on chain reads; the aggregate is the
	// honest first cut and is how Limitless is fed today.
	//
	// Trueo announced on 2026-09-21 that it is moving the protocol to
	// Ethereum mainnet. Base keeps trading, settling and redeeming, and
	// users are told not to open Base markets expiring after 2027-01-31.
	// We read Trueo by DefiLlama protocol slug and never by chain, so the
	// move cannot break the series; the Chain field below is the label
	// that goes stale, and DefiLlama still reports Base alone today.
	{Slug: "rain", Name: "Rain", Type: "onchain", Chain: "arbitrum"},
	{Slug: "predict-fun", Name: "Predict Fun", Type: "onchain", Chain: "blast"},
	{Slug: "opinion", Name: "OPINION", Type: "onchain", Chain: "bnb"},
	{Slug: "sport-fun", Name: "Sport.fun", Type: "onchain", Chain: "base"},
	{Slug: "augur", Name: "Augur", Type: "onchain", Chain: "ethereum"},
	{Slug: "levr-bet", Name: "Levr Bet", Type: "onchain", Chain: "monad"},
	{Slug: "predictstreet", Name: "PredictStreet", Type: "onchain", Chain: ""},
	{Slug: "pascal", Name: "Pascal", Type: "onchain", Chain: "solana"},
	{Slug: "overtime", Name: "Overtime", Type: "onchain", Chain: "arbitrum"},
	{Slug: "trueo", Name: "Trueo", Type: "onchain", Chain: "base"},
	{Slug: "azuro", Name: "Azuro", Type: "onchain", Chain: "polygon"},
}

// VenueBySlug returns the Venue with the given slug, or nil if not found.
func VenueBySlug(slug string) *Venue {
	for i := range Registry {
		if Registry[i].Slug == slug {
			return &Registry[i]
		}
	}
	return nil
}
