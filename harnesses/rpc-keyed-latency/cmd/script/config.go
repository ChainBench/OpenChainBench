package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Endpoint is one (provider × chain) keyed RPC endpoint we probe.
// URLs come exclusively from env (RPC_KEYED_URL_<PROVIDER>_<CHAIN>)
// because every one of them embeds an API key — nothing here is
// committed to the repo. A (provider, chain) pair only enters the
// probe matrix when its env var is set, so partially-enabled
// providers (e.g. Ankr while Optimism is still locked) just skip the
// missing cells.
type Endpoint struct {
	Provider string // Prometheus label + OCB provider slug
	Chain    string // canonical OCB chain slug
	Kind     string // "evm" | "solana" — selects the probe payload
	URL      string
}

// matrix declares which (provider, chain) cells we look for in env.
// Kind is derived from the chain.
// BlockMachine (2026-10-24) carries its key in a query parameter rather than
// in the path, which every other provider here uses. Nothing in this harness
// changes for it: a whole URL still comes from env and no custom header is
// sent. Their docs offer Authorization: Bearer and X-API-Key as well, and are
// explicit that the header wins when set, so the query form is the one that
// works through a URL-only config. Verified against each chain before it was
// declared: eth_chainId returned the right id on all seven, and
// eth_blockNumber answered with the key in the query and no header at all.
// They serve neither Solana nor HyperEVM, so those two cells stay empty and
// the matrix skips them on its own.
var providers = []string{"infura", "alchemy", "chainstack", "ankr", "helius", "quicknode", "getblock", "dwellir", "validationcloud", "blockmachine"}

// Per-provider probe-interval multiplier. Infura's free tier 402'd daily
// at the old 60 s cadence (its real daily credit budget is below the
// documented 3M); at the shared 120 s cadence (RPC_KEYED_PROBE_SECONDS=120
// since 2026-09-18) six EVM chains from three regions cost ~1.0M
// credits/day, inside the cap, so Infura runs at the shared cadence.
var intervalMult = map[string]int{}

func intervalMultFor(provider string) int {
	if m, ok := intervalMult[provider]; ok && m > 0 {
		return m
	}
	return 1
}
// "hyperliquid" is HyperEVM (chain slug shared with the no-key
// hyperliquid-rpc bench); "arc" is Circle's Arc L1.
var chainsEVM = []string{"ethereum", "base", "arbitrum", "bnb", "polygon", "robinhood", "hyperliquid", "arc"}

// chainAllowed applies RPC_KEYED_CHAINS, a comma-separated allowlist of
// chain slugs. Unset means every chain with a URL is probed. Set it to
// pause the rest of the matrix while keeping every URL variable in place
// (2026-09-18: "robinhood" while the other eight pages wait for their
// third provider).
func chainAllowed(chain string) bool {
	raw := strings.TrimSpace(os.Getenv("RPC_KEYED_CHAINS"))
	if raw == "" {
		return true
	}
	for _, c := range strings.Split(raw, ",") {
		if strings.EqualFold(strings.TrimSpace(c), chain) {
			return true
		}
	}
	return false
}

func endpoints() []Endpoint {
	var out []Endpoint
	for _, p := range providers {
		for _, c := range chainsEVM {
			if !chainAllowed(c) {
				continue
			}
			if url := envURL(p, c); url != "" {
				out = append(out, Endpoint{Provider: p, Chain: c, Kind: "evm", URL: url})
			}
		}
		if url := envURL(p, "solana"); url != "" && chainAllowed("solana") {
			out = append(out, Endpoint{Provider: p, Chain: "solana", Kind: "solana", URL: url})
		}
	}
	return out
}

