package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// BalanceChecker fetches wallet balances from Mobula API
type BalanceChecker struct {
	client        *http.Client
	apiKey        string
	evmAddress    string
	solanaAddress string
}

// MobulaWalletResponse represents the Mobula wallet API response
type MobulaWalletResponse struct {
	Data struct {
		TotalWalletBalance float64 `json:"total_wallet_balance"`
		Assets             []struct {
			Asset struct {
				Name        string   `json:"name"`
				Symbol      string   `json:"symbol"`
				Contracts   []string `json:"contracts"`
				Blockchains []string `json:"blockchains"`
			} `json:"asset"`
			TokenBalance       float64 `json:"token_balance"`
			EstimatedBalance   float64 `json:"estimated_balance"`
			CrossChainBalances map[string]struct {
				Balance float64 `json:"balance"`
				ChainId string  `json:"chainId"`
			} `json:"cross_chain_balances"`
		} `json:"assets"`
	} `json:"data"`
}

// NewBalanceChecker creates a new balance checker
func NewBalanceChecker(apiKey, evmAddress, solanaAddress string) *BalanceChecker {
	return &BalanceChecker{
		client:        &http.Client{Timeout: 30 * time.Second},
		apiKey:        apiKey,
		evmAddress:    evmAddress,
		solanaAddress: solanaAddress,
	}
}

// GetAllBalances fetches balances for all configured wallets
// Returns map[chain][token] = balance_usd
func (bc *BalanceChecker) GetAllBalances() (map[string]map[string]float64, error) {
	result := make(map[string]map[string]float64)

	// Initialize chains
	result["Solana"] = make(map[string]float64)
	result["Base"] = make(map[string]float64)
	result["Arbitrum"] = make(map[string]float64)

	// Fetch Solana balances
	if bc.solanaAddress != "" {
		solBalances, err := bc.fetchWalletBalance(bc.solanaAddress)
		if err != nil {
			log.Printf("⚠️  Failed to fetch Solana balances: %v", err)
		} else {
			indexAssets(result, solBalances, "Solana")
		}
	}

	// Fetch EVM balances (Base)
	if bc.evmAddress != "" {
		// Base
		baseBalances, err := bc.fetchWalletBalanceByChain(bc.evmAddress, "base")
		if err != nil {
			log.Printf("⚠️  Failed to fetch Base balances: %v", err)
		} else {
			indexAssets(result, baseBalances, "Base")
		}

		// Arbitrum
		arbBalances, err := bc.fetchWalletBalanceByChain(bc.evmAddress, "arbitrum")
		if err != nil {
			log.Printf("⚠️  Failed to fetch Arbitrum balances: %v", err)
		} else {
			indexAssets(result, arbBalances, "Arbitrum")
		}
	}

	return result, nil
}

// indexAssets stores balances in the result map, keyed by BOTH symbol AND contract address (lowercase).
// This handles cases where Mobula's DB uses a different symbol than our code (e.g. USDT0 vs USDT).
func indexAssets(result map[string]map[string]float64, resp *MobulaWalletResponse, targetChain string) {
	for _, asset := range resp.Data.Assets {
		chainBal, ok := asset.CrossChainBalances[targetChain]
		if !ok || chainBal.Balance <= 0 {
			continue
		}

		// Compute USD balance on this specific chain (pro-rata from total)
		usdBalance := asset.EstimatedBalance
		if asset.TokenBalance > 0 && chainBal.Balance != asset.TokenBalance {
			usdBalance = (chainBal.Balance / asset.TokenBalance) * asset.EstimatedBalance
		}

		// Store by symbol (backward compat)
		result[targetChain][asset.Asset.Symbol] = usdBalance

		// Store by contract address (lowercase) - robust lookup by route.FromToken
		// Each asset's Contracts[] is parallel to Blockchains[]; find the entry for targetChain
		for i, bc := range asset.Asset.Blockchains {
			if strings.EqualFold(bc, targetChain) && i < len(asset.Asset.Contracts) {
				addr := strings.ToLower(asset.Asset.Contracts[i])
				result[targetChain][addr] = usdBalance
				break
			}
		}
	}
}

