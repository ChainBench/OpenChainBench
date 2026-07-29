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
//                fetcher; PTS-token rows are filtered to avoid
//                non-monetary inflation of USD-denominated gauges)
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
	{Slug: "polymarket",    Name: "Polymarket",    Type: "onchain",  Chain: "polygon"},
	{Slug: "polymarket-us", Name: "Polymarket US", Type: "offchain", Chain: ""},
	{Slug: "kalshi",        Name: "Kalshi",        Type: "offchain", Chain: ""},
	{Slug: "limitless",     Name: "Limitless",     Type: "onchain",  Chain: "base"},
	{Slug: "manifold",      Name: "Manifold",      Type: "offchain", Chain: ""},
	{Slug: "myriad",        Name: "Myriad",        Type: "onchain",  Chain: "abstract"},
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
