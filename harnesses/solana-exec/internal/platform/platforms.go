package platform

// FeeAccounts maps platform name → its on-chain fee-receiver account.
// These are the accounts that receive platform fees from user trades.
// Adding a new platform = one line here.
var FeeAccounts = map[string]string{
	"pump.fun": "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
	// TODO: add FOMO, Axiom, GMGN once their fee accounts are confirmed
	// Discover by inspecting any known tx from each platform and finding
	// the SOL recipient that is not the user, not Jito, not rent.
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
