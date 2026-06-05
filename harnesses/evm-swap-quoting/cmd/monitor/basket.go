package main

import "strings"

// TestPair is a single (chainId, tokenIn, tokenOut, amount) tuple we quote
// once per tick. Amounts are stored in the smallest unit (wei / 1e6 micro
// for USDC etc.) because most providers want wei in their query string;
// the few that want human-readable convert at adapter level.
type TestPair struct {
	Chain         string // OCB chain slug — used as Prom label
	ChainId       int    // numeric EVM chainId
	TokenIn       string // 0x-prefixed lowercase, or ZERO_ADDRESS / NATIVE_SENTINEL
	TokenOut      string
	TokenInSym    string // e.g. "ETH", "USDC", "BNB" — for logs
	TokenOutSym   string
	AmountHuman   string // human-readable for adapters that want it (Mobula, OpenOcean)
	AmountWei     string // smallest unit for adapters that want it (KyberSwap, Bebop, LI.FI, Odos, 0x, 1inch)
	TokenInDec    int    // decimal count, for adapters that need it (Paraswap)
	TokenOutDec   int
}

// Standardized native-asset sentinels.
// Different aggregators use different sentinels for "the native chain token"
// (ETH on Ethereum, BNB on BSC, etc.). Adapters translate the canonical
// 0xEeee... form below to whatever their server expects.
const (
	NativeSentinel = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" // canonical (1inch, Mobula, OpenOcean)
	ZeroAddress    = "0x0000000000000000000000000000000000000000" // Odos convention
)

// V1 basket: 5 pairs across 4 chains. Hardcoded — EVM gas costs make
// trending-token rotation expensive. Once Mobula's swap router has stable
// route caching we can revisit.
var Basket = []TestPair{
	{
		Chain:       "ethereum",
		ChainId:     1,
		TokenIn:     NativeSentinel, // ETH
		TokenOut:    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT (EIP-55 checksum — Bebop rejects lowercase)
		TokenInSym:  "ETH",
		TokenOutSym: "USDT",
		AmountHuman: "1",
		AmountWei:   "1000000000000000000", // 1e18
		TokenInDec:  18,
		TokenOutDec: 6,
	},
	{
		Chain:       "ethereum",
		ChainId:     1,
		TokenIn:     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC (EIP-55)
		TokenOut:    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT (EIP-55)
		TokenInSym:  "USDC",
		TokenOutSym: "USDT",
		AmountHuman: "1000",
		AmountWei:   "1000000000", // 1000 * 1e6
		TokenInDec:  6,
		TokenOutDec: 6,
	},
	{
		Chain:       "base",
		ChainId:     8453,
		TokenIn:     NativeSentinel, // ETH on Base
		TokenOut:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
		TokenInSym:  "ETH",
		TokenOutSym: "USDC",
		AmountHuman: "0.5",
		AmountWei:   "500000000000000000", // 0.5e18
		TokenInDec:  18,
		TokenOutDec: 6,
	},
	{
		Chain:       "arbitrum",
		ChainId:     42161,
		TokenIn:     "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC Arbitrum
		TokenOut:    NativeSentinel, // ETH
		TokenInSym:  "USDC",
		TokenOutSym: "ETH",
		AmountHuman: "100",
		AmountWei:   "100000000", // 100 * 1e6
		TokenInDec:  6,
		TokenOutDec: 18,
	},
	{
		Chain:       "bsc",
		ChainId:     56,
		TokenIn:     NativeSentinel, // BNB
		TokenOut:    "0x55d398326f99059fF775485246999027B3197955", // USDT BSC
		TokenInSym:  "BNB",
		TokenOutSym: "USDT",
		AmountHuman: "1",
		AmountWei:   "1000000000000000000", // 1e18
		TokenInDec:  18,
		TokenOutDec: 18,
	},
}

// ChainSlugFor returns the canonical chain slug for a chainId. Adapters that
// embed the slug in the URL (KyberSwap, Bebop) read from this map.
func ChainSlugFor(chainId int) string {
	switch chainId {
	case 1:
		return "ethereum"
	case 8453:
		return "base"
	case 42161:
		return "arbitrum"
	case 56:
		return "bsc"
	case 137:
		return "polygon"
	case 10:
		return "optimism"
	}
	return ""
}

// normalizeNative returns the chain-native token in the form a specific
// adapter wants. Use the helper inside each adapter, not at Basket level.
func mapNative(addr, replacement string) string {
	if strings.EqualFold(addr, NativeSentinel) {
		return replacement
	}
	return addr
}
