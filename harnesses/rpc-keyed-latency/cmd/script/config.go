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
var providers = []string{"infura", "alchemy", "chainstack", "ankr", "helius"}
var chainsEVM = []string{"ethereum", "base", "arbitrum", "optimism", "bnb", "polygon"}

func endpoints() []Endpoint {
	var out []Endpoint
	for _, p := range providers {
		for _, c := range chainsEVM {
			if url := envURL(p, c); url != "" {
				out = append(out, Endpoint{Provider: p, Chain: c, Kind: "evm", URL: url})
			}
		}
		if url := envURL(p, "solana"); url != "" {
			out = append(out, Endpoint{Provider: p, Chain: "solana", Kind: "solana", URL: url})
		}
	}
	return out
}

func envURL(provider, chain string) string {
	key := fmt.Sprintf("RPC_KEYED_URL_%s_%s",
		strings.ToUpper(provider), strings.ToUpper(chain))
	return strings.TrimSpace(os.Getenv(key))
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
var defaultBudgets = map[string]int64{
	"infura":     370_000,
	"alchemy":    450_000,
	"chainstack": 900_000,
	"ankr":       300_000,
	"helius":     300_000,
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
