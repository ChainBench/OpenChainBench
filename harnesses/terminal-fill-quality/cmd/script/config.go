package main

import "strings"

// methodVersion tags every sampled swap. Statistics are computed only on
// rows produced by the running method, so a change of accounting or
// reference never mixes with older rows inside the window; rows of an
// older version are dropped at load.
//
//	3: pools identified by vault pubkeys (not owner), tx fee inside the
//	   user's cost, terminal tip relays as network, FOMO stable fee legs,
//	   WSOL / program-account rent, loss bounds, 60 s reference cap.
const methodVersion = 3

// Terminal is one cohort member: the trading app or Telegram bot whose
// swaps we sample. Wallets are the Solana accounts that receive the
// terminal's fee on every routed swap (DeFiLlama's adapter lists and
// Dune's spellbook models, checked live on 2026-09-18); Internal are the
// terminal's own signers that must never be mistaken for the user (FOMO's
// gas sponsor pays the tx fee and signs); Tips are the terminal's own
// inclusion-tip recipients (fixed-size transfers to a relay that is not
// Jito), counted as network cost; Programs are extra addresses to
// subscribe to when swaps do not pass through a fee wallet transfer.
type Terminal struct {
	Slug     string   `json:"slug"`
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // app | bot
	Wallets  []string `json:"wallets"`
	Internal []string `json:"internal,omitempty"`
	Tips     []string `json:"tips,omitempty"`
	Programs []string `json:"programs,omitempty"`
	// StableLegsAreFee: besides its main fee wallet, the terminal's fee
	// arrives as user-signed stable transfers to per-trade accounts (FOMO
	// through the OKX router: commission leg plus one or two transferChecked
	// legs, 2 % of the trade with a $0.10 minimum on its DFlow flow). Such legs, outside any pool
	// instruction and under max(2 % of the trade, $0.12), count as terminal fee.
	StableLegsAreFee bool `json:"stable_legs_are_fee,omitempty"`
	// SolLegIsFee: the terminal's fee on buys is one SOL transfer of about
	// 1 % of the trade to a per-user or per-referrer account (Banana Gun:
	// sells pay the listed wallet, buys pay such an account).
	SolLegIsFee bool   `json:"sol_leg_is_fee,omitempty"`
	Note        string `json:"note,omitempty"`
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
		// second leg of the 1 % taken inside Axiom's router (seen as the
		// largest "other" recipients on Axiom swaps, fixed share of the trade)
		"EofHrDmFs6zwoDxXu7pSoSHGtbWSuhc5s3CHWVSRHdCF", "5VfFPJLaFJy86a91T6uov44LYW9Cz31CRKdt5n3diLxh",
	}, Tips: []string{
		// fixed-size transfers right after the swap; Mobula reports the same
		// amounts as mevFeesUSD on those transactions
		"YYVEwYxUif4zSGdnBxLdHU1ej4kQTgxKrkD5VXDU8RC", "7KKNPiFyi3b3VSM81sNEwHPxUGVZJHCTucqoh7rAABw4", "8d5jPhXwjEa9cPkQG2aFHw5cwE6KjytnPFJbmH1RgN1M",
		"J4PeVZhx2496eXjAMpbm7nrCxRBgAUfRDwhZ1YSdzTSE", "DU3oUMrzewfvuUN8HNA3rXTvbscCA3krY365mzfFixrT", "H9bSW2VTrRU7LuT5Zo5XEx3uuGhLDTeAJdEUxQX39314",
		"3rXRVo9hPjtWNJEhsN6WDmxD8ubBjTjHXugRVYyH5gC3",
	}},
	{Slug: "gmgn", Name: "GMGN", Kind: "app", Wallets: []string{
		"BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT", "7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA", "HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3",
		"ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy", "DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9", "3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK",
		"DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx", "dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ", "6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn",
	}, Note: "GMGN's fee wallets also receive 1-lamport markers on wallet-funding transfers; those invoke no swap program and are excluded from every count, the fail rate included."},
	// FOMO has two swap flows on Solana: the large ones through the
	// proVF4pM… router mention the fee wallet itself, the small ones
	// through DFlow pay its USDC token account (HrTf9Cz…) and never
	// mention the wallet, so a feed on the wallet alone saw the large
	// flow only (median $476 against Mobula's $13, 2026-09-19). Every
	// FOMO transaction carries the vanity account …TradeonFomo: the feed
	// subscribes to it.
	{Slug: "fomo", Name: "FOMO", Kind: "app",
		Wallets:          []string{"R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX"},
		Programs:         []string{"jitodontfront1111111111111111111TradeonFomo"},
		Internal:         []string{"AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51"},
		StableLegsAreFee: true,
		Note:             "FOMO sponsors gas: its own signer pays the transaction fee, so the user's network cost is zero. Its fee is a router commission plus one or two user-signed USDC legs to per-trade accounts, all counted as terminal fee. Its cross-chain trades through Relay are read on the destination chains and pooled with this Solana row on All chains."},
	{Slug: "photon", Name: "Photon", Kind: "app", Wallets: []string{"AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH"},
		Tips: []string{"9Y6UXhkaf5vJGhsmdWYitceaEkRDsvVNTgtVp4acu57S", "7J7fe1H9bo1ScWxoUny3raqM1WHqfERvSvEQDU7APKLe"}},
	{Slug: "trojan", Name: "Trojan", Kind: "bot", Wallets: []string{
		"92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH", "2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ", "65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH",
		"BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp", "8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn", "9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco",
	}, Tips: []string{
		// third account of Trojan's own FeeTransferWithTip instruction
		"BGT8Vm1u5nyW255LgWjD8wzsRs8g3KxBnB3Pm1FjC9fV", "75amCPfPecHipzFeE7gsBi8rLptXCEQGewon7jePpwHP", "GV4Bt6ehW5x5dqtaWAJBSnz8uum5Z2Rp9P2Tr5iVuQn5",
	}},
	{Slug: "bloom", Name: "Bloom", Kind: "bot", Wallets: []string{"7HeD6sLLqAnKVRuSfc1Ko3BSPMNKWgGTiWLKXJF31vKM"}},
	{Slug: "maestro", Name: "Maestro", Kind: "bot", Wallets: []string{"MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36"},
		Tips: []string{
			"BBtip8kpHzYPD2hhrcwV6P2stL7GRqxpiVkHBomSMrVB", "BBtipu7iCnY8fiJhXzmRRhs2PvjfgGHFGBjmP2wzFR51", "BBtiphcAHYAYUrurxjtJQaiswFnvrWZU3sRu7X3NGzfU",
			"BBtipcbK777hEJVrQ9CFPmnsRUM3LuxLxHayVtM7jYv8", "ste11JV3MLMM7x7EJUM2sXcJC1H7F4jBLnP9a9PG8PH",
		}},
	{Slug: "pepeboost", Name: "Pepeboost", Kind: "bot", Wallets: []string{"G9PhF9C9H83mAjjkdJz4MDqkufiTPMJkx7TnKE1kFyCp"},
		Tips: []string{"F7EtfYPC2SdB6TMTXyN6FGFqDEyDeYrgXaNRvzUu1zpT"}},
	// BONKbot, Banana Gun: fee receivers from Dune's spellbook and
	// DeFiLlama's fees adapter, the ones with live traffic on 2026-09-18.
	{Slug: "bonkbot", Name: "BONKbot", Kind: "bot", Wallets: []string{"ZG98FUCjb8mJ824Gbs6RsgVmr1FhXb2oNiJHa2dwmPd"}},
	{Slug: "banana-gun", Name: "Banana Gun", Kind: "bot", Wallets: []string{"47hEzz83VFR23rLTEeVm9A7eFzjJwjvdupPPmX3cePqF"},
		Programs:    []string{"BANANAjs7FJiPQqJTGFzkZJndT9o7UmKiYYGaJz6frGu"}, // its Solana router (DeFiLlama's dexs adapter attributes on it)
		SolLegIsFee: true, Note: "Banana Gun's sells pay its fee wallet; its buys pay 1 % of the swap as a SOL transfer to a per-user or per-referrer account, which no list holds: on a buy the one SOL leg of 0.8 to 1.2 % of the trade to an account outside every pool and tip set is the fee."},
	// Phantom's in-wallet swapper: 0.85 % of the quote to its fee wallet
	// (SOL, or WSOL into that wallet's token account 6Wzuv7…, the account
	// the transaction mentions), through Jupiter or its own router
	// proVF4pM…; ~45 swaps a minute on 2026-09-19 (Mobula attributes it,
	// fee accounts confirmed on the transactions).
	{Slug: "phantom", Name: "Phantom", Kind: "app", Wallets: []string{"9yj3zvLS3fDMqi1F8zhkaWfq8TZpZWHe6cz1Sgt7djXf"},
		Programs: []string{"6Wzuv7vLc6Vq8HJcHwwSCE9SKcdJiuoJmJm3EMFkWERN"},
		Note:     "Phantom's in-wallet swap: 0.85 % of the trade to its fee wallet in SOL or WSOL, routed through Jupiter or its own router."},
	// Terminal (formerly Padre): protocol share to the main fee wallet,
	// cashback / referral share to the second, both in the same
	// transaction (DeFiLlama's trading-terminal fees adapter).
	{Slug: "padre", Name: "Terminal", Kind: "app", Wallets: []string{"J5XGHmzrRmnYWbmw45DbYkdZAU2bwERFZ11qCDXPvFB5", "DoAsxPQgiyAxyaJNvpAAUb2ups6rbJRdYrCPyWxwRxBb"},
		Note: "Terminal (formerly Padre) splits its fee in the transaction between a protocol wallet and a cashback wallet; both count as terminal fee, the cashback later paid back to users is not netted."},
	// pump.fun's own mobile app: its swaps invoke the app program in the
	// same transaction (DeFiLlama's pumpfun-app adapter attributes on it).
	// The fixed 0.001 SOL it forwards to its pfn… accounts on every swap is
	// an inclusion tip (network), like the other terminals' relays.
	{Slug: "pump-fun", Name: "pump.fun app", Kind: "app", Programs: []string{"6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB"},
		Note: "pump.fun's mobile app takes no fee of its own; the fixed 0.001 SOL it forwards per swap to its pfn… accounts is counted as network, and pump.fun's protocol and creator fees sit in other."},
	// Not in the cohort: BullX (trading suspended 2026-06-01; its wallets
	// only receive 1,000-lamport markers from unrelated snipers), Nova (no
	// live fee wallet: the spellbook's last saw traffic weeks ago), BasedBot
	// (DeFiLlama's basedbid addresses are a launchpad; the bot's fee wallet
	// is not published).
}