// fetchWalletBalance fetches balance for a single wallet (all chains)
func (bc *BalanceChecker) fetchWalletBalance(address string) (*MobulaWalletResponse, error) {
	url := fmt.Sprintf("https://api.mobula.io/api/1/wallet/portfolio?wallet=%s", address)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	if bc.apiKey != "" {
		req.Header.Set("Authorization", bc.apiKey)
	}

	resp, err := bc.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var result MobulaWalletResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("JSON parse error: %w (body: %s)", err, string(body)[:min(200, len(body))])
	}

	return &result, nil
}

// fetchWalletBalanceByChain fetches balance for a specific chain
func (bc *BalanceChecker) fetchWalletBalanceByChain(address, chain string) (*MobulaWalletResponse, error) {
	url := fmt.Sprintf("https://api.mobula.io/api/1/wallet/portfolio?wallet=%s&blockchains=%s", address, chain)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	if bc.apiKey != "" {
		req.Header.Set("Authorization", bc.apiKey)
	}

	resp, err := bc.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var result MobulaWalletResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("JSON parse error: %w", err)
	}

	return &result, nil
}

// min returns the minimum of two ints
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// CheckSufficientFunds checks if we have enough funds for a test
func (bc *BalanceChecker) CheckSufficientFunds(chain, token string, requiredUSD float64) (bool, float64, error) {
	balances, err := bc.GetAllBalances()
	if err != nil {
		return false, 0, err
	}

	available := balances[chain][token]
	return available >= requiredUSD, available, nil
}

// PrintBalances logs current balances
func (bc *BalanceChecker) PrintBalances() {
	balances, err := bc.GetAllBalances()
	if err != nil {
		log.Printf("❌ Failed to fetch balances: %v", err)
		return
	}

	log.Println("💰 Current Balances:")
	totalUSD := 0.0

	for chain, tokens := range balances {
		for token, balance := range tokens {
			if balance > 0.01 { // Only show non-dust
				log.Printf("  %s/%s: $%.2f", chain, token, balance)
				totalUSD += balance
			}
		}
	}

	log.Printf("  ────────────────")
	log.Printf("  Total: $%.2f", totalUSD)
}

// ExportBalancesToMetrics refreshes the wallet_balance_usd gauges.
// Skips contract-address keys (indexAssets writes both symbol + address — only symbols
// are useful labels for dashboards/alerts).
func (bc *BalanceChecker) ExportBalancesToMetrics(region string) error {
	balances, err := bc.GetAllBalances()
	if err != nil {
		return err
	}

	for chain, tokens := range balances {
		for token, usd := range tokens {
			// Skip contract-address keys (0x... or >12 char non-uppercase).
			if strings.HasPrefix(token, "0x") || len(token) > 12 {
				continue
			}
			walletBalanceUSD.WithLabelValues(chain, token, region).Set(usd)
		}
	}
	walletBalanceLastUpdate.SetToCurrentTime()
	return nil
}

// GetTotalBalanceUSD returns total portfolio value
func (bc *BalanceChecker) GetTotalBalanceUSD() (float64, error) {
	balances, err := bc.GetAllBalances()
	if err != nil {
		return 0, err
	}

	total := 0.0
	for _, tokens := range balances {
		for _, balance := range tokens {
			total += balance
		}
	}

	return total, nil
}

// SimulateBalances returns fake balances for dry-run mode
func SimulateBalances() map[string]map[string]float64 {
	// Check if we should simulate
	if os.Getenv("SIMULATE_BALANCES") != "true" {
		return nil
	}

	log.Println("🧪 Using simulated balances (SIMULATE_BALANCES=true)")
	return map[string]map[string]float64{
		"Solana": {
			"SOL":   40.0,
			"USDC":  350.0,
			"TRUMP": 110.0,
		},
		"Base": {
			"ETH":  60.0,
			"USDC": 0.0, // Will receive from tests
		},
		"Arbitrum": {
			"ETH":  40.0,
			"USDT": 0.0, // Will receive from tests
		},
	}
}
