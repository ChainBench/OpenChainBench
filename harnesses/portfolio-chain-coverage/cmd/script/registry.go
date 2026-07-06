package main

// Provider is one wallet-portfolio API vendor measured by this harness.
// The Slug field MUST match the OCB site's provider registry so the
// Prom selector `{provider="<slug>"}` matches what the bench page
// reads.
//
// KeyEnv is the env var holding the vendor API key. When the env var
// is EMPTY the provider is SKIPPED gracefully (logged once) so the
// harness keeps running with a partial cohort — a missing key must
// never take the whole exporter down or zero out other providers.
//
// Probe runs one full daily measurement for the provider and returns
// a coverage struct. Fields set to -1 mean "unknown this cycle, do
// not publish" so the previous gauge value carries forward via Prom
// retention (publish-then-leave, same convention as pm-cohort-stats).
type Provider struct {
	Slug   string
	Name   string
	KeyEnv string
	Probe  func(key string) coverage
}

// coverage is the outcome of one provider probe cycle.
type coverage struct {
	// listed is the number of chains the vendor self-declares support
	// for via a machine-readable catalog endpoint. -1 = unknown.
	listed int

	// listedSource records where the listed count comes from:
	//   "declared" — a standalone chain-catalog endpoint
	//   "probe"    — no catalog endpoint exists; listed = networks
	//                visible in the portfolio probe response (Zapper)
	listedSource string

	// verified is the number of distinct chains where the vendor's
	// portfolio API returned a real balance (> $1, or native amount
	// > 0 when no USD value is present) for the canonical test
	// addresses. -1 = unknown.
	verified int

	// probed is the number of distinct chains where the probe got a
	// definitive answer from the API using an address KNOWN to hold a
	// real balance there (funding validated when the address was
	// pinned). verified/probed is therefore the indexer's demonstrable
	// success rate; listed minus probed is the untestable residue (no
	// funded public address available). Providers where funding
	// cannot be established per chain (Zerion single-call EVM,
	// Moralis candidates) report probed = verified, a conservative
	// floor. -1 = unknown.
	probed int

	// latencyMs is the aggregate HTTP round-trip across every call
	// made during the probe (including the one allowed retry).
	latencyMs float64
}

// Canonical test addresses, identical for every provider so the
// comparison is fair. High-activity, well-known public wallets that
// hold balances on many chains:
//
//	EVM: Binance 8 hot wallet — holds > $1 on virtually every EVM
//	     chain a portfolio API can index.
//	SOL: high-balance Solana wallet.
//	BTC: high-balance Bitcoin P2SH address.
const (
	evmTestAddress = "0xF977814e90dA44bFA03b6295A0616a897441aceC"
	solTestAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
	btcTestAddress = "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo"
)

// verifiedUsdThreshold is the USD floor above which a chain counts as
// probe-verified. $1 filters out dust/spam-token noise while staying
// far below the real balances the test wallets hold.
const verifiedUsdThreshold = 1.0

// Registry is the canonical list of measured portfolio API providers.
// Order = probe order (sequential, 5s spacing between providers).
// Adding a provider: append here, add its source_<slug>.go fetcher,
// append on the OCB site, redeploy both.
var Registry = []Provider{
	{Slug: "coinstats", Name: "CoinStats", KeyEnv: "COINSTATS_API_KEY", Probe: probeCoinStats},
	{Slug: "zerion", Name: "Zerion", KeyEnv: "ZERION_API_KEY", Probe: probeZerion},
	{Slug: "zapper", Name: "Zapper", KeyEnv: "ZAPPER_API_KEY", Probe: probeZapper},
	{Slug: "mobula", Name: "Mobula", KeyEnv: "MOBULA_API_KEY", Probe: probeMobula},
	{Slug: "moralis", Name: "Moralis", KeyEnv: "MORALIS_API_KEY", Probe: probeMoralis},
}
