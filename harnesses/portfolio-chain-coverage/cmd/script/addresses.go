package main

// chainProbe is one non-EVM probe target: a public high-balance
// address on one chain, identified by the CoinStats connectionId
// (the most granular chain key any cohort vendor exposes). Providers
// that take raw addresses (Mobula) consume the same addresses after
// deduplication, so the shared-address fairness rule holds: every
// provider gets the identical set and the identical $1 threshold.
//
// Address sourcing rule: public, stable, high-balance addresses only.
// exchange cold wallets, protocol treasuries, Cosmos community-pool
// module accounts, or explorer rich-list heads. Each one was
// validated live against the CoinStats balance endpoint on 2026-07-06
// (every entry returned > $1). A vendor dropping a chain or an
// address draining shows up as a verified-count dip the next cycle,
// never as an error.
//
// EVM chains are NOT listed here: one shared EVM address covers every
// EVM chain in a single sweep call per vendor (networks=all /
// fetchAllChains), see evmTestAddress.
type chainProbe struct {
	// connectionID is the CoinStats chain key for this probe.
	connectionID string
	// addr is the public test address in the chain's native format.
	addr string
}

var chainProbes = []chainProbe{
	// Originals (kept first: they anchor day-one comparability).
	{"solana", solTestAddress},
	{"bitcoin", btcTestAddress},

	// UTXO / payment chains. explorer rich-list heads, mostly
	// exchange cold wallets.
	{"doge-wallet", "DE5opaXjFgDhFBqL6tBDxTAQ56zkX6EToX"},
	{"litecoin", "MQd1fJwqBJvwLuyhr17PhEFx1swiqDbPQS"},
	{"bitcoin_cash", "bitcoincash:qrmfkegyf83zh5kauzwgygf82sdahd5a55x9wse7ve"},
	{"bitcoin_sv", "1A6ud3LrKkPqkwrbGmxu84YTsaJX51SmW"},
	{"dash", "XnT33zjrFKjt3ymfyQZs2FPiKNer3WVj14"},
	{"digibyte", "dgb1qnjf7e2a5ezft480kxzmhgg66pnzqk0aawxa06u"},
	{"zcash-wallet", "t1RyCw14wRXrh3mp21uxgr9ynjem7cNUkMH"},
	{"kaspa-wallet", "kaspa:qpzpfwcsqsxhxwup26r55fd0ghqlhyugz8cp6y3wxuddc02vcxtjg75pspnwz"},
	{"ethereum_classic", "0x13CDee29cAd8e11523095900e2195088Ed6d02Ad"},

	// Major L1s. exchange cold wallets, treasuries, rich-list heads.
	{"xrp", "rhQADfs6UxfP7iUPwsU7b3uwDVQLLgFcu8"},
	{"cardano", "addr1q8elqhkuvtyelgcedpup58r893awhg3l87a4rz5d5acatuj9y84nruafrmta2rewd5l46g8zxy4l49ly8kye79ddr3ksqal35g"},
	{"tron", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR"},
	{"stellar", "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6"},
	{"polkadot", "13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB"},
	{"kusama-wallet", "F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29"},
	{"near-wallet", "astro-stakers.poolv1.near"},
	{"algorand", "N2C374IRX7HEX2YEQWJBTRSVRHRUV4ZSF76S54WV4COTHRUNYRCI47R3WU"},
	{"tezos", "tz1gNjyzyT8L6WgNS4AdNMppsSFw76J4aDvT"},
	{"vechain", "0xa4aDAfAef9Ec07BC4Dc6De146934C7119341eE25"},
	{"eos", "kjhbgvcfghfd"},
	{"waves", "3P31zvGdh6ai6JK6zZ18TjYzJsa1B83YPoj"},
	{"ontology", "AFmseVrdL9f9oyCzZefL9tG6UbviEH9ugK"},
	{"neo", "NVg7LjGcUSrgxgjX3zEgqaksfMaiS8Z6e1"},
	{"zilliqa", "zil1xq6mh35lgr646hux0ys96q0f0hqv3hex80trpf"},
	{"iota", "0xeb8bc8b275fbc66500255f06de458ec5b6623b4171b17d8a26a47604860b3885"},
	{"elrond-wallet", "erd1rf4hv70arudgzus0ymnnsnc4pml0jkywg2xjvzslg0mz4nn2tg7q7k0t6p"},
	{"internet-computer-wallet", "609d3e1e45103a82adc97d4f88c51f78dedb25701e8e51e8c4fec53448aadc29"},
	{"hedera-wallet", "0.0.2"},
	{"stacks-wallet", "SP2XXSW2KPPTY7KJDYS9RQ868D7JH58QSZKK8KXAV"},
	{"xdc-wallet", "0x377b8ce04761754e8ac153b47805a9cf6b190873"},

	// Cosmos ecosystem. each chain's distribution/community-pool or
	// reserve module account: deterministic, public, only moves via
	// governance, the most drain-resistant addresses available.
	{"cosmos", "cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl"},
	{"osmosis-wallet", "osmo1jv65s3grqf6v6jl3dp4t6c9t9rk99cd80yhvld"},
	{"juno-wallet", "juno1jv65s3grqf6v6jl3dp4t6c9t9rk99cd83d88wr"},
	{"injective-wallet", "inj1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8dkncm8"},
	{"celestia-wallet", "celestia1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8k44vnj"},
	{"sei-wallet", "sei1jv65s3grqf6v6jl3dp4t6c9t9rk99cd82n4207"},
	{"kujira-wallet", "kujira1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8khxyy4"},
	{"akash-wallet", "akash1jv65s3grqf6v6jl3dp4t6c9t9rk99cd82yfms9"},
	{"dymension-wallet", "dym1jv65s3grqf6v6jl3dp4t6c9t9rk99cd84zg6v3"},
	{"dydx-wallet", "dydx1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8wx2cfg"},
	{"kava-cosmos-wallet", "kava1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8m2splc"},
	{"fetch-wallet", "fetch1jv65s3grqf6v6jl3dp4t6c9t9rk99cd85zdctg"},
	{"axelar-wallet", "axelar1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8r3j5z7"},
	{"stride-wallet", "stride1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8y5yqan"},
	{"thorchain-wallet", "thor1dheycdevq39qlkxs2a6wuuzyn4aqxhve4qxtxt"},
	{"band_protocol", "band1jv65s3grqf6v6jl3dp4t6c9t9rk99cd87sy73h"},
	{"secret-wallet", "secret1jv65s3grqf6v6jl3dp4t6c9t9rk99cd896s45r"},
	{"mantra-wallet", "mantra1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8v5wc29"},
	{"terra-wallet", "terra1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8pm7utl"},
	{"terra-wallet-2", "terra1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8pm7utl"},
	{"cronos-cosmos-wallet", "cro1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8lyv94w"},
	{"initia-wallet", "init1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3mdfuj4"},
	{"babylon-wallet", "bbn1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3z9c7xw"},
	{"zigchain-wallet", "zig1fl48vsnmsdzcv85q5d2q4z5ajdha8yu353vaml"},

	// Newer non-EVM L1/L2s.
	{"aptos-wallet", "0x6dd484cf0a72f61d2cb7cd0530633f8e1fe05dcb69b4c29dd0257d3d2639377d"},
	{"sui-wallet", "0x15610fa7ee546b96cb580be4060fae1c4bb15eca87f9a0aa931512bad445fc76"},
	{"ton-wallet", "EQDKHZ7e70CzqdvZCC83Z4WVR8POC_ZB0J1Y4zo88G-zCXmC"},
	{"starknet-wallet", "0x01176a1bd84444c89232ec27754698e5d2e7e1a7f1539f12027f28b23ec9f3d8"},
	{"eclipse-wallet", "3KK8L7UYd7NV575w9vWR2o1kNqdSFvEPUwcTA5353cax"},
	{"fio-wallet", "FIO5Y3LfvVz3uoKNFHWwuQ8SoENTHT8ZhruQeqr1nnhYhJX1wqikv"},
	{"aleo-wallet", "aleo1tj0598jpstejk8yp7cldez3y4vekmzv482h8l6v59yqsw9kk6cxsc79p0f"},
	{"supra-wallet", "0xd5699357c9e930472375d2709d4a9bae592ce7b0e1a05ba924bbde276f9db3bc"},
	{"minima-wallet", "MxG087AH0HPWAYJPQTQGYEMG03F1K2R1H43HVWYH19NB0RTW3SZWY7Q2F79810N"},
}

// uniqueProbeAddresses returns the deduplicated address list for
// providers that take raw wallet addresses instead of chain keys
// (same address can back several connectionIds, e.g. Terra 1/2).
func uniqueProbeAddresses() []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(chainProbes))
	for _, p := range chainProbes {
		if seen[p.addr] {
			continue
		}
		seen[p.addr] = true
		out = append(out, p.addr)
	}
	return out
}
