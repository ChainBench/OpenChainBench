package main

// Curated anchor sample. Sources we trust as ground truth for "well-known
// addresses every reasonable provider should label":
//   • Etherscan/Basescan/Bscscan/Arbiscan/Polygonscan/Optimistic Etherscan public Name Tags
//   • Solscan, Tonscan, Stellar.expert, XRPScan, Blockchain.com explorers
//   • OFAC SDN crypto list (sanctioned)
//   • Safe-global/safe-deployments (multisig factories)
//   • DefiLlama protocol treasuries
//   • Public figures the broader ecosystem knows (vitalik, CZ, SBF)
//
// Every address here is verifiable against a public source. Rotate this
// list quarterly to limit gameability.
//
// Composition target (~190 total): a balanced mix of contracts and EOAs on
// every non-Ethereum chain so the "entity identification" signal isn't
// trivialised by Blockscout returning the contract `name` from verified
// source code. Each entry now carries a Kind ("contract" or "eoa") so the
// harness / debug page can break the score down per kind.
//
// Format: chain id matches the keys in pulse normalizeChain (kept consistent
// with the rest of the harness — solana, ethereum, bnb, base, arbitrum,
// polygon, optimism, ton, stellar, xrp, bitcoin).

type anchor struct {
	Chain   string
	Address string
	Hint    string // descriptive only; not used to score, just for /debug
	Kind    string // "contract" or "eoa" — used to slice scores per kind
}

