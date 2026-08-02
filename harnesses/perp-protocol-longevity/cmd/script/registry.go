package main

import "time"

// incidentRecord is one confirmed security incident for a venue.
// Only events resulting in direct theft or permanent loss of user funds
// via a protocol vulnerability are included.
type incidentRecord struct {
	Date      time.Time
	AmountUSD float64
	Kind      string // "exploit", "oracle-manipulation", "admin-key"
	Source    string // public post-mortem URL
}

// venueRecord holds all known incidents for a venue plus its launch date.
type venueRecord struct {
	Slug      string
	Name      string
	Launched  time.Time
	Incidents []incidentRecord
}

// Registry version: 2026-08-02. Updated from rekt.news and public post-mortems.
// A venue with no incidents uses its launch date as the clean-streak start.
// Incidents excluded per methodology: front-end phishing, market-structure
// events (liquidation cascades, forced close, governance disputes), oracle
// price manipulation without a smart contract vulnerability.
var registry = []venueRecord{
	{
		Slug:     "gains",
		Name:     "gains.trade",
		Launched: time.Date(2021, 12, 1, 0, 0, 0, 0, time.UTC),
		// No incidents recorded in rekt.news or public post-mortems as of 2026-08-02.
		// The synthetic architecture (oracle pricing, no custodial vault drainable
		// without position netting, no privileged admin key on critical paths)
		// reduces the attack surface relative to AMM-based vault protocols.
		Incidents: []incidentRecord{},
	},
	{
		Slug:     "gmx",
		Name:     "GMX v2",
		Launched: time.Date(2023, 8, 1, 0, 0, 0, 0, time.UTC),
		Incidents: []incidentRecord{
			{
				Date:      time.Date(2025, 7, 9, 0, 0, 0, 0, time.UTC),
				AmountUSD: 42_000_000,
				Kind:      "exploit",
				Source:    "https://coinperps.xyz/gmx-v2-exploit-july-2025",
			},
		},
	},
	{
		Slug:     "hyperliquid",
		Name:     "Hyperliquid",
		Launched: time.Date(2023, 11, 1, 0, 0, 0, 0, time.UTC),
		// No protocol exploit recorded. The March 2025 JellyJelly event was a
		// market-structure incident (large-position liquidation cascade triggering
		// a validator committee emergency close). No smart contract was compromised
		// and no user funds were stolen via a protocol vulnerability. Excluded per
		// the methodology's incident criteria.
		Incidents: []incidentRecord{},
	},
	{
		Slug:     "dydx",
		Name:     "dYdX v4",
		Launched: time.Date(2023, 10, 1, 0, 0, 0, 0, time.UTC),
		// No exploit on the v4 Cosmos appchain deployment. dYdX v1/v2 on Ethereum
		// had oracle manipulation events in 2020-2021 but those ran on a different
		// contract and are out of scope for the v4 deployment tracked here.
		Incidents: []incidentRecord{},
	},
	{
		Slug:      "lighter",
		Name:      "Lighter",
		Launched:  time.Date(2023, 7, 1, 0, 0, 0, 0, time.UTC),
		Incidents: []incidentRecord{},
	},
	{
		Slug:      "paradex",
		Name:      "Paradex",
		Launched:  time.Date(2023, 10, 1, 0, 0, 0, 0, time.UTC),
		Incidents: []incidentRecord{},
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

// totalIncidentAmount returns the sum of USD losses across all recorded incidents.
func totalIncidentAmount(vr venueRecord) float64 {
	var total float64
	for _, inc := range vr.Incidents {
		total += inc.AmountUSD
	}
	return total
}
