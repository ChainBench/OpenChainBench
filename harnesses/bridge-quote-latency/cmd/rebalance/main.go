package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// Test 2 — manual Mobula HyperCore deposit benchmark.
// Bridges $5 of Base USDC into the EVM wallet's Hyperliquid perp account.
// Used once to validate the on-chain fill measurement path before wiring the
// HL clearinghouse balance reader into the main monitor.

func main() {
	log.Println("🧪 Test 2 — Mobula Base USDC → HyperCore deposit")
	log.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	config := loadEnvSimple()
	if config.mobulaAPIKey == "" || config.evmPrivateKey == "" {
		log.Fatal("❌ Missing required env vars (MOBULA_API_KEY, WALLET_EVM_PRIVATE_KEY)")
	}

	amountUSD := 5.0
	if v := os.Getenv("TEST_AMOUNT_USD"); v != "" {
		fmt.Sscanf(v, "%f", &amountUSD)
	}

	log.Printf("EVM Address (sender + HC recipient): %s", config.evmAddress)
	log.Printf("Plan: Base USDC $%.2f → HyperCore (hl:mainnet) USDC via Mobula", amountUSD)
	log.Println("\n⚠️  Real funds, real TX. Costs ~$0.10 gas, $5 capital moves to HL.")
	log.Print("Continue? (yes/no): ")

	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	if strings.TrimSpace(input) != "yes" {
		log.Println("Aborted.")
		return
	}

	mobula := NewMobulaBridgeSimple(config.mobulaAPIKey)
	txExec, err := NewTxExecutorSimple(config.solPrivateKey, config.evmPrivateKey, config.mobulaAPIKey)
	if err != nil {
		log.Fatalf("❌ Failed to init TX executor: %v", err)
	}

	if err := executeBridge(mobula, txExec, BridgeParams{
		FromChain:    "evm:8453",                                    // Base
		FromToken:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",   // Base USDC
		ToChain:      "hl:mainnet",
		ToToken:      "USDC",
		Amount:       amountUSD,
		SenderAddr:   config.evmAddress,
		ReceiverAddr: config.evmAddress,
	}); err != nil {
		log.Fatalf("❌ Test 2 failed: %v", err)
	}

	log.Println("\n⏳ Waiting 15s for HL indexer to credit the perp account...")
	time.Sleep(15 * time.Second)
	log.Println("\n✅ Test 2 deposit complete. Run the post-snapshot curl now to read withdrawable on HL.")
}

type simpleConfig struct {
	mobulaAPIKey  string
	evmAddress    string
	solAddress    string
	evmPrivateKey string
	solPrivateKey string
}

func loadEnvSimple() *simpleConfig {
	config := &simpleConfig{}
	config.mobulaAPIKey = os.Getenv("MOBULA_API_KEY")
	config.evmAddress = os.Getenv("WALLET_EVM_ADDRESS")
	config.solAddress = os.Getenv("WALLET_SOL_ADDRESS")
	config.evmPrivateKey = os.Getenv("WALLET_EVM_PRIVATE_KEY")
	config.solPrivateKey = os.Getenv("WALLET_SOL_PRIVATE_KEY")

	file, err := os.Open(".env")
	if err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			value = strings.Trim(value, `"'`)
			switch key {
			case "MOBULA_API_KEY":
				if config.mobulaAPIKey == "" {
					config.mobulaAPIKey = value
				}
			case "WALLET_EVM_ADDRESS":
				if config.evmAddress == "" {
					config.evmAddress = value
				}
			case "WALLET_SOL_ADDRESS":
				if config.solAddress == "" {
					config.solAddress = value
				}
			case "WALLET_EVM_PRIVATE_KEY":
				if config.evmPrivateKey == "" {
					config.evmPrivateKey = value
				}
			case "WALLET_SOL_PRIVATE_KEY":
				if config.solPrivateKey == "" {
					config.solPrivateKey = value
				}
			}
		}
	}
	return config
}

type BridgeParams struct {
	FromChain      string
	FromToken      string
	ToChain        string
	ToToken        string
	Amount         float64
	SenderAddr     string
	ReceiverAddr   string
	IsSolanaSource bool
}

func executeBridge(mobula *MobulaBridgeSimple, txExec *TxExecutorSimple, params BridgeParams) error {
	log.Printf("\n📝 Getting quote for $%.2f...", params.Amount)
	quote, err := mobula.GetQuote(params)
	if err != nil {
		return fmt.Errorf("quote failed: %w", err)
	}
	log.Printf("✅ Quote received: fee=$%s, output=$%s, time=%dms",
		quote.Data.Fees.TotalFeeUsd, quote.Data.EstimatedAmountOutUsd, 0)

	approveIdx := -1
	for i, step := range quote.Data.Steps {
		if step.Type == "approve" {
			approveIdx = i
			break
		}
	}

	if approveIdx >= 0 {
		step := quote.Data.Steps[approveIdx]
		log.Printf("📝 Sending approval TX → %s", step.Tx.To)
		approvalHash, err := txExec.ExecuteEVMTx(params.FromChain, step.Tx.To, step.Tx.Data, step.Tx.Value)
		if err != nil {
			return fmt.Errorf("approval failed: %w", err)
		}
		log.Printf("✅ Approval TX: %s", approvalHash)
		log.Printf("⏳ Waiting 15s for confirmation...")
		time.Sleep(15 * time.Second)
	}

	var txHash string
	if quote.Data.Deposit.EVM.To != "" {
		log.Printf("📤 Broadcasting EVM bridge TX → %s", quote.Data.Deposit.EVM.To)
		txHash, err = txExec.ExecuteEVMTx(params.FromChain,
			quote.Data.Deposit.EVM.To, quote.Data.Deposit.EVM.Data, quote.Data.Deposit.EVM.Value)
	} else {
		for _, step := range quote.Data.Steps {
			if step.Type != "approve" {
				log.Printf("📤 Broadcasting EVM bridge TX (from steps) → %s", step.Tx.To)
				txHash, err = txExec.ExecuteEVMTx(params.FromChain, step.Tx.To, step.Tx.Data, step.Tx.Value)
				break
			}
		}
	}
	if err != nil {
		return fmt.Errorf("broadcast failed: %w", err)
	}
	log.Printf("✅ Bridge TX broadcast: %s", txHash)

	log.Printf("⏳ Polling Mobula status (timeout 5min)...")
	status, err := txExec.PollMobulaStatus(txHash, 5*time.Minute)
	if err != nil {
		return fmt.Errorf("status poll failed: %w", err)
	}
	if status.Data.Status == "filled" || status.Data.Status == "settled" {
		log.Printf("🎉 Bridge complete! Status: %s | TX: https://basescan.org/tx/%s", status.Data.Status, txHash)
		return nil
	}
	return fmt.Errorf("unexpected final status: %s", status.Data.Status)
}