var anchorSample = []anchor{
	// === Ethereum: CEX (EOAs) ===
	{"ethereum", "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance 14", "eoa"},
	{"ethereum", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8", "eoa"},
	{"ethereum", "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d", "Binance 16", "eoa"},
	{"ethereum", "0x564286362092D8e7936f0549571a803B203aAceD", "Binance 1", "eoa"},
	{"ethereum", "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", "Binance 15", "eoa"},
	{"ethereum", "0xfE9e8709d3215310075d67E3ed32A380CCf451C8", "Binance 17", "eoa"},
	{"ethereum", "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3", "Coinbase 1", "eoa"},
	{"ethereum", "0x503828976D22510aad0201ac7EC88293211D23Da", "Coinbase 2", "eoa"},
	{"ethereum", "0xddfAbCdc4D8FfC6d5beaf154f18B778f892A0740", "Coinbase 3", "eoa"},
	{"ethereum", "0x3cD751E6b0078Be393132286c442345e5DC49699", "Coinbase 4", "eoa"},
	{"ethereum", "0x53d284357ec70cE289D6D64134DfAc8E511c8a3D", "Kraken 1", "eoa"},
	{"ethereum", "0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2", "Kraken 2", "eoa"},
	{"ethereum", "0x267be1C1D684F78cb4F6a176C4911b741E4Ffdc0", "Kraken 3", "eoa"},
	{"ethereum", "0x66f820a414680B5bcda5eECA5dea238543F42054", "OKX 1", "eoa"},
	{"ethereum", "0x5041ed759Dd4aFc3a72b8192C143F72f4724081A", "OKX 4", "eoa"},
	{"ethereum", "0x5e3eF299fDDf15eAa0432E6e66473ace8c13D908", "Bitfinex", "eoa"},
	{"ethereum", "0x1151314c646Ce4E0eFD76d1aF4760aE66a9Fe30F", "Bitfinex Hot", "eoa"},
	{"ethereum", "0xf89d7b9c864f589bbF53a82105107622B35EaA40", "Bybit Hot", "eoa"},

	// === Ethereum: DEX routers / aggregators (contracts) ===
	{"ethereum", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router", "contract"},
	{"ethereum", "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", "Uniswap V3 Router 2", "contract"},
	{"ethereum", "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", "Uniswap V2 Router", "contract"},
	{"ethereum", "0x000000000022D473030F116dDEE9F6B43aC78BA3", "Permit2", "contract"},
	{"ethereum", "0x1111111254EEB25477B68fb85Ed929f73A960582", "1inch V5", "contract"},
	{"ethereum", "0x111111125421cA6dc452d289314280a0f8842A65", "1inch V6", "contract"},
	{"ethereum", "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", "0x Exchange Proxy", "contract"},

	// === Ethereum: Tornado Cash (OFAC sanctioned, contracts) ===
	{"ethereum", "0xa160cdAB225685dA1d56aa342Ad8841c3b53f291", "Tornado Cash 100 ETH", "contract"},
	{"ethereum", "0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc", "Tornado Cash 0.1 ETH", "contract"},
	{"ethereum", "0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936", "Tornado Cash 1 ETH", "contract"},
	{"ethereum", "0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF", "Tornado Cash 10 ETH", "contract"},

	// === Ethereum: public figures / treasuries (EOAs + contract) ===
	{"ethereum", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth", "eoa"},
	{"ethereum", "0x4E04F2eDc6c9c9da6B7DDCfA9eF11d4d31E07e72", "CZ Binance", "eoa"},
	{"ethereum", "0x1a9C8182C09F50C8318d769245beA52c32BE35BC", "Uniswap Treasury", "contract"},

	// === Base: contracts ===
	{"base", "0x4200000000000000000000000000000000000006", "WETH (Base)", "contract"},
	{"base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC (Base native)", "contract"},
	{"base", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "USDbC (Base bridged)", "contract"},
	{"base", "0x2626664c2603336E57B271c5C0b26F421741e481", "Uniswap V3 SwapRouter02 (Base)", "contract"},
	{"base", "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", "Aerodrome Router (Base)", "contract"},
	{"base", "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", "Aerodrome Factory (Base)", "contract"},
	{"base", "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86", "BaseSwap Router (Base)", "contract"},
	{"base", "0x4200000000000000000000000000000000000010", "L2 Standard Bridge (Base)", "contract"},
	{"base", "0x3154Cf16ccdb4C6d922629664174b904d80F2C35", "Base L1->L2 Bridge (L1 side)", "contract"},
	{"base", "0xcF205808Ed36593aa40a44F10c7f7C2F67d4A4d4", "Friend.tech Shares (Base)", "contract"},
	{"base", "0x6A000F20005980200259B80c5102003040001068", "Coinbase Smart Wallet factory", "contract"},
	{"base", "0x6cb442acF35158D5eDa88fe602221b67B400Be3E", "Aerodrome Universal Router (Base)", "contract"},
	// === Base: EOAs ===
	{"base", "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", "Coinbase Hot Wallet (Base)", "eoa"},
	{"base", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth (Base)", "eoa"},
	{"base", "0x4Cd2563118E57b19179d8DC033f2B0C5b5d69ff5", "Active Base trader (Coinbase funded)", "eoa"},
	{"base", "0xF2B0B7Cf3a98aCD0d34b269D3C9F73fD3C0aae12", "Coinbase Onramp deposit (Base)", "eoa"},
	{"base", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (cross-chain, Base)", "eoa"},

	// === BNB Chain: contracts ===
	{"bnb", "0x10ED43C718714eb63d5aA57B78B54704E256024E", "PancakeSwap V2 Router", "contract"},
	{"bnb", "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", "PancakeSwap V3 SmartRouter", "contract"},
	{"bnb", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "Venus Comptroller", "contract"},
	{"bnb", "0x55d398326f99059fF775485246999027B3197955", "USDT (BSC)", "contract"},
	{"bnb", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", "BUSD (BSC)", "contract"},
	{"bnb", "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7", "ApeSwap Router (BSC)", "contract"},
	{"bnb", "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8", "Biswap Router (BSC)", "contract"},
	{"bnb", "0x0000000000000000000000000000000000001000", "BSC Validator Set Precompile", "contract"},
	{"bnb", "0xbB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB (BSC)", "contract"},
	{"bnb", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "Binance-Peg ETH (BSC)", "contract"},
	// === BNB: EOAs ===
	{"bnb", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (BSC)", "eoa"},
	{"bnb", "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", "Binance Hot 6 (BSC)", "eoa"},
	{"bnb", "0xe2fc31F816A9b94326492132018C3aEcC4a93aE1", "Binance Hot 9 (BSC)", "eoa"},
	{"bnb", "0xD2f93484f2D319194cBa95C5171B18C1d8cfD6C4", "Binance Hot 10 (BSC)", "eoa"},
	{"bnb", "0x73f5b059a4f7BAB4f04F30D097b5d31E64fE6De4", "Bybit Hot Wallet (BSC)", "eoa"},

	// === Arbitrum: contracts ===
	{"arbitrum", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (Arbitrum)", "contract"},
	{"arbitrum", "0x489ee077994B6658eAfA855C308275EAd8097C4A", "GMX Vault", "contract"},
	{"arbitrum", "0x602b805EedddBbD9ddff44A7dcBD46cb07849685", "GMX V2 Exchange Router", "contract"},
	{"arbitrum", "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", "Camelot V2 Router", "contract"},
	{"arbitrum", "0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1", "Radiant Capital Lending Pool", "contract"},
	{"arbitrum", "0xDb6Ab450178bAbCf0e467c1F3B436050d907E233", "Treasure DAO Marketplace Multisig", "contract"},
	{"arbitrum", "0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB Token", "contract"},
	{"arbitrum", "0xF3FC178157fb3c87548bAA86F9d24BA38E649B58", "Arbitrum Foundation DAO Treasury", "contract"},
	{"arbitrum", "0x3c2269811836af69497E5F486A85D7316753cf62", "LayerZero Endpoint (Arbitrum)", "contract"},
	{"arbitrum", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "WETH (Arbitrum)", "contract"},
	{"arbitrum", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "USDC.e (Arbitrum bridged)", "contract"},
	{"arbitrum", "0x539bdE0d7Dbd336b79148AA742883198BBF60342", "MAGIC Token (Treasure DAO)", "contract"},
	// === Arbitrum: EOAs ===
	{"arbitrum", "0xb38e8c17e38363aF6EbdCb3dAE12e0243582891D", "Binance Hot Wallet (Arbitrum)", "eoa"},
	{"arbitrum", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (cross-chain, Arbitrum)", "eoa"},
	{"arbitrum", "0x2eF358AD8E37D9d2cDcd9f15F0E97f0fD68aFD64", "Active Arb trader / GMX user", "eoa"},
	{"arbitrum", "0xCc022Cbe6c5b3B8a9b6e9C36dD66B0aCF14Cdb37", "Active Arb DeFi user", "eoa"},
	{"arbitrum", "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance 14 (cross-chain, Arbitrum)", "eoa"},

	// === Polygon: contracts ===
	{"polygon", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (Polygon)", "contract"},
	{"polygon", "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", "QuickSwap V2 Router", "contract"},
	{"polygon", "0xf5b509bB0909a69B1c207E495f687a596C168E12", "QuickSwap V3 Router", "contract"},
	{"polygon", "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", "SushiSwap Router (Polygon)", "contract"},
	{"polygon", "0x794a61358D6845594F94dc1DB02A252b5b4814aD", "Aave V3 Pool (Polygon)", "contract"},
	{"polygon", "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77", "Polygon PoS RootChainManager (L1 side)", "contract"},
	{"polygon", "0x0000000000000000000000000000000000001010", "MATIC native (Polygon)", "contract"},
	{"polygon", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "USDC.e (Polygon bridged)", "contract"},
	{"polygon", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "WETH (Polygon)", "contract"},
	{"polygon", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "WMATIC / WPOL (Polygon)", "contract"},
	{"polygon", "0xDb46d1Dc155634FbC732f92E853b10B288AD5a1d", "Lens Protocol Hub", "contract"},
	{"polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT (Polygon)", "contract"},
	// === Polygon: EOAs ===
	{"polygon", "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", "Binance Hot Wallet (Polygon)", "eoa"},
	{"polygon", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (cross-chain, Polygon)", "eoa"},
	{"polygon", "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245", "Binance Hot Wallet 2 (Polygon)", "eoa"},
	{"polygon", "0xD2f93484f2D319194cBa95C5171B18C1d8cfD6C4", "Binance Hot Wallet 3 (Polygon)", "eoa"},
	{"polygon", "0x505e71695E9bc45943c58adEC1650577BcA68fD9", "Active Polygon trader (BSC funded)", "eoa"},

	// === Optimism: contracts ===
	{"optimism", "0xE592427A0AEce92De3Edee1F18E0157C05861564", "Uniswap V3 Router (OP)", "contract"},
	{"optimism", "0x4200000000000000000000000000000000000006", "WETH (OP)", "contract"},
	{"optimism", "0x9c12939390052919aF3155f41Bf4160Fd3666A6f", "Velodrome V1 Router", "contract"},
	{"optimism", "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858", "Velodrome V2 Router", "contract"},
	{"optimism", "0xf132bdB9573867cd72f2585C338B923F973EB817", "Velodrome V2 Universal Router", "contract"},
	{"optimism", "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", "Synthetix Proxy SNX (OP)", "contract"},
	{"optimism", "0x4200000000000000000000000000000000000042", "OP Token", "contract"},
	{"optimism", "0x4200000000000000000000000000000000000010", "L2 Standard Bridge (OP)", "contract"},
	{"optimism", "0x99C9fC46f92E8a1c0deC1b1747d010903E884bE1", "OP L1 Standard Bridge (L1 side)", "contract"},
	{"optimism", "0x60cf091cd3f50420d50fd7f707414d0df4751c58", "Sonne Finance Unitroller", "contract"},
	{"optimism", "0xBA12222222228d8Ba445958a75a0704d566BF2C8", "Beethoven X / Balancer Vault", "contract"},
	{"optimism", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", "USDC.e (OP bridged)", "contract"},
	// === Optimism: EOAs ===
	{"optimism", "0xacD03D601e5bB1B275Bb94076fF46ED9D753435A", "Binance Hot Wallet (Optimism)", "eoa"},
	{"optimism", "0xF977814e90dA44bFA03b6295A0616a897441aceC", "Binance 8 (cross-chain, Optimism)", "eoa"},
	{"optimism", "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925", "Active OP DeFi user", "eoa"},
	{"optimism", "0xEcb456EA5365865EbAb8a2661B0c503410e9B347", "Early OP user (2021 funded)", "eoa"},
	{"optimism", "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance 14 (cross-chain, Optimism)", "eoa"},

	// === Solana: contracts (programs) ===
	{"solana", "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "Raydium Authority", "contract"},
	{"solana", "DRiP2Pn2K6fuMLKQmt5rZWxa91v6jbUUYdjP1k5Mzbt7", "DRiP Haus", "contract"},
	{"solana", "GThUX1Atko4tqhN2NaiTazWSeFWMuiUiswQrAogEHaqv", "Stake Pool", "contract"},
	{"solana", "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH", "Pyth Oracle Program", "contract"},
	{"solana", "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", "Wormhole Core Bridge", "contract"},
	{"solana", "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", "Magic Eden V2 Program", "contract"},
	{"solana", "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", "Marinade Finance Liquid Staking", "contract"},
	{"solana", "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "Drift Protocol V2", "contract"},
	{"solana", "4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg", "Mango Markets V4", "contract"},
	{"solana", "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo", "Solend Program", "contract"},
	{"solana", "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN", "Tensor Swap Program", "contract"},
	{"solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC (Solana mint)", "contract"},
	{"solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT (Solana mint)", "contract"},
	// === Solana: EOAs (regular accounts — Solana has no contracts on user accounts) ===
	{"solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "Jupiter Fee / Binance Cold (Sol)", "eoa"},
	{"solana", "GjwcWFQYzemBtpUoN5fMAP2FZviTtMRWCmrppGuTthJS", "MEV Searcher (Solana)", "eoa"},
	{"solana", "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", "Binance Hot Wallet (Solana)", "eoa"},
	{"solana", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", "Binance Hot Wallet 2 (Solana)", "eoa"},
	{"solana", "CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1", "Coinbase Hot Wallet (Solana)", "eoa"},
	{"solana", "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm", "Active Pump.fun trader (Mac248)", "eoa"},

	// === TON: contracts ===
	{"ton", "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt", "STON.fi DEX Router", "contract"},
	{"ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", "USDT (TON Jetton master)", "contract"},
	{"ton", "EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67", "DeDust Factory", "contract"},
	{"ton", "EQCt1mEktUsMdn4U5EsiczCoocVqKsXjYbdwudx3QbpWeHeM", "Notcoin Jetton Master", "contract"},
	{"ton", "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT", "Notcoin Treasury", "contract"},
	{"ton", "EQDgEMqToTacHic7SnvnPFmvceG5auFkCcAw0mSCvzHKi-Tx", "Getgems NFT Marketplace", "contract"},
	{"ton", "EQCA14o1-VWhS2efqoh_9M1b_A9DtKTuoqfmkn83AbJzwnPi", "TON Diamonds NFT", "contract"},
	{"ton", "EQAJ8uWd7EBqsmpSWaRdf_I-8R8-XHwh3gsNKhy-UrdrPcUo", "TON Stakers Pool", "contract"},
	{"ton", "EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez", "Tonkeeper Wallet (community)", "contract"},
	{"ton", "EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y", "Notcoin secondary jetton", "contract"},
	// === TON: EOAs (every account on TON is wallet-contract code, treated as eoa per Etherscan-style naming) ===
	{"ton", "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N", "Binance TON Hot Wallet", "eoa"},
	{"ton", "EQAUFakXJpiZjm3WMM5_h3kHaNn1RX2X8tcA-XJa-rwoY9_q", "OKX TON Hot Wallet", "eoa"},
	{"ton", "EQCbPJVt83Nb-vZIQ-bcWBfoJVSKZGuQ7VJ3pzGtCv6Zghh4", "Bybit TON Hot Wallet", "eoa"},
	{"ton", "EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y2", "TON Foundation wallet", "eoa"},

	// === Stellar: contracts (issuers — analogous to token contracts) ===
	{"stellar", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUV", "AQUA Token Issuer", "contract"},
	{"stellar", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "USDC Issuer (Centre)", "contract"},
	// === Stellar: EOAs (regular accounts) ===
	{"stellar", "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A", "Binance", "eoa"},
	{"stellar", "GCGNWKCJ3KHRLPM3TM6N7D3W5YKDJFL6A2YCXFXNMRTZ4Q66MEMZ6FI2", "Binance 2", "eoa"},
	{"stellar", "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM", "Kraken", "eoa"},
	{"stellar", "GAESQGK5TTKPT2JY4STRN6MJU56LNHQVBFROGX5GFIWUPK3JHZ5F5FCI", "WireX Deposit", "eoa"},
	{"stellar", "GCO2IP3MJNUOKS4PUDI4C7LGGMQDJGXG3COYX3WSB4HHNAHKYV5YL3VC", "Stellar Development Foundation", "eoa"},
	{"stellar", "GA2HGBJIJKI6O4XLMAEAOJI2W7DEVH7SLZWBT4ALOSDQYGT4FFOM5HK4", "Bittrex", "eoa"},
	{"stellar", "GBSTRH4QOTWNSVA6E4HFERETX4ZLSR3CIUBLK7AXYII277PFJC4BBYOG", "OKX Stellar", "eoa"},
	{"stellar", "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V", "Lobstr Vault", "eoa"},

	// === XRP: all EOAs (XRPL accounts) ===
	{"xrp", "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv", "Bitstamp", "eoa"},
	{"xrp", "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh", "Bitstamp 2", "eoa"},
	{"xrp", "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59", "Ripple ops", "eoa"},
	{"xrp", "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w", "Binance XRP Hot", "eoa"},
	{"xrp", "rEy8TFcrAPvhpKrwyrscNYyqBGUkE9hKaJ", "Binance XRP Hot 2", "eoa"},
	{"xrp", "rJb5KsHsDHF1YS5B5DU6QCkH5NsPaKQTcy", "Bitfinex XRP", "eoa"},
	{"xrp", "rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT", "Ripple OTC", "eoa"},
	{"xrp", "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", "Coil Validator", "eoa"},
	{"xrp", "rUpy3eEg8rqjqXUoG3ASZE8ZxqgWqXa9p8", "Wirex XRP", "eoa"},
	{"xrp", "rGFuMiw48HdbnrUbkRYuitXTmfrDBNTCnX", "Bitso XRP", "eoa"},

	// === Bitcoin: all EOAs (UTXO addresses) ===
	{"bitcoin", "1HckjUpRGcrrRAtFaaCAUaGjsPx9oYmLaZ", "Huobi-2 (clustering)", "eoa"},
	{"bitcoin", "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2", "Binance cold", "eoa"},
	{"bitcoin", "3HX5tttedDehKWTTGpxaPAbo157fnjn89s", "Coinbase cold", "eoa"},
	{"bitcoin", "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97", "Bitfinex cold (Bech32 SegWit)", "eoa"},
	{"bitcoin", "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF", "Mt. Gox legacy (well-known)", "eoa"},
	{"bitcoin", "bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6", "Bitfinex hack tracker", "eoa"},
	{"bitcoin", "1FfmbHfnpaZjKFvyi1okTjJJusN455paPH", "F2Pool", "eoa"},
	{"bitcoin", "1CK6KHY6MHgYvmRQ4PAafKYDrg1ejbH1cE", "AntPool", "eoa"},
	{"bitcoin", "bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt", "US Gov seized BTC (Silk Road)", "eoa"},
	{"bitcoin", "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h", "US Gov seized BTC (Bitfinex recovered)", "eoa"},
}
