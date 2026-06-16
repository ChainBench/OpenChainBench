package main

import (
	"fmt"
	"log"
)

// WalletManager handles wallet operations for both EVM and Solana
type WalletManager struct {
	// EVM
	EVMPrivateKey string
	EVMAddress    string

	// Solana
	SolanaPrivateKey string
	SolanaAddress    string

	// Mode
	DryRun bool
}

// NewWalletManager creates a new wallet manager from config
func NewWalletManager(config *Config) (*WalletManager, error) {
	wm := &WalletManager{
		EVMPrivateKey:    config.WalletEVMPrivateKey,
		EVMAddress:       config.WalletEVMAddress,
		SolanaPrivateKey: config.WalletSOLPrivateKey,
		SolanaAddress:    config.WalletSOLAddress,
		DryRun:           config.ExecutionMode != "production" && config.ExecutionMode != "single-test",
	}

	// Validate
	if wm.EVMAddress == "" && wm.SolanaAddress == "" {
		// Use default test addresses for quote-only mode
		wm.EVMAddress = "0x0000000000000000000000000000000000000000"
		wm.SolanaAddress = "11111111111111111111111111111111"
		log.Println("⚠️  No wallet configured, using default addresses (quote-only mode)")
	}

	return wm, nil
}

// HasPrivateKeys returns true if we have private keys configured
func (wm *WalletManager) HasPrivateKeys() bool {
	return wm.EVMPrivateKey != "" && wm.SolanaPrivateKey != ""
}

// CanExecute returns true if we can execute real transactions
func (wm *WalletManager) CanExecute() bool {
	return wm.HasPrivateKeys() && !wm.DryRun
}

// GetEVMSigner returns an EVM signer (placeholder - would use go-ethereum)
func (wm *WalletManager) GetEVMSigner() (interface{}, error) {
	if wm.EVMPrivateKey == "" {
		return nil, fmt.Errorf("EVM private key not configured")
	}

	// TODO: Implement with go-ethereum
	// privateKey, err := crypto.HexToECDSA(strings.TrimPrefix(wm.EVMPrivateKey, "0x"))
	// if err != nil {
	//     return nil, err
	// }
	// return bind.NewKeyedTransactorWithChainID(privateKey, chainID)

	return nil, fmt.Errorf("EVM signing not yet implemented")
}

// GetSolanaSigner returns a Solana signer (placeholder)
func (wm *WalletManager) GetSolanaSigner() (interface{}, error) {
	if wm.SolanaPrivateKey == "" {
		return nil, fmt.Errorf("Solana private key not configured")
	}

	// TODO: Implement with solana-go
	// privateKey := solana.MustPrivateKeyFromBase58(wm.SolanaPrivateKey)
	// return privateKey, nil

	return nil, fmt.Errorf("Solana signing not yet implemented")
}

// LogWalletInfo logs wallet addresses (not keys!)
func (wm *WalletManager) LogWalletInfo() {
	log.Println("🔑 Wallet Configuration:")
	log.Printf("  EVM Address:    %s", wm.EVMAddress)
	log.Printf("  Solana Address: %s", wm.SolanaAddress)
	log.Printf("  Has Private Keys: %v", wm.HasPrivateKeys())
	log.Printf("  Can Execute: %v", wm.CanExecute())
	log.Printf("  Mode: %s", map[bool]string{true: "dry-run", false: "production"}[wm.DryRun])
}
