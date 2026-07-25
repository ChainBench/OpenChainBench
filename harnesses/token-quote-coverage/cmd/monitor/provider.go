package main

import "context"

// Token is one recently-active token fetched from Dexscreener.
type Token struct {
	Address string
	Chain   string // "solana", "base", "bsc", "robinhood"
	Venue   string // "pump-fun", "virtuals", "four-meme", "pons", etc.
}

// Provider is the chain-aware quote coverage adapter contract.
// Quote returns true only when outAmount > 0 was parsed from the response.
// The adapter is responsible for recording the attempt counter before returning.
type Provider interface {
	Slug() string
	SupportsChain(chain string) bool
	Quote(ctx context.Context, token Token) (ok bool)
}

// venueFromPair maps a Dexscreener (chainId, dexId) to a canonical venue slug.
func venueFromPair(chainId, dexId string) string {
	switch chainId {
	case "solana":
		switch dexId {
		case "pump-fun", "pumpfun":
			return "pump-fun"
		case "moonshot":
			return "moonshot"
		case "meteora", "meteora-dlmm":
			return "meteora-dbc"
		default:
			return "pump-fun"
		}
	case "base":
		switch dexId {
		case "virtual-fun", "virtualprotocol", "virtuals":
			return "virtuals"
		case "wow", "wow-xyz":
			return "wow"
		case "clanker":
			return "clanker"
		default:
			return "virtuals"
		}
	case "bsc":
		return "four-meme"
	case "robinhood":
		return "pons"
	}
	return "all"
}
