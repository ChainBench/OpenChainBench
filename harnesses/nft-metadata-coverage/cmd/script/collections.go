package main

// NFTCollection is a single Ethereum blue-chip target with its provider keys.
// `OpenSeaSlug` is a hint: at startup we resolve it LIVE via the OpenSea
// /chain/ethereum/contract endpoint and overwrite the field. The seed value
// only exists so the smoke run has something to hit if the resolve call fails.
type NFTCollection struct {
	Name        string // display name used in logs
	Contract    string // ERC-721/1155 contract address, mixed case ok
	OpenSeaSlug string // canonical slug (overwritten by live resolve)
}

// The first 10 entries are the ones explicitly validated apple-to-apple in
// /tmp/nft-validation/REPORT.md. The remainder are well-established Ethereum
// collections selected for stability (multi-year-old, indexed by every
// provider). Slugs are seeds; runtime always re-resolves via OpenSea.
var COLLECTIONS = []NFTCollection{
	// Validated set
	{"CryptoPunks", "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB", "cryptopunks"},
	{"BAYC", "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", "boredapeyachtclub"},
	{"MAYC", "0x60E4d786628Fea6478F785A6d7e704777c86a7c6", "mutant-ape-yacht-club"},
	{"Pudgy Penguins", "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8", "pudgypenguins"},
	{"Doodles", "0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e", "doodles-official"},
	{"Azuki", "0xED5AF388653567Af2F388E6224dC7C4b3241C544", "azuki"},
	{"CloneX", "0x49cF6f5d44E70224e2E23fDcdd2C053F30aDA28B", "clonex"},
	{"Milady", "0x5Af0D9827E0c53E4799BB226655A1de152A425a5", "milady"},
	{"Moonbirds", "0x23581767a106ae21c074b2276D25e5C3e136a68b", "proof-moonbirds"},
	{"Cool Cats", "0x1A92f7381B9F03921564a437210bB9396471050C", "cool-cats-nft"},

	// Extended set (40 more, blue-chip ETH collections)
	{"World of Women", "0xe785E82358879F061BC3dcAC6f0444462D4b5330", "world-of-women-nft"},
	{"BAKC", "0xba30E5F9Bb24caa003E9f2f0497Ad287FDF95623", "bored-ape-kennel-club"},
	{"Otherdeed", "0x34d85c9CDeB23FA97cb08333b511ac86E1C4E258", "otherdeed"},
	{"CrypToadz", "0x1CB1A5e65610AEFF2551A50f76a87a7d3fB649C6", "cryptoadz-by-gremplin"},
	{"VeeFriends", "0xa3AEe8BcE55BEeA1951EF834b99f3Ac60d1ABeeB", "veefriends"},
	{"Meebits", "0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7", "meebits"},
	{"CyberKongz", "0x57a204AA1042f6E66DD7730813f4024114d74f37", "cyberkongz"},
	{"Mfers", "0x79FCDEF22feeD20eDDacbB2587640e45491b757f", "mfers"},
	{"Renga", "0x394E3d3044fC89fCDd966D3cb35Ac0B32B0Cda91", "renga"},
	{"Nakamigos", "0xd774557b647330C91Bf44cfEAB205095f7E6c367", "nakamigos"},
	{"Goblintown", "0xbCe3781ae7Ca1a5e050Bd9C4c77369867eBc307e", "goblintownwtf"},
	{"DeGods", "0x8821BeE2ba0dF28761AffF119D66390D594CD280", "degods"},
	{"Beanz", "0x306b1ea3ecdf94aB739F1910bbda052Ed4A9f949", "beanzofficial"},
	{"Lazy Lions", "0x8943C7bAC1914C9A7ABa750Bf2B6B09Fd21037E0", "lazy-lions"},
	{"Invisible Friends", "0x59468516a8259058baD1cA5F8f4BFF190d30E066", "invisiblefriends"},
	{"KILLABEARS", "0xC99c679C50033Bbc5321EB88752E89a93e9e83C5", "killabears"},
	{"Memeland Captainz", "0x769272677faB02575E84945F03Eca517ACc544Cc", "the-captainz"},
	{"Memeland Potatoz", "0x39ee2c7b3cb80254225884ca001F57118C8f21B6", "thepotatoz"},
	{"Pixelmon", "0x32973908FaeE0Bf825A343000fE412ebE56F802A", "pixelmon"},
	{"Sewer Pass", "0x764AeebcF425d56800eF2c84F2578689415a2DAa", "sewerpass"},
	{"Otherside Vessel", "0x5b1085136a811e55b2Bb2CA1eA456bA82126A376", "otherside-vessels"},
	{"Murakami Flowers", "0x7D8820FA92EB1584636f4F5b8515B5476B75171a", "murakami-flowers-2022-official"},
	{"Boss Beauties", "0xb5C747561a185A146f83cFff25BdfD2455b31fF4", "boss-beauties"},
	{"CryptoDickbutts", "0x42069ABFE407C60cf4ae4112bEDEaD391dBa1cdB", "cryptodickbutts-s3"},
	{"Chromie Squiggle", "0x059EDD72Cd353dF5106D2B9cC5ab83a52287aC3a", "chromie-squiggle-by-snowfro"},
	{"Otherside Koda", "0xe012Baf811CF9c05c408e879C399960D1f305903", "kodas"},
	{"Mocaverse", "0x59325733eb952a92e069C87F0A6168b29E80627f", "mocaverse"},
	{"Wrapped CryptoPunks", "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6", "wrapped-cryptopunks"},
	{"Cool Pets", "0x86C10D10ECa1Fca9DAF87a279abCcABe0063F247", "cool-pets-nft"},
	{"My Pet Hooligan", "0x09233d553058c2F42ba751C87816a8E9FaE7Ef10", "mypethooligan"},
	{"Bored Ape Chemistry Club", "0x22C36BfdCef207F9c0CC941936eff94D4246d14A", "bored-ape-chemistry-club"},
	{"Loot", "0xFF9C1b15B16263C61d017ee9F65C50e4AE0113D7", "lootproject"},
	{"Parallel Alpha", "0x76BE3b62873462d2142405439777e971754E8E77", "parallelalpha"},
	{"NeoTokyo Outer Identities", "0x86357A19E5537A8Fba9A004E555713BC943a66C0", "neo-tokyo-outers"},
	{"Moonrunners", "0x1485297e942ce64E0870EcE60179dFda34b4C625", "moonrunnersofficial"},
	{"Wassies by Wassies", "0x9d418c2cae665d877f909a725402ebd3a0742844", "wassiesbywassies"},
	{"On1 Force", "0x3bf2922f4520a8BA0c2eFC3D2a1539678DaD5e9D", "0n1-force"},
	{"Crypto Coven", "0x5180db8F5c931aaE63c74266b211F580155ecac8", "cryptocoven"},
	{"Zen Academy", "0xF64E6E64ddE3B221C8F5be7B23E2832A1Db7e6e8", "zen-academy"},
	{"Adidas Originals", "0x28472a58A490c5e09A238847F66A68a47cC76f0f", "adidasoriginals"},
}

// activeCollections returns the slice to probe this cycle. Smoke mode
// always trims to the 10 hardcoded validated entries so a local run
// finishes in <1 minute. Otherwise the COLLECTIONS_MODE env var picks
// between the static blue-chip list (default, stable) and a dynamic
// top-N from on-chain mint events over the last ~10k transfers (no
// curated list, refreshes every cycle). Discovery has its own fallback
// to the static list if the RPC call fails, so this function is
// guaranteed to return ≥1 entry.
func activeCollections(smoke bool) []NFTCollection {
	if smoke {
		return COLLECTIONS[:10]
	}
	if cfgCollectionsMode == "dynamic" {
		return discoverTopMintedCollections(cfgDiscoveryRPCURL)
	}
	return COLLECTIONS
}