// Inclusion-tip accounts of the relay services: lamports sent here are
// the priority the user paid to land, a network cost like the priority
// fee. Jito (8 mainnet tip accounts), 0slot, bloXroute, Astralane,
// Nozomi / Temporal; the terminal-specific relays are on each
// Terminal.Tips.
var tipAccounts = set(
	// Jito
	"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyvL8HLPxsuYyRZgmL4LLYbXP7WhQXBRcpNhTr8s",
	"ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
	"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
	// 0slot
	"7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK", "6fQaVhYZA4w3MBSXjJ81Vf6W1EDYrrwyGVUhmpm2LuLb", "4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4",
	// bloXroute
	"HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY",
	// Astralane
	"AStrAJv2RN2hKCHxwUMtqmSxgdcNZbihCwc1mCSnG83W", "Astran35aiQUF57XZsmkWMtNCtXGLzs8upfiqXxth2bz",
	// Nozomi / Temporal
	"TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq",
)

// isTip: listed accounts, plus the vanity prefixes of Nozomi ("noz"),
// Astralane ("astra", any case), Maestro's relay ("BBtip") and pump.fun's
// app ("pfn"); a random base58 key starts with a given 5-letter prefix
// once in ~6e8, with a 3-letter one once in ~2e5.
func isTip(pubkey string) bool {
	// ste11…: a relay family (Stellar) Maestro and Terminal's users tip; five
	// accounts seen on 2026-09-19, one listed under Maestro, the rest by prefix.
	if tipAccounts[pubkey] || strings.HasPrefix(pubkey, "noz") || strings.HasPrefix(pubkey, "BBtip") || strings.HasPrefix(pubkey, "pfn") || strings.HasPrefix(pubkey, "ste11") {
		return true
	}
	return len(pubkey) > 5 && strings.EqualFold(pubkey[:5], "astra")
}

