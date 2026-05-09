package main

import (
	"context"
	"net/http"
	"time"
)

// Result captured by every provider. `HasLabel` is true when the provider
// returned a non-generic entity name (skipping things like "EOA", "Contract"
// which carry no information). `Label` is the canonical entity name.
type LabelResult struct {
	Provider  string
	Chain     string
	Address   string
	HasLabel  bool
	Label     string
	LatencyMs int64
	Err       error
	Raw       map[string]any
}

// Provider is implemented by every label source. `Supports` lets us skip
// queries for chains a provider doesn't cover (e.g. Helius on EVM, XRPScan
// on Solana). This avoids generating "no data" series in Prom and keeps the
// per-chain leaderboards honest.
type Provider interface {
	Name() string
	Supports(chain string) bool
	Lookup(ctx context.Context, chain, address string) LabelResult
}

// httpClient — short timeout so a slow provider doesn't block workers.
var httpClient = &http.Client{Timeout: 8 * time.Second}

// genericLabel returns true for label strings that carry no useful entity
// signal (boilerplate categorizations every chain has). We exclude these
// from the success count so a provider that returns "EOA" for everything
// doesn't trivially win the bench.
func genericLabel(s string) bool {
	switch s {
	case "", "EOA", "eoa", "Contract", "contract", "Wallet", "wallet",
		"Account", "account", "Multisig", "multisig", "Unknown", "unknown",
		"unidentified", "unidentified_smart_contract":
		return true
	}
	return false
}
