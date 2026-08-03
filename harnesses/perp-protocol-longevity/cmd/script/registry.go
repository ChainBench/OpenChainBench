package main

import "time"

// incidentRecord is one confirmed security incident for a venue.
// Only events resulting in direct theft or permanent loss of user funds
// via a protocol vulnerability are included. Net loss is stored (gross minus returned).
type incidentRecord struct {
	Date      time.Time
	AmountUSD float64
	Kind      string // "exploit", "oracle-manipulation", "admin-key"
	Source    string // public post-mortem or DeFiLlama URL
}

// venueRecord holds all known incidents for a venue plus its launch date.
// DefiLlamaNames: substring matches against DeFiLlama hack.Name (case-insensitive).
// Empty slice = no auto-enrichment (used when DeFiLlama would pull wrong-version incidents).
type venueRecord struct {
	Slug           string
	Name           string
	Launched       time.Time
	Incidents      []incidentRecord
	DefiLlamaNames []string
}

// Registry seeded from rekt.news / DeFiLlama as of 2026-08-03.
// Known incidents are pre-seeded so the registry works without network access.
// enrichFromDefiLlama() supplements this daily with newly-discovered incidents.
var registry = []venueRecord{
	{
		Slug:     "gains",
		Name:     "gains.trade",
		Launched: time.Date(2021, 12, 1, 0, 0, 0, 0, time.UTC),
		// No incidents recorded in DeFiLlama or public post-mortems as of 2026-08-03.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"gains.trade", "gains network"},
	},
	{
		Slug:     "gmx",
		Name:     "GMX",
		Launched: time.Date(2021, 9, 1, 0, 0, 0, 0, time.UTC),
		Incidents: []incidentRecord{
			// V1 oracle/price attack on Arbitrum, Sept 2022.
			{
				Date:      time.Date(2022, 9, 18, 0, 0, 0, 0, time.UTC),
				AmountUSD: 565_000,
				Kind:      "oracle-manipulation",
				Source:    "https://defillama.com/hacks",
			},
			// V1 re-entrancy exploit July 2025. $42M taken; $40M returned by attacker.
			// Net permanent loss: $2M. Resets the clean-streak counter.
			{
				Date:      time.Date(2025, 7, 9, 0, 0, 0, 0, time.UTC),
				AmountUSD: 2_000_000,
				Kind:      "exploit",
				Source:    "https://defillama.com/hacks",
			},
		},
		DefiLlamaNames: []string{"gmx"},
	},
	{
		Slug:     "hyperliquid",
		Name:     "Hyperliquid",
		Launched: time.Date(2023, 11, 1, 0, 0, 0, 0, time.UTC),
		// No protocol exploit recorded. The March 2025 JellyJelly event was a
		// market-structure incident (liquidation cascade + validator committee
		// emergency close). No smart contract compromised, no funds stolen via a
		// protocol vulnerability. Excluded per methodology.
		// DeFiLlama has a pre-launch "Hyperliquid" entry (June 2023, $37K) that
		// predates mainnet by 5 months — filtered by the Launched date check.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"hyperliquid"},
	},
	{
		Slug:     "dydx",
		Name:     "dYdX v4",
		Launched: time.Date(2023, 10, 1, 0, 0, 0, 0, time.UTC),
		// The Nov 2023 $9M incident was on dYdX V3 (Ethereum). Out of scope for
		// the V4 Cosmos appchain deployment tracked here. No V4 exploit recorded.
		// DefiLlamaNames intentionally empty: DeFiLlama tracks dYdX as one entity
		// and would pull V3 incidents into V4.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{},
	},
	{
		Slug:           "lighter",
		Name:           "Lighter",
		Launched:       time.Date(2023, 7, 1, 0, 0, 0, 0, time.UTC),
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"lighter"},
	},
	{
		Slug:           "paradex",
		Name:           "Paradex",
		Launched:       time.Date(2023, 10, 1, 0, 0, 0, 0, time.UTC),
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"paradex"},
	},
	{
		Slug:     "aster",
		Name:     "Aster",
		Launched: time.Date(2024, 12, 1, 0, 0, 0, 0, time.UTC),
		// Aster DEX went live under this brand after the APX Finance merger in Dec 2024.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"asterdex", "aster dex"},
	},
	{
		Slug:     "edgex",
		Name:     "EdgeX",
		Launched: time.Date(2024, 10, 3, 0, 0, 0, 0, time.UTC),
		// StarkEx-powered non-custodial perp DEX, mainnet launch Oct 3, 2024.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{"edgex"},
	},
	{
		Slug:     "polymarket",
		Name:     "Polymarket Perps",
		Launched: time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC),
		// Perps product launched July 8, 2026. Two DeFiLlama incidents for "Polymarket"
		// (May-June 2026) are on the prediction market product, not perps, and predate
		// the perps launch — filtered by the Launched date check.
		// DefiLlamaNames intentionally empty to avoid false-positive prediction-market matches.
		Incidents:      []incidentRecord{},
		DefiLlamaNames: []string{},
	},
}

// cleanStreakStart returns the Unix timestamp from which the clean streak is
// measured: the launch date if no incidents, or the last incident date.
func cleanStreakStart(vr venueRecord) int64 {
	if len(vr.Incidents) == 0 {
		return vr.Launched.Unix()
	}
	last := vr.Incidents[0].Date
	for _, inc := range vr.Incidents[1:] {
		if inc.Date.After(last) {
			last = inc.Date
		}
	}
	return last.Unix()
}

// totalIncidentAmount returns the sum of net USD losses across all recorded incidents.
func totalIncidentAmount(vr venueRecord) float64 {
	var total float64
	for _, inc := range vr.Incidents {
		total += inc.AmountUSD
	}
	return total
}
