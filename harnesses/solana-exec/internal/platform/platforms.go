package platform

// FeeAccounts maps platform name → its on-chain fee-receiver accounts.
// Multi-account platforms (GMGN, Axiom) list all wallets; the collector
// paginates each independently and aggregates before sampling.
// Sources: DefiLlama dimension-adapters, verified 2026-08.
var FeeAccounts = map[string][]string{
	"pump.fun": {
		"CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
	},
	"photon": {
		"AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH",
	},
	"bullx": {
		"9RYJ3qr5eU5xAooqVcbmdeusjcViL5Nkiq7Gske3tiKq", // current (post 2024-11-16)
		"F4hJ3Ee3c5UuaorKAMfELBjYCjiiLH75haZTKqTywRP3", // legacy
	},
	"gmgn": {
		// Nine pure fee-collector wallets verified on-chain (2026-06).
		// No transfers among themselves → positive SOL diff = fee, no double-count.
		"BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT",
		"7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA",
		"HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3",
		"ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy",
		"DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9",
		"3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK",
		"DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx",
		"dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ",
		"6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn",
	},
	"axiom": {
		"7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj",
		"4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S",
		"CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ",
		"AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW",
		"7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws",
		"9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP",
		"DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy",
		"4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd",
		"76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf",
		"H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK",
		"8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm",
		"4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz",
		"8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb",
		"86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG",
		"DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM",
		"5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB",
		"DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF",
		"Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9",
		"846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8",
		"5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg",
	},
	"fomo": {
		// FOMO collects fees in USDC. The fee wallet's USDC ATA is monitored for sigs
		// (getSignaturesForAddress on the wallet returns 0 overlap with ATA — confirmed
		// live on 2026-08). Fee detection uses FeeOwners below (the wallet address)
		// because postTokenBalances.owner = wallet, not ATA.
		"HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq", // USDC ATA of fee wallet
	},
}

// FeeToken maps platform name → SPL token mint used for platform fee collection.
// Absent (empty string) = SOL (native lamports). Set for USDC-fee platforms.
// USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
var FeeToken = map[string]string{
	"fomo": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

// FeeOwners maps platform → wallet addresses to match against postTokenBalances.owner
// for SPL-token fee detection. Only needed when FeeAccounts holds ATA addresses
// (which differ from the wallet). If absent, feeSet falls back to FeeAccounts.
var FeeOwners = map[string][]string{
	"fomo": {"R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX"},
}

// JitoTipAccounts is the authoritative set of 8 Jito tip wallets.
// Verified against solana-tx-landing harness wallets.go (2026-08).
var JitoTipAccounts = map[string]bool{
	"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5": true,
	"HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe": true,
	"Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY": true,
	"ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49": true,
	"DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh": true,
	"ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBjNo7XZQshxw3": true,
	"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL": true,
	"3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT": true,
}
