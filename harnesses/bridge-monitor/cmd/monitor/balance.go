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

	"github.com/ethereum/go-ethereum/common"
	"github.com/gagliardetto/solana-go"
)

// BalanceChecker fetches wallet balances from Mobula API
type BalanceChecker struct {
	client        *http.Client
	apiKey        string
	evmAddress    string
	solanaAddress string

	// Fallback on-chain reader. When the Mobula portfolio API fails we read the
	// triangle tokens directly from RPC instead of silently returning zeros,
	// which used to make every tier look like "insufficient funds" during an
	// API outage. Nil in quote-only mode (no TxExecutor).
	onchain *TxExecutor
}

// SetOnchainFallback wires the RPC-based balance readers. Called after the
// TxExecutor exists because the BalanceChecker is constructed first in main.
func (bc *BalanceChecker) SetOnchainFallback(tx *TxExecutor) {
	bc.onchain = tx
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
	balances, _, err := bc.GetAllBalancesDetailed()
	return balances, err
}

// GetAllBalancesDetailed fetches balances for all configured wallets.
// Primary source is the Mobula portfolio API; on per-chain failure it falls
// back to direct RPC reads of the triangle tokens. The degraded flag is true
// when at least one chain could not be read by EITHER path: callers must treat
// degraded balances as unreadable (never "empty wallet") and must not trigger
// automatic rebalancing from them.
func (bc *BalanceChecker) GetAllBalancesDetailed() (map[string]map[string]float64, bool, error) {
	result := make(map[string]map[string]float64)

	// Initialize chains
	result["Solana"] = make(map[string]float64)
	result["Base"] = make(map[string]float64)
	result["Arbitrum"] = make(map[string]float64)

	degraded := false

	// Fetch Solana balances
	if bc.solanaAddress != "" {
		solBalances, err := bc.fetchWalletBalance(bc.solanaAddress)
		if err != nil {
			log.Printf("⚠️  Failed to fetch Solana balances: %v", err)
			if !bc.fillSolanaFromChain(result) {
				log.Printf("⚠️  On-chain Solana fallback also failed: balances degraded")
				degraded = true
			}
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
			if !bc.fillEVMFromChain(result, "Base") {
				log.Printf("⚠️  On-chain Base fallback also failed: balances degraded")
				degraded = true
			}
		} else {
			indexAssets(result, baseBalances, "Base")
		}

		// Arbitrum
		arbBalances, err := bc.fetchWalletBalanceByChain(bc.evmAddress, "arbitrum")
		if err != nil {
			log.Printf("⚠️  Failed to fetch Arbitrum balances: %v", err)
			if !bc.fillEVMFromChain(result, "Arbitrum") {
				log.Printf("⚠️  On-chain Arbitrum fallback also failed: balances degraded")
				degraded = true
			}
		} else {
			indexAssets(result, arbBalances, "Arbitrum")
		}
	}

	if degraded {
		bridgeBalanceReadDegraded.Set(1)
	} else {
		bridgeBalanceReadDegraded.Set(0)
	}

	return result, degraded, nil
}

// Token addresses read by the on-chain fallback. Stablecoins are valued at $1
// parity (good enough to gate executions); SOL and ETH go through the price
// cache with a static fallback because during a Mobula outage the pricer may
// be down too, and a stale gas estimate beats a zero.
const (
	solanaUSDCMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	baseUSDCAddr   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
	arbUSDTAddr    = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
	arbUSDCAddr    = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
)

// fillSolanaFromChain reads Solana USDC + native SOL via RPC. Returns true only
// when the triangle token (USDC) was read successfully: SOL alone is not enough
// to run the cycle simulation, so a USDC read failure keeps the chain degraded.
func (bc *BalanceChecker) fillSolanaFromChain(result map[string]map[string]float64) bool {
	if bc.onchain == nil || bc.onchain.solanaClient == nil {
		return false
	}
	owner, err := solana.PublicKeyFromBase58(bc.solanaAddress)
	if err != nil {
		return false
	}

	mint := solana.MustPublicKeyFromBase58(solanaUSDCMint)
	raw, err := bc.onchain.solanaSPLBalanceOf(owner, mint)
	if err != nil {
		return false
	}
	usd := rawToFloat(raw, 6)
	result["Solana"]["USDC"] = usd
	result["Solana"][strings.ToLower(solanaUSDCMint)] = usd

	if lamports, err := bc.onchain.solanaNativeBalance(owner); err == nil {
		result["Solana"]["SOL"] = rawToFloat(lamports, 9) * TokenPriceUSD("SOL", 150)
	}
	log.Printf("✅ Solana balances recovered via on-chain fallback (USDC $%.2f)", usd)
	return true
}

// fillEVMFromChain reads the chain's triangle stablecoin + native ETH via RPC.
// Same success rule as Solana: the triangle token read must succeed.
func (bc *BalanceChecker) fillEVMFromChain(result map[string]map[string]float64, chain string) bool {
	if bc.onchain == nil {
		return false
	}
	owner := common.HexToAddress(bc.evmAddress)

	type tokenRead struct {
		addr    string
		symbols []string
	}
	var reads []tokenRead
	switch chain {
	case "Base":
		reads = []tokenRead{{baseUSDCAddr, []string{"USDC"}}}
	case "Arbitrum":
		// Both USDT0 and USDT symbols: cycle_sim reads "USDT0" (Mobula naming)
		// while route helpers fall back to "USDT".
		reads = []tokenRead{
			{arbUSDTAddr, []string{"USDT0", "USDT"}},
			{arbUSDCAddr, []string{"USDC"}},
		}
	default:
		return false
	}

	ok := false
	for i, r := range reads {
		raw, err := bc.onchain.erc20BalanceOf(chain, common.HexToAddress(r.addr), owner)
		if err != nil {
			// Only the first entry is the triangle token; secondary reads are
			// best-effort for the stranded-fund gauges.
			if i == 0 {
				return false
			}
			continue
		}
		usd := rawToFloat(raw, 6)
		for _, sym := range r.symbols {
			result[chain][sym] = usd
		}
		result[chain][strings.ToLower(r.addr)] = usd
		if i == 0 {
			ok = true
		}
	}

	if wei, err := bc.onchain.evmNativeBalance(chain, owner); err == nil {
		result[chain]["ETH"] = rawToFloat(wei, 18) * TokenPriceUSD("ETH", 3000)
	}
	if ok {
		log.Printf("✅ %s balances recovered via on-chain fallback", chain)
	}
	return ok
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

// SimulateBalances returns fake balances for dry-run mode. Outside dry-run it
// always returns nil: simulated balances feeding a broadcast-capable process
// could green-light real transfers based on made-up numbers.
func SimulateBalances(mode ExecutionMode) map[string]map[string]float64 {
	// Check if we should simulate
	if os.Getenv("SIMULATE_BALANCES") != "true" {
		return nil
	}
	if mode != ModeDryRun {
		log.Printf("⚠️  SIMULATE_BALANCES=true ignored: EXECUTION_MODE is %q, simulated balances are only honored in dry-run", mode)
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