// envURL returns the endpoint for a (provider, chain) cell, or "" when the
// variable is unset or holds the "disabled" sentinel. Railway keeps a
// variable's value around when a cell is paused; without the sentinel the
// probe posted to the literal string "disabled" every cycle and logged an
// http_err per cell (2026-09-18).
func envURL(provider, chain string) string {
	key := fmt.Sprintf("RPC_KEYED_URL_%s_%s",
		strings.ToUpper(provider), strings.ToUpper(chain))
	v := strings.TrimSpace(os.Getenv(key))
	switch strings.ToLower(v) {
	case "", "disabled", "off", "-":
		return ""
	}
	if !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
		fmt.Printf("[config] %s ignored: not an http(s) URL\n", key)
		return ""
	}
	return v
}

// Per-region monthly request budgets (this service = one region; the
// three regional services share one API key per provider, so each
// region gets 1/3 of the provider's effective monthly quota).
// Defaults derive from the 2026-07 free-tier audit, converted to
// eth_getBlockByNumber-equivalent requests:
//   infura     ~1.1M/mo total → 370k per region
//   alchemy    ~1.5M/mo       → 450k
//   chainstack  3M/mo         → 900k
//   ankr       ~1M/mo         → 300k
//   helius      1M/mo         → 300k
// Override per provider with RPC_KEYED_BUDGET_<PROVIDER>.
// At 120 s a (provider, chain) cell costs 21.6k requests per region per
// month; nine chains are ~195k per region.
var defaultBudgets = map[string]int64{
	"infura":     370_000,
	// alchemy / quicknode: 600k per region = ~28 chains at 120 s. This is a
	// ceiling against a runaway loop, not a plan quota, which is why it sits
	// above what either plan allows. The plan itself is free tier: the
	// Alchemy key has been capped since 24 October on everything except
	// HyperEVM and Robinhood Chain, which is what the (provider, chain)
	// granularity in coverage.go exists to publish honestly. An earlier
	// version of this comment named enterprise accounts that are no longer
	// ours, and the spec and README both say free tier.
	"alchemy":    600_000,
	"quicknode":  600_000,
	// chainstack: Growth plan, 20M RU/month shared by three regions.
	"chainstack": 2_000_000,
	// getblock: Starter plan, 50M CU/month; eth_getBlockByNumber is 20 CU
	// on the main EVM chains and 50 on Solana, so ~2.5M requests/month
	// total is the real ceiling. 600k per region keeps a third in hand.
	"getblock":   600_000,
	"ankr":       300_000,
	"helius":     300_000,
	// blockmachine: 5M Request Units a month, one RU per call on
	// eth_getBlockByNumber, shared by the three regions. Seven chains at the
	// 120 s cadence cost 151k per region per month, so 454k of the plan, 9%
	// of it. 600k per region is four times what it spends and leaves the
	// plan two thirds unused.
	//
	// Declaring it is not cosmetic: an undeclared provider falls to the 100k
	// default below, which seven chains exhaust in twenty days. BlockMachine
	// would have stopped probing before the first month was out, and a
	// budget that runs out looks exactly like a provider that stopped
	// answering.
	"blockmachine": 600_000,
	// dwellir: Developer plan, $49/month, 25M API responses and 100
	// responses/sec, 1 RPC response = 1 API credit with no compute units.
	// Three regions share the key, so 8.3M per region is what the plan
	// actually allows; the eight EVM chains cost 173k per region per month at
	// the 120 s cadence, under 1% of it. The number below is therefore a
	// runaway guard, not a quota, and sits well inside the plan.
	// Dwellir does not serve Solana, and a cell with no URL is simply
	// skipped, so that chain stays at four providers with no special casing.
	"dwellir":    1_000_000,
	// validationcloud: plan not yet disclosed by the account holder, so this
	// is a runaway guard rather than a quota. Six chains at the 120 s cadence
	// cost 130k per region per month; raise or lower it once the plan is
	// known, and disclose the tier in each page's methodology the way every
	// other keyed provider is disclosed.
	"validationcloud": 600_000,
}

func budgetFor(provider string) int64 {
	if v := strings.TrimSpace(os.Getenv("RPC_KEYED_BUDGET_" + strings.ToUpper(provider))); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	if b, ok := defaultBudgets[provider]; ok {
		return b
	}
	return 100_000
}
