package main

import "time"

// Provider is one block-explorer family measured by this harness.
// Slug MUST match the OCB site's provider registry. KeyEnv may be
// empty (fully keyless family); when set and the env var is empty the
// provider is SKIPPED gracefully (partial cohort, logged once).
type Provider struct {
	Slug   string
	Name   string
	KeyEnv string // "" = keyless family
	Probe  func(key string) coverage
}

// coverage is the outcome of one provider probe cycle.
type coverage struct {
	// registered is the chain count the family self-declares through
	// a machine-readable surface (Chainscout registry, Etherscan
	// chainlist, Routescan blockchains endpoint, ...). Mainnets only.
	// -1 = unknown this cycle.
	registered int

	// registeredSource labels where registered comes from:
	//   "registry" — a standalone machine-readable registry/chainlist
	//   "pinned"   — no machine surface exists; the harness pins the
	//                list (Subscan network subdomains)
	registeredSource string

	// verified is the number of registered mainnet chains whose
	// explorer API answered the freshness probe: latest indexed block
	// timestamp within freshWindow of now. A 200 from a stalled
	// indexer does NOT count. -1 = unknown.
	verified int

	// top50 is how many of the pinned top-50 most active mainnets
	// (see top50.go) passed the same freshness probe on this family.
	// This is the anti-inflation column: raw chain counts reward
	// hosting ghost chains, top50 answers the buyer question. -1 =
	// unknown.
	top50 int

	// latencyMs aggregates HTTP time across the probe cycle.
	latencyMs float64
}

// freshWindow is how recent the latest indexed block must be for a
// chain to count as live-verified. 60 minutes tolerates slow and lazy
// block producers (Bitcoin ~10m, low-traffic L2s with on-demand
// blocks) while still catching stalled indexers, which drift hours to
// weeks behind. Override via FRESH_WINDOW_MINUTES.
var freshWindow = 60 * time.Minute

// freshEnough is the shared gate: a chain counts only when its latest
// indexed block is younger than freshWindow.
func freshEnough(latest time.Time) bool {
	if latest.IsZero() {
		return false
	}
	return time.Since(latest) <= freshWindow
}

// Registry is the canonical cohort. Order = probe order (sequential).
var Registry = []Provider{
	{Slug: "blockscout", Name: "Blockscout", KeyEnv: "", Probe: probeBlockscout},
	{Slug: "etherscan", Name: "Etherscan", KeyEnv: "ETHERSCAN_API_KEY", Probe: probeEtherscan},
	{Slug: "routescan", Name: "Routescan", KeyEnv: "", Probe: probeRoutescan},
	{Slug: "blockchair", Name: "Blockchair", KeyEnv: "", Probe: probeBlockchair},
	{Slug: "subscan", Name: "Subscan", KeyEnv: "SUBSCAN_API_KEY", Probe: probeSubscan},
	{Slug: "oklink", Name: "OKLink", KeyEnv: "OKLINK_API_KEY", Probe: probeOKLink},
}
