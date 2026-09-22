package main

// Venue is one OCB-tracked perp DEX with its routing tags. The Slug
// field MUST match the OCB site's perp venue registry so the Prom
// selector `{venue="<slug>"}` matches what the bench page reads.
//
// Adding a venue:
//  1. Append here
//  2. Append on the OCB site's perp registry
//  3. Add priority entries in adapter.go priorityMap()
//  4. Redeploy both sides
type Venue struct {
	Slug  string
	Name  string
	Type  string // "perp"
	Chain string // settlement chain (hyperliquid, base, arbitrum, ...)
}

// Registry is the canonical list of OCB-tracked perp venues. Order =
// display order in the perp hub. The framework scales by appending.
var Registry = []Venue{
	{Slug: "hyperliquid", Name: "Hyperliquid", Type: "perp", Chain: "hyperliquid"},
	{Slug: "lighter", Name: "Lighter", Type: "perp", Chain: "zksync"},
	{Slug: "gmx-v2", Name: "GMX V2", Type: "perp", Chain: "arbitrum"},
	{Slug: "gains", Name: "Gains", Type: "perp", Chain: "arbitrum"},
	{Slug: "dydx", Name: "dYdX v4", Type: "perp", Chain: "dydx"},
	{Slug: "paradex", Name: "Paradex", Type: "perp", Chain: "paradex"},
	{Slug: "edgex", Name: "edgeX", Type: "perp", Chain: "edgex"},
	{Slug: "aster", Name: "Aster", Type: "perp", Chain: "bnb"},
	// Vertex wound down on Arbitrum in 2026; the team's venue is Nado on Ink
	// and source_vertex.go has read Nado's gateway and archive since then.
	{Slug: "nado", Name: "Nado", Type: "perp", Chain: "ink"},
	{Slug: "grvt", Name: "GRVT", Type: "perp", Chain: "grvt"},
	// TODO(sprint4): re-add Drift once the Solana RPC + Anchor IDL
	// adapter ships. The public REST surface (dlob, mainnet-beta, api,
	// data.api) has been fully blocked for the entire Sprint 3 audit
	// and DefiLlama's drift page reports total24h=$0 because the
	// upstream adapter is broken too, so the venue was visually present
	// on /perps but always rendered as a dashed-out row that 404'd on
	// click. Park the entry here instead of shipping a stub.
	{Slug: "extended", Name: "Extended", Type: "perp", Chain: "starknet"},
	{Slug: "aevo", Name: "Aevo", Type: "perp", Chain: "aevo"},
	{Slug: "pacifica", Name: "Pacifica", Type: "perp", Chain: "solana"},
	{Slug: "variational", Name: "Variational", Type: "perp", Chain: "arbitrum"},
	{Slug: "ostium", Name: "Ostium", Type: "perp", Chain: "arbitrum"},
	{Slug: "polymarket", Name: "Polymarket", Type: "perp", Chain: "polygon"},
	{Slug: "synfutures", Name: "SynFutures", Type: "perp", Chain: "base"},
	{Slug: "kiloex", Name: "KiloEx", Type: "perp", Chain: "bnb"},
	{Slug: "orderly", Name: "Orderly", Type: "perp", Chain: "arbitrum"},
	{Slug: "backpack", Name: "Backpack", Type: "perp", Chain: "solana"},
	// Ondo Perps: SGX off-chain matching, custody on Ethereum and Arbitrum.
	{Slug: "ondo", Name: "Ondo Perps", Type: "perp", Chain: "ethereum"},
	// Phase 2 (2026-09-22). Kalshi is a CFTC-regulated US exchange, not a
	// DEX; it sits in the cohort so the regulated row can be compared.
	{Slug: "kalshi", Name: "Kalshi", Type: "perp", Chain: "offchain"},
	{Slug: "vest", Name: "Vest", Type: "perp", Chain: "vest"},
	{Slug: "standx", Name: "StandX", Type: "perp", Chain: "bnb"},
	{Slug: "apex", Name: "ApeX Omni", Type: "perp", Chain: "omni"},
	{Slug: "jupiter", Name: "Jupiter Perps", Type: "perp", Chain: "solana"},
	// Lighter's Robinhood deployment: separate books and API host.
	{Slug: "lighter-rh", Name: "Lighter RH", Type: "perp", Chain: "lighter-rh"},
	// trade.xyz is the operator of Hyperliquid's `xyz` HIP-3 dex.
	{Slug: "trade-xyz", Name: "trade.xyz", Type: "perp", Chain: "hyperliquid"},
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
