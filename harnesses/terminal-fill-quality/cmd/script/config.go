package main

import "strings"

// Terminal is one cohort member: the trading app or Telegram bot whose
// swaps we sample. Wallets are the Solana accounts that receive the
// terminal's fee on every routed swap (the same lists DeFiLlama's dexs /
// fees adapters match on, so attribution is identical to bench 267);
// Internal accounts are the terminal's own signers that must never be
// mistaken for the user (FOMO's gas sponsor pays the tx fee and signs).
type Terminal struct {
	Slug     string   `json:"slug"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // app | bot
	Wallets  []string `json:"wallets"`
	Internal []string `json:"internal,omitempty"`
	// Programs: extra addresses to scan for signatures when the terminal's
	// swaps go through its own on-chain program rather than a fee wallet
	// transfer (BasedBot). Fee attribution still uses Wallets.
	Programs []string `json:"programs,omitempty"`
	Note     string   `json:"note,omitempty"`
}

func (t Terminal) scanAddresses() []string {
	return append(append([]string{}, t.Wallets...), t.Programs...)
}

var terminals = []Terminal{
	{Slug: "axiom", Name: "Axiom", Kind: "app", Wallets: []string{
		"7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj", "4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S", "CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ",
		"AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW", "7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws", "9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP",
		"DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy", "4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd", "76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf",
		"H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK", "8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm", "4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz",
		"8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb", "86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG", "DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM",
		"5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB", "DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF", "Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9",
		"846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8", "5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg",
	}},
	{Slug: "gmgn", Name: "GMGN", Kind: "app", Wallets: []string{
		"BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT", "7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA", "HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3",
		"ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy", "DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9", "3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK",
		"DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx", "dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ", "6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn",
	}, Note: "GMGN's fee wallets also receive 1-lamport markers on wallet-funding transfers; those are not swaps and are excluded."},
	{Slug: "fomo", Name: "FOMO", Kind: "app",
		Wallets:  []string{"R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX"},
		Internal: []string{"AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51"},
		Note:     "FOMO sponsors gas: its own signer pays the transaction fee, so the user's network cost is zero. Fees are taken in USDC. Cross-chain trades routed through Relay are not swaps on Solana and are not sampled."},
	{Slug: "basedbot", Name: "BasedBot", Kind: "bot", Wallets: []string{"8umVV7k9HoVm4yy5DiRtKSH5qbKtw8xWDARGX8QiLfLe"},
		Programs: []string{"CuodpYRDz4k87K6ZUFxk7X8JkVv5dNVZAcTQX2TEzTef"},
		Note:     "Swaps go through BasedBot's own program; fees are taken in USD1 and converted to the trade's quote unit at $1."},
	{Slug: "photon", Name: "Photon", Kind: "app", Wallets: []string{"AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH"}},
	{Slug: "trojan", Name: "Trojan", Kind: "bot", Wallets: []string{
		"92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH", "2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ", "65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH",
		"BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp", "8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn", "9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco",
	}},
	{Slug: "bullx", Name: "BullX", Kind: "app", Wallets: []string{"9RYJ3qr5eU5xAooqVcbmdeusjcViL5Nkiq7Gske3tiKq", "F4hJ3Ee3c5UuaorKAMfELBjYCjiiLH75haZTKqTywRP3"}},
	{Slug: "bloom", Name: "Bloom", Kind: "bot", Wallets: []string{"7HeD6sLLqAnKVRuSfc1Ko3BSPMNKWgGTiWLKXJF31vKM"}},
	{Slug: "maestro", Name: "Maestro", Kind: "bot", Wallets: []string{"MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36", "FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN"}},
	{Slug: "pepeboost", Name: "Pepeboost", Kind: "bot", Wallets: []string{"G9PhF9C9H83mAjjkdJz4MDqkufiTPMJkx7TnKE1kFyCp"}},
}

// Tip accounts of the inclusion services: lamports sent here are the
// priority the user paid to land, a network cost like the priority fee.
// Jito (8 mainnet tip accounts), 0slot and bloXroute by address, Nozomi /
// Temporal by its "noz" vanity prefix. Services not listed here end up in
// "other"; the per-terminal other_top list in the JSON is there to catch
// them.
var tipAccounts = set(
	// Jito
	"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyvL8HLPxsuYyRZgmL4LLYbXP7WhQXBRcpNhTr8s",
	"ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
	"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
	// 0slot
	"7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK", "6fQaVhYZA4w3MBSXjJ81Vf6W1EDYrrwyGVUhmpm2LuLb", "4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4",
	// bloXroute
	"HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY",
)

func isTip(pubkey string) bool {
	return tipAccounts[pubkey] || strings.HasPrefix(pubkey, "noz")
}

const (
	wsolMint = "So11111111111111111111111111111111111111112"
	usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	usdtMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
	usd1Mint = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"
)

// Stable quote mints, priced at $1.
var stableMints = set(usdcMint, usdtMint, usd1Mint)

// DEX programs. `cp` marks constant-product venues whose vault balances
// give the pre-trade mid price directly; the pump.fun curve is handled
// separately (virtual reserves); everything else is left unpriced.
type venueInfo struct {
	name string
	cp   bool
}

var venuePrograms = map[string]venueInfo{
	"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": {"pumpswap", true},
	// pump.fun curve: the stored virtual reserves no longer predict the
	// executed price (2026 curves fill 20 to 60 % above virtual_sol /
	// virtual_token on real trades), so no reserve mid; previous trade.
	"6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P":  {"pump-curve", false},
	"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {"raydium-v4", true},
	"CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": {"raydium-cpmm", true},
	"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": {"raydium-clmm", false},
	"LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj":  {"raydium-launchpad", false},
	"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo":  {"meteora-dlmm", false},
	"cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG":  {"meteora-damm2", false},
	"dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN":  {"meteora-dbc", false},
	"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc":  {"orca", false},
	"JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  {"jupiter", false},
}

// PumpSwap pool account: pools migrated from pump.fun carry a virtual
// quote reserve (about 17.58 SOL, pool-specific) stored after the
// coin_creator field; price = (quote vault + offset) / base vault. Verified
// against executed trades: x·y = k holds exactly with it, and fails
// without. Non-migrated pools store 0.
const pumpSwapQuoteOffsetAt = 245 // little-endian u64, lamports

// pump.fun bonding curve account: virtual_token, virtual_sol, real_token,
// real_sol, total_supply as little-endian u64 after the 8-byte
// discriminator; virtual − real are constants per curve (30 SOL and
// 279.9M tokens on current curves) and are read once per curve.
const pumpCurveFieldsAt = 8

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}