// pump.fun protocol fee recipients (the recipient arrays of pump.fun's
// Global and PumpSwap's global_config); every curve / PumpSwap trade pays
// one of them. Named so the "other" component can be read: protocol fee
// versus creator vault versus the rest.
var pumpFeeRecipients = set(
	"62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV", "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ", "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
	"9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz", "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY", "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
	"FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz", "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP", "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU",
	"5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD", "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7", "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
	"3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR", "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6", "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
	"5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
	"A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW", // pump.fun fee program's vault, paid the same amount as CebN5W… on every curve buy (12 terminals, 2026-09-19)
)

const (
	wsolMint  = "So11111111111111111111111111111111111111112"
	usdcMint  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	usdtMint  = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
	usd1Mint  = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"
	usdsMint  = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"
	pyusdMint = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
)

// Stable quote mints, priced at $1.
var stableMints = set(usdcMint, usdtMint, usd1Mint, usdsMint, pyusdMint)

// DEX programs. `cp` marks constant-product venues whose vault balances
// give the pre-trade mid price directly (see reservePrice); the pump.fun
// curve is not one of them (2026 curves fill 20 to 60 % above their
// stored virtual reserves), nor are concentrated-liquidity venues.
type venueInfo struct {
	name string
	cp   bool
}

var venuePrograms = map[string]venueInfo{
	"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA":  {"pumpswap", true},
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

// swapProgramPrefixes: a transaction is a swap attempt when its logs show
// one of these programs invoked (venues, aggregator, terminal routers).
// The live feed classifies every notification with it, so the fail rate
// counts attempts only: wallet funding, fee sweeps and 1-lamport markers
// never invoke them.
var swapProgramPrefixes = []string{
	"pAMMBay6", "6EF8rrec", "675kPX9M", "CPMMoo8L", "CAMMCzo5", "LanMV9sA", "LBUZKhRx", "cpamdpZC", "dbcij3LW", "whirLbMi", "JUP6LkbZ",
	"FLASHX8D",             // Axiom router
	"GMgnVFR8", "GMGNreQc", // GMGN
	"b1oomGGq",             // Bloom
	"BBRouter", "MaestroA", // Maestro
	"BSfD6SHZ", "T1TANpTe", // Photon, Titan
	"proVF4pM", // a shared router (Phantom, FOMO's large flow, OKX)
	"troyXT7T", // Trojan
	"BANANAjs", // Banana Gun
	"DF1ow4ts", // DFlow (FOMO's router since 2026-09)
	"6Vo3245e", // pump.fun app
}

// PumpSwap pool account: pools migrated from pump.fun carry a virtual
// quote reserve (about 17.58 SOL, pool-specific) stored after the
// coin_creator field; price = (quote vault + offset) / base vault. Verified
// against executed trades on 8 pools: x·y = k holds exactly with it, and
// fails without; non-migrated pools store 0.
const pumpSwapQuoteOffsetAt = 245 // little-endian u64, lamports

// pump.fun bonding curve account: virtual_token, virtual_sol, real_token,
// real_sol, total_supply as little-endian u64 after the 8-byte
// discriminator (read for the curve's non-reserve lamports; not used as a
// mid).
const pumpCurveFieldsAt = 8

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}
