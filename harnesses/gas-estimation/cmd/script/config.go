package main

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// Tier is the unified percentile label every oracle's prediction is
// mapped onto. We chose p25/p50/p90 because every oracle in the bench
// exposes at least three buckets that roughly align with this scheme;
// finer buckets (p75/p99) exist on Blocknative and Owlracle and are
// added back as `tier="p75"`/`tier="p99"` when the oracle supplies
// them. The label is what the OCB site groups by, so the per-oracle
// "fast/standard/slow" names never leak into the public metric.
type Tier string

const (
	TierP25 Tier = "p25"
	TierP50 Tier = "p50"
	TierP90 Tier = "p90"
	TierP75 Tier = "p75"
	TierP99 Tier = "p99"
)

// Oracle naming convention is the slug the OCB provider-registry uses.
// Add an entry to src/data/provider-registry.ts on the OCB side when
// onboarding a new oracle.
const (
	OracleBlocknative Oracle = "blocknative"
	OraclePublicNode  Oracle = "publicnode-feehistory"
	OracleOwlracle    Oracle = "owlracle"
	OracleEtherscan   Oracle = "etherscan"
)

type Oracle string

// Cadences pinned per oracle. Lifted directly from the verification
// agent's findings: Blocknative tolerates 12 s no-key; PublicNode
// feeHistory is fair-use at 5 req/s; Owlracle free tier is 100/hour,
// so 60 s is the safe ceiling; Etherscan no-key throttles to 1/5 s,
// so 15 s gives a comfortable margin. Cadences are per-chain too:
// running the same oracle against 3 chains at 12 s = 0.25 req/s
// per oracle, well inside every free-tier budget.
var pollIntervals = map[Oracle]time.Duration{
	OracleBlocknative: 12 * time.Second,
	OraclePublicNode:  12 * time.Second,
	OracleOwlracle:    60 * time.Second,
	OracleEtherscan:   15 * time.Second,
}

// Realized-block poll cadence per chain. Picked close to each chain's
// block time so the realizer picks up each new head exactly once;
// a small catch-up loop inside the realizer covers multi-block jumps.
// All three target chains produce blocks at 2 s (Polygon, Avalanche)
// or 12 s (Ethereum); we use the same conservative 12 s cadence for
// all of them and let the catch-up loop fill in the gaps on faster
// chains. Faster polling would waste public RPC budget.
const realizedPollInterval = 12 * time.Second

// pendingTTLBlocks bounds how long a prediction sits in the buffer
// before being dropped. ~5 minutes on Ethereum (25 blocks × 12 s);
// proportionally fewer real minutes on Polygon/Avalanche due to
// faster blocks, which matches what we want — anything older means
// the realizer is falling behind and the prediction is no longer
// informative anyway.
const pendingTTLBlocks = 25

// Chain is the source of truth for everything chain-specific in the
// harness. Each chain has its own (a) realized-fee RPC, (b) Owlracle
// path slug, (c) chainid used by the unified APIs, and (d) the set
// of oracles that have been verified to return usable data without
// an API key on that chain. The verification matrix lives in the
// commit message of the multi-chain expansion. one row per chain.
type Chain struct {
	Slug          string   // canonical OCB chain slug (lowercase)
	ChainID       int      // EVM chain id (1 / 137 / 43114)
	RealizedRPC   string   // PublicNode JSON-RPC endpoint for eth_getBlockByNumber + eth_feeHistory
	OwlracleSlug  string   // path slug for api.owlracle.info/v4/<slug>/gas
	BlockTimeSec  int      // nominal block time, used only for log lines
	SupportedSet  []Oracle // oracles verified no-key on this chain
}

// chains returns the chain matrix. Order matters only for log output.
func chains() []Chain {
	return []Chain{
		{
			Slug:         "ethereum",
			ChainID:      1,
			RealizedRPC:  envDefault("GAS_REALIZED_RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"),
			OwlracleSlug: "eth",
			BlockTimeSec: 12,
			// Etherscan v2 free tier covers chainid=1. All four oracles work.
			SupportedSet: []Oracle{OraclePublicNode, OracleOwlracle, OracleEtherscan},
		},
		{
			Slug:         "polygon",
			ChainID:      137,
			RealizedRPC:  envDefault("GAS_REALIZED_RPC_POLYGON", "https://polygon-bor-rpc.publicnode.com"),
			OwlracleSlug: "poly",
			BlockTimeSec: 2,
			// Etherscan v2 free tier covers chainid=137 (verified). All four oracles work.
			SupportedSet: []Oracle{OraclePublicNode, OracleOwlracle, OracleEtherscan},
		},
		{
			Slug:         "avalanche",
			ChainID:      43114,
			RealizedRPC:  envDefault("GAS_REALIZED_RPC_AVALANCHE", "https://avalanche-c-chain-rpc.publicnode.com"),
			OwlracleSlug: "avax",
			BlockTimeSec: 2,
			// Etherscan v2 returns "Free API access is not supported for this chain" on chainid=43114 — paid plan required.
			// Three oracles only (Blocknative + PublicNode feeHistory + Owlracle).
			SupportedSet: []Oracle{OraclePublicNode, OracleOwlracle},
		},
	}
}

// OracleEndpoint groups every per-oracle tunable that we let env vars
// override without a rebuild. The URL field is the BASE — per-chain
// rewriting happens in endpointForChain() below.
type OracleEndpoint struct {
	URL        string
	AuthHeader string
}

// endpointForChain builds the per-(oracle, chain) URL.
//
//   - Blocknative: same host, query param `?chainid=<N>`.
//   - PublicNode feeHistory: per-chain RPC URL from the Chain struct.
//   - Owlracle: per-chain path slug from the Chain struct.
//   - Etherscan v2: same host, `?chainid=<N>&module=gastracker&action=gasoracle`.
//
// Env-var overrides (GAS_URL_<ORACLE>_<CHAIN>) take precedence so
// individual chain endpoints can be repointed without a rebuild.
func endpointForChain(o Oracle, c Chain) OracleEndpoint {
	envKey := fmt.Sprintf("GAS_URL_%s_%s",
		strings.ToUpper(strings.ReplaceAll(string(o), "-", "_")),
		strings.ToUpper(c.Slug),
	)
	if override := envDefault(envKey, ""); override != "" {
		return OracleEndpoint{URL: override, AuthHeader: oracleAuthHeader(o)}
	}
	switch o {
	case OracleBlocknative:
		return OracleEndpoint{
			URL:        fmt.Sprintf("https://api.blocknative.com/gasprices/blockprices?chainid=%d", c.ChainID),
			AuthHeader: envDefault("GAS_TOKEN_BLOCKNATIVE", ""),
		}
	case OraclePublicNode:
		return OracleEndpoint{URL: c.RealizedRPC}
	case OracleOwlracle:
		return OracleEndpoint{
			URL: fmt.Sprintf("https://api.owlracle.info/v4/%s/gas", c.OwlracleSlug),
		}
	case OracleEtherscan:
		return OracleEndpoint{
			URL: fmt.Sprintf("https://api.etherscan.io/v2/api?chainid=%d&module=gastracker&action=gasoracle", c.ChainID),
		}
	}
	return OracleEndpoint{}
}

// oracleAuthHeader returns the optional Authorization header value
// for the given oracle. Currently only Blocknative supports a token.
func oracleAuthHeader(o Oracle) string {
	if o == OracleBlocknative {
		return envDefault("GAS_TOKEN_BLOCKNATIVE", "")
	}
	return ""
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
