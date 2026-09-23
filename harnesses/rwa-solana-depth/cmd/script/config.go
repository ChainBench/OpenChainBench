package main

import (
	"net/url"
	"os"
	"strings"
	"time"
)

// rwa-solana-depth: what a sale of a tokenized real-world asset actually
// costs on Solana, at size. Dashboards add up what issuers declare on the
// chain ($4.6B on Solana in September 2026); this harness asks Jupiter,
// for every asset in the cohort, what $1k, $10k and $100k of it sell for
// right now against USDC, and publishes the cost of each size relative to
// a $100 sale, in basis points. An asset with no route at all (BUIDL,
// USTB on Solana) is measured too: its on-chain supply is read from the
// mint and its cost is "no route", which the bench lists unranked.
//
// Quotes: Jupiter lite-api /swap/v1/quote, token -> USDC, one route
// search per size, spaced quoteGap apart (lite tier: 60 req/min). Four
// quotes per routed asset per tick ($100, $1k, $10k, $100k) plus one
// unit quote for a new asset, so a 14-asset cohort takes about a minute;
// the tick is two minutes.
//
// Supply: getTokenSupply on the mint every supplyInterval through the
// keyed Solana RPC (publicnode refuses the call without a key). The USD
// value is raw supply times the executable USD price per raw unit from
// the $100 quote, so a Token-2022 scaled-UI mint needs no multiplier
// handling here: both sides are raw units.

const (
	usdcMint       = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	pollInterval   = 120 * time.Second
	supplyInterval = 10 * time.Minute
	httpTimeout    = 15 * time.Second
	quoteGap       = 1100 * time.Millisecond
	refUSD         = 100.0
)

// sizes are the sale sizes measured, in USD, and the metric suffix each
// one publishes under.
var sizes = []struct {
	USD    float64
	Suffix string
}{
	{1_000, "1k"},
	{10_000, "10k"},
	{100_000, "100k"},
}

type Asset struct {
	Slug     string // provider slug in the spec (matches the sibling benches)
	Name     string
	Issuer   string
	Mint     string
	Decimals int
	// Routed is false for a transfer-restricted fund that has no open
	// market: the harness still reads its supply and confirms the absence
	// of a route every tick, and publishes no cost.
	Routed bool
	// NavUSD is a fixed per-unit value for a fund whose token is designed
	// to hold it (BUIDL at $1.00, dividends paid in new tokens); it prices
	// the on-chain supply when no quote can. Zero when unknown.
	NavUSD float64
}

var assets = []Asset{
	// Tokenized treasuries and cash funds
	{Slug: "usdy", Name: "USDY", Issuer: "ondo", Mint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", Decimals: 6, Routed: true},
	{Slug: "buidl", Name: "BUIDL", Issuer: "blackrock", Mint: "GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr", Decimals: 6, NavUSD: 1},
	{Slug: "ustb", Name: "USTB", Issuer: "superstate", Mint: "CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2", Decimals: 6},
	// Tokenized gold
	{Slug: "paxg", Name: "PAXG", Issuer: "paxos", Mint: "5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW", Decimals: 6, Routed: true},
	// Tokenized stocks (Backed xStocks), same mints and slugs as xstocks-peg
	{Slug: "tsla", Name: "TSLAx", Issuer: "xstocks", Mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", Decimals: 8, Routed: true},
	{Slug: "nvda", Name: "NVDAx", Issuer: "xstocks", Mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", Decimals: 8, Routed: true},
	{Slug: "aapl", Name: "AAPLx", Issuer: "xstocks", Mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", Decimals: 8, Routed: true},
	{Slug: "msft", Name: "MSFTx", Issuer: "xstocks", Mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", Decimals: 8, Routed: true},
	{Slug: "amzn", Name: "AMZNx", Issuer: "xstocks", Mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", Decimals: 8, Routed: true},
	{Slug: "googl", Name: "GOOGLx", Issuer: "xstocks", Mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", Decimals: 8, Routed: true},
	{Slug: "meta", Name: "METAx", Issuer: "xstocks", Mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", Decimals: 8, Routed: true},
	{Slug: "hood", Name: "HOODx", Issuer: "xstocks", Mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", Decimals: 8, Routed: true},
	{Slug: "spy", Name: "SPYx", Issuer: "xstocks", Mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", Decimals: 8, Routed: true},
	{Slug: "qqq", Name: "QQQx", Issuer: "xstocks", Mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", Decimals: 8, Routed: true},
	{Slug: "coin", Name: "COINx", Issuer: "xstocks", Mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", Decimals: 8, Routed: true},
	{Slug: "pltr", Name: "PLTRx", Issuer: "xstocks", Mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4", Decimals: 8, Routed: true},
}

func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("LISTEN_ADDR")); v != "" {
		return v
	}
	return ":2112"
}

// solanaRPC is the keyed Solana endpoint for getTokenSupply
// (RWA_SOLANA_RPC, or the xstocks-peg XS_SOLANA_RPC when the two share
// an env file). The public default rejects the call without a key, in
// which case supply is simply not published.
func solanaRPC() string {
	for _, k := range []string{"RWA_SOLANA_RPC", "XS_SOLANA_RPC"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return "https://solana-rpc.publicnode.com"
}

// rpcHost is the RPC URL's host only: a keyed URL never reaches the log.
func rpcHost() string {
	if u, err := url.Parse(solanaRPC()); err == nil && u.Host != "" {
		return u.Host
	}
	return "(unparsed)"
}
