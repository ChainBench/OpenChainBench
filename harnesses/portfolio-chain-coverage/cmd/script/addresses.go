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
// EVM MAJORS are not listed here: one shared EVM address covers them
// in a single sweep call per vendor (networks=all / fetchAllChains),
// see evmTestAddress. EVM LONG-TAIL chains where that shared address
// holds no balance DO get their own funded entry below, so the sweep
// blind spot stays testable. The harness reconciles the two paths via
// the vendor's connectionId -> chain map so nothing counts twice.
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
	{"bittensor-wallet", "5Hd2ze5ug8n1bo3UCAcQsf66VNjKqGos8u6apNfzcU86pg4N"},
	{"casper-wallet", "011c74ebfcc1b19bc3e578bec3ecfa2d484f2a00d7e9e8152c4c70f519f6a89f6a"},
	{"acala-wallet", "23M5ttkmR6Kco7bReRDve6bQUSAcwqebatp3fWGJYb4hDSDJ"},

	// EVM long-tail: the shared EVM sweep address holds no balance on
	// these chains, so each gets its own funded public address
	// (explorer rich-list heads, labeled exchange wallets, canonical
	// bridge/treasury holders). Validated live on 2026-07-06.
	{"celo-wallet", "0xA5c453BC33FD9C5C798Ac24F666fa2B49E0a87fe"},
	{"boba-wallet", "0x2d02ce7eF2f359bdcF86E44f66345660725e5CcE"},
	{"okx-wallet", "0x8F8526dbfd6E38E3D8307702cA8469Bae6C56C15"},
	{"harmony-wallet", "0x0D0707963952f2fBA59dD06f2b425ace40b492Fe"},
	{"aurora-wallet", "0xb0bD02F6a392aF548bDf1CfAeE5dFa0EefcC8EaB"},
	{"canto-wallet", "0x0D0707963952f2fBA59dD06f2b425ace40b492Fe"},
	{"zkevm-polygon-wallet", "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe"},
	{"arbitrum-nova-wallet", "0xf89d7b9c864f589bbF53a82105107622B35EaA40"},
	{"pulsechain-wallet", "0xbE740c0c8b3C13b2B1Af763aC17a83797A948fe4"},
	{"zora-wallet", "0x82E51a8304156F96C6f01e4aE3C2554D0dE5d156"},
	{"immutable-wallet", "0xb4C16FdC1963eDD6A91B580d27B520bd20AB85e0"},
	{"rootstock-wallet", "0x0000000000000000000000000000000001000006"},
	{"mode-wallet", "0x82E51a8304156F96C6f01e4aE3C2554D0dE5d156"},
	{"karak-wallet", "0x4200000000000000000000000000000000000016"},
	{"ink-wallet", "0x26317C59a67C289D38CC0FE9259d3C2a2784b9D8"},
	{"bob-wallet", "0x4C18e3a2e35Ad4f324ecD34C88074271D0643edf"},
	{"taiko-wallet", "0x1670000000000000000000000000000000000001"},
	{"bitlayer-wallet", "0xfF204e2681A6fA0e2C3FaDe68a1B28fb90E4Fc5F"},
	{"bsquared-wallet", "0xD0eC0DCCcbe38A5ABFD166d67e30D0880039Aa29"},
	{"ailayer-wallet", "0x80931F1fD3E542A819c91E1696c8662171eA4A5A"},
	{"soneium-wallet", "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590"},
	{"abstract-wallet", "0xc882b111a75c0c657fc507c04fbfcd2cc984f071"},
	{"unichain-wallet", "0x1F98400000000000000000000000000000000004"},
	{"hyperevm-wallet", "0x2222222222222222222222222222222222222222"},
	{"zetachain-wallet", "0x4feA76427B8345861e80A3540a8a9D936FD39391"},
	{"meter-wallet", "0x0d0707963952f2fba59dd06f2b425ace40b492Fe"},
	{"zircuit-wallet", "0x4200000000000000000000000000000000000006"},
	{"story-wallet", "0x91c7FdA5E6b0af14bB007D9F02E4d5E3902CeCc9"},
	{"orderly-wallet", "0x89E2Fa90350DA66dF92c9Fc02Ad33409a1017886"},
	{"monad-wallet", "0x14c25602353402d0be03b386a9aa3f107dd7e34c"},
	{"megaeth-wallet", "0xE71CbF47Fff309813bcea54f3ecF49a5F129264D"},
	{"flare-wallet", "0x67FC6287f627614dc8dB353B331f9740955EC5d2"},
	{"blast-wallet", "0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23"},
	{"kava-wallet", "0x24A4Fbb1fCe9b981cBfCeabD72AA6B2CD3E53CF5"},
	{"beam-wallet", "0x0DC874Fb5260Bd8749e6e98fd95d161b7605774D"},
	{"ape-wallet", "0x5228d45b7f99839f3d7087649bb167089a099422"},
	{"katana-wallet", "0xbE818E593E8B961c466523E8C1B7D3111B87Cca2"},
	{"ronin-wallet", "0xb32e9A84Ae0B55b8ab715e4Ac793a61B277bAFA3"},

	// Known-failing probes, kept DELIBERATELY: the address holds a
	// large balance per the chain's own explorer, yet the vendor's
	// probe returns empty. They count in probed but not verified,
	// which is exactly the indexer gap this bench exists to surface.
	{"degen-wallet", "0xa3491e7361abAA631ab84Ee34d535CD9A0adE66F"},
	{"pepecoin-wallet", "PeU3PGXMGcFcteA4NjDcQsTiKQBdn7if84"},
}

// Chains with NO probe entry and why (audited 2026-07-06): heco,
// redstone, nillion, duckchain (chains dead or explorer gone), evmos
// x2 (chain ceased operations 2025), celsius (defunct custodian),
// bnb_beacon (chain sunset), liquid (confidential balances, no rich
// list exists), robinhood (no public mainnet explorer yet),
// xrpl-wallet / filecoin-wallet (every candidate address format,
// including the vendor's own 0x form for Filecoin FEVM, got a 400
// from the probe endpoint; excluded rather than counted as vendor
// failures because the rejection may be on our side). Acala joined
// the set once the ss58 treasury address format proved accepted.

// evmProbeAddresses returns the deduplicated 20-byte 0x addresses
// from the probe set (EVM long-tail funded wallets). Zerion's wallet
// endpoint only accepts EVM addresses, one per call, so this is the
// slice of the shared set it can fairly receive. 66-char 0x entries
// (Aptos, Sui, Starknet, IOTA, Supra) are excluded: wrong address
// space.
func evmProbeAddresses() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, p := range chainProbes {
		a := p.addr
		if len(a) != 42 || a[:2] != "0x" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	return out
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
