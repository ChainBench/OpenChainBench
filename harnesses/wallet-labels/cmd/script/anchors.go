package main

// Curated anchor sample. Sources we trust as ground truth for "well-known
// addresses every reasonable provider should label":
//   • Etherscan public Name Tags (CEX hot wallets, DEX routers)
//   • OFAC SDN crypto list (sanctioned)
//   • Safe-global/safe-deployments (multisig factories)
//   • DefiLlama protocol treasuries
//   • Public figures the broader ecosystem knows (vitalik, CZ, SBF)
//
// Every address here is verifiable against a public source. Rotate this
// list quarterly to limit gameability.
//
// Composition target:
//   ~50 EVM (mostly Ethereum, some Base/BNB/Arbitrum/Polygon/OP)
//   ~15 Solana
//   ~10 TRON
//   ~5 each: TON, Stellar, XRP, Bitcoin
//
// Format: chain id matches the keys in pulse normalizeChain (kept consistent
// with the rest of the harness — solana, ethereum, bnb, base, arbitrum,
// polygon, optimism, ton, stellar, xrp, bitcoin).

type anchor struct {
	Chain   string
	Address string
	Hint    string // descriptive only; not used to score, just for /debug
}

var anchorSample = []anchor{
	// === Ethereum: CEX ===
	{"ethereum", "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance 14"},
	{"ethereum", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8"},
	{"ethereum", "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d", "Binance 16"},
	{"ethereum", "0x564286362092D8e7936f0549571a803B203aAceD", "Binance 1"},
	{"ethereum", "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", "Binance 15"},
	{"ethereum", "0xfE9e8709d3215310075d67E3ed32A380CCf451C8", "Binance 17"},
	{"ethereum", "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", "Coinbase 1"},
	{"ethereum", "0x503828976D22510aad0201ac7EC88293211D23Da", "Coinbase 2"},
	{"ethereum", "0xddfAbCdc4D8FfC6d5beaf154f18B778f892A0740", "Coinbase 3"},
	{"ethereum", "0x3cD751E6b0078Be393132286c442345e5DC49699", "Coinbase 4"},
	{"ethereum", "0x53d284357ec70cE289D6D64134DfAc8E511c8a3D", "Kraken 1"},
	{"ethereum", "0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2", "Kraken 2"},
	{"ethereum", "0x267be1C1D684F78cb4F6a176C4911b741E4Ffdc0", "Kraken 3"},
	{"ethereum", "0x66f820a414680B5bcda5eECA5dea238543F42054", "OKX 1"},
	{"ethereum", "0x5041ed759Dd4aFc3a72b8192C143F72f4724081A", "OKX 4"},
	{"ethereum", "0x5e3eF299fDDf15eAa0432E6e66473ace8c13D908", "Bitfinex"},
	{"ethereum", "0x1151314c646Ce4E0eFD76d1aF4760aE66a9Fe30F", "Bitfinex Hot"},
	{"ethereum", "0xf89d7b9c864f589bbF53a82105107622B35EaA40", "Bybit Hot"},

	// === Ethereum: DEX routers / aggregators ===
	{"ethereum", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router"},
	{"ethereum", "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", "Uniswap V3 Router 2"},
	{"ethereum", "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", "Uniswap V2 Router"},
	{"ethereum", "0x000000000022D473030F116dDEE9F6B43aC78BA3", "Permit2"},
	{"ethereum", "0x1111111254EEB25477B68fb85Ed929f73A960582", "1inch V5"},
	{"ethereum", "0x111111125421cA6dc452d289314280a0f8842A65", "1inch V6"},
	{"ethereum", "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", "0x Exchange Proxy"},

	// === Ethereum: Tornado Cash (OFAC sanctioned) ===
	{"ethereum", "0xa160cdAB225685dA1d56aa342Ad8841c3b53f291", "Tornado Cash 100 ETH"},
	{"ethereum", "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc", "Tornado Cash 0.1 ETH"},
	{"ethereum", "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936", "Tornado Cash 1 ETH"},
	{"ethereum", "0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF", "Tornado Cash 10 ETH"},

	// === Ethereum: public figures / treasuries ===
	{"ethereum", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth"},
	{"ethereum", "0x4E04F2eDc6c9c9da6B7DDCfA9eF11d4d31E07e72", "CZ Binance"},
	{"ethereum", "0x1a9C8182C09F50C8318d769245beA52c32BE35BC", "Uniswap Treasury"},

	// === Base ===
	{"base", "0x4200000000000000000000000000000000000006", "WETH (Base)"},
	{"base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC (Base)"},
	{"base", "0x2626664c2603336E57B271c5C0b26F421741e481", "Uniswap V3 Router (Base)"},
	{"base", "0x6A000F20005980200259B80c5102003040001068", "Coinbase Smart Wallet factory"},

	// === BNB Chain ===
	{"bnb", "0x10ED43C718714eb63d5aA57B78B54704E256024E", "PancakeSwap V2 Router"},
	{"bnb", "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", "PancakeSwap V3 Router"},
	{"bnb", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (BSC)"},

	// === Arbitrum ===
	{"arbitrum", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (Arbitrum)"},
	{"arbitrum", "0x489ee077994B6658eAfA855C308275EAd8097C4A", "GMX Vault"},

	// === Polygon ===
	{"polygon", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (Polygon)"},
	{"polygon", "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", "QuickSwap V2 Router"},

	// === Optimism ===
	{"optimism", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (OP)"},
	{"optimism", "0x4200000000000000000000000000000000000006", "WETH (OP)"},

	// === Solana ===
	{"solana", "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "Raydium Authority"},
	{"solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "Jupiter Fee Wallet"},
	{"solana", "DRiP2Pn2K6fuMLKQmt5rZWxa91v6jbUUYdjP1k5Mzbt7", "DRiP Haus"},
	{"solana", "GjwcWFQYzemBtpUoN5fMAP2FZviTtMRWCmrppGuTthJS", "MEV Searcher"},
	{"solana", "GThUX1Atko4tqhN2NaiTazWSeFWMuiUiswQrAogEHaqv", "Stake Pool"},

	// === TON ===
	{"ton", "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt", "STON.fi DEX"},
	{"ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", "USDT (TON)"},

	// === Stellar ===
	{"stellar", "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", "Binance"},
	{"stellar", "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM", "Kraken"},
	{"stellar", "GAESQGK5TTKPT2JY4STRN6MJU56LNHQVBFROGX5GFIWUPK3JHZ5F5FCI", "WireX Deposit"},

	// === XRP ===
	{"xrp", "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", "Bitstamp"},
	{"xrp", "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh", "Bitstamp 2"},
	{"xrp", "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59", "Ripple ops"},

	// === Bitcoin ===
	{"bitcoin", "1HckjUpRGcrrRAtFaaCAUaGjsPx9oYmLaZ", "Huobi-2 (clustering)"},
	{"bitcoin", "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2", "Binance cold"},
	{"bitcoin", "3HX5tttedDehKWTTGpxaPAbo157fnjn89s", "Coinbase cold"},
}
