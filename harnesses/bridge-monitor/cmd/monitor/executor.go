package main

import (
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// ExecutionMode controls whether we actually broadcast transactions
type ExecutionMode string

const (
	ModeDryRun     ExecutionMode = "dry-run"     // Simulate everything, no real TX
	ModeSingleTest ExecutionMode = "single-test" // One real TX to validate
	ModeProduction ExecutionMode = "production"  // Full execution loop
)

// ExecutionConfig holds the execution loop configuration.
// Daily spend tracking lives in the Executor's SpendTracker (UTC-date keyed,
// persisted to disk), not here: a plain struct field never reset and was
// zeroed by every restart.
type ExecutionConfig struct {
	Mode             ExecutionMode
	Freq5USD         time.Duration // How often to run $5 tests
	Freq50USD        time.Duration // How often to run $50 tests
	Freq300USD       time.Duration // How often to run $300 tests
	EnableDebridge   bool          // Whether to execute Debridge (expensive)
	MaxDailySpendUSD float64       // Safety cap on daily spending
}

// ExecutionResult holds the result of an execution test
type ExecutionResult struct {
	Bridge             string
	Route              TestRoute
	AmountUSD          float64
	QuoteLatencyMs     int64
	ExecutionLatencyMs int64   // Time from broadcast to funds received
	E2ELatencyMs       int64   // Time from quote start to funds received
	Success            bool
	Reverted           bool
	Error              error
	QuoteFeeUSD        float64 // Fee from quote
	ActualFeeUSD       float64 // Actual fee paid (input - output)
	TxHash             string
	DryRun             bool
	// For Slack notifications
	FromChain   string
	ToChain     string
	FromToken   string
	ToToken     string
	FeesUSD     float64
	FeesPercent float64
	CostUSD     float64
	OutputUSD   float64 // What landed on destination (the fill)
}

// Executor handles the execution loop
type Executor struct {
	config        *ExecutionConfig
	walletManager *WalletManager
	balanceCheck  *BalanceChecker
	txExecutor    *TxExecutor
	mobula        *MobulaBridge
	relay         *RelayBridge
	lifi          *LiFiBridge
	debridge      *DebridgeBridge
	region        string
	slack         *SlackNotifier
	spend         *SpendTracker
}

// DailySpent returns today's consumed budget via the mutex-guarded tracker.
// All cap checks must go through here, never through a raw field, so the
// reaper goroutine and the scheduler loop cannot race on the counter.
func (e *Executor) DailySpent() float64 {
	return e.spend.Spent()
}

// AddDailySpend books usd against today's budget (UTC-date keyed, persisted).
func (e *Executor) AddDailySpend(usd float64) {
	e.spend.Add(usd)
}

// accountSpend books a broadcast's cost against the daily cap. A successful
// fill books the realized fee. Any broadcast that produced a TxHash but did
// not confirm as a success books a conservative flat estimate, because the
// deposit or approval TX most likely burned gas even without a fill. Results
// that never broadcast cost nothing.
func (e *Executor) accountSpend(result *ExecutionResult) {
	if result == nil || result.DryRun {
		return
	}
	switch {
	case result.Success:
		e.AddDailySpend(result.ActualFeeUSD)
	case result.TxHash != "":
		e.AddDailySpend(failedTxFeeEstimateUSD())
	}
}

// NewExecutor creates a new executor
func NewExecutor(
	config *ExecutionConfig,
	walletManager *WalletManager,
	balanceCheck *BalanceChecker,
	mobula *MobulaBridge,
	relay *RelayBridge,
	lifi *LiFiBridge,
	debridge *DebridgeBridge,
	region string,
	slack *SlackNotifier,
) *Executor {
	e := &Executor{
		config:        config,
		walletManager: walletManager,
		balanceCheck:  balanceCheck,
		mobula:        mobula,
		relay:         relay,
		lifi:          lifi,
		debridge:      debridge,
		region:        region,
		slack:         slack,
		spend:         NewSpendTracker(spendStatePath(), time.Now),
	}

	// Initialize TxExecutor if we have private keys
	if walletManager != nil && walletManager.HasPrivateKeys() {
		dryRun := config.Mode != ModeProduction && config.Mode != ModeSingleTest
		mobulaAPIKey := ""
		if mobula != nil {
			mobulaAPIKey = mobula.APIKey()
		}
		txExec, err := NewTxExecutor(
			walletManager.SolanaPrivateKey,
			walletManager.EVMPrivateKey,
			mobulaAPIKey,
			dryRun,
		)
		if err != nil {
			log.Printf("⚠️  Failed to initialize TxExecutor: %v", err)
		} else {
			e.txExecutor = txExec
			log.Println("✅ TxExecutor initialized")
			// Give the balance checker an RPC fallback so a Mobula portfolio
			// API outage no longer reads as an empty wallet.
			if balanceCheck != nil {
				balanceCheck.SetOnchainFallback(txExec)
			}
		}
	}

	return e
}

// RunDryRun simulates the full execution flow without broadcasting
func (e *Executor) RunDryRun(route TestRoute, amountUSD float64) *ExecutionResult {
	result := &ExecutionResult{
		Route:     route,
		AmountUSD: amountUSD,
		DryRun:    true,
	}

	log.Printf("🧪 [DRY-RUN] Testing %s with $%.0f", route.Name, amountUSD)

	// Step 1: Check balances. Keyless dry-run has no balance checker, so fall
	// back to the SIMULATE_BALANCES snapshot instead of crashing.
	log.Printf("  📊 Checking balances...")
	var balances map[string]map[string]float64
	if e.balanceCheck != nil {
		var err error
		balances, err = e.balanceCheck.GetAllBalances()
		if err != nil {
			log.Printf("  ❌ Balance check failed: %v", err)
			result.Error = err
			return result
		}
	} else if balances = SimulateBalances(e.config.Mode); balances == nil {
		log.Printf("  ❌ No balance checker and SIMULATE_BALANCES not set")
		result.Error = fmt.Errorf("no balance source in dry-run")
		return result
	}

	// Log balances
	for chain, tokens := range balances {
		for token, bal := range tokens {
			log.Printf("    %s/%s: $%.2f", chain, token, bal)
		}
	}

	// Step 2: Verify we have enough funds (lookup by contract address, robust against symbol mismatch)
	// 3 bridges execute sequentially, each consuming `amountUSD` from the source leg.
	// 5% buffer on top of the total to cover per-bridge fees.
	requiredAmount := 3 * amountUSD * 1.05
	available := getAvailableBalance(balances, route)

	if available < requiredAmount {
		log.Printf("  ⚠️  Insufficient funds on %s %s: need $%.2f, have $%.2f", route.FromChain, route.FromToken, requiredAmount, available)
		result.Error = fmt.Errorf("insufficient funds: need %.2f, have %.2f", requiredAmount, available)
		return result
	}
	log.Printf("  ✅ Sufficient funds: $%.2f available", available)

	// Step 3: Get quotes from all bridges
	log.Printf("  📝 Getting quotes...")

	// Test Mobula
	if e.mobula != nil {
		e.testBridgeDryRun("mobula", route, amountUSD)
	}

	// Test Relay
	e.testBridgeDryRun("relay", route, amountUSD)

	// Test Li.Fi
	e.testBridgeDryRun("lifi", route, amountUSD)

	// Test Debridge (if enabled)
	if e.config.EnableDebridge {
		e.testBridgeDryRun("debridge", route, amountUSD)
	}

	result.Success = true
	return result
}

// RunReal executes real transactions and measures latency
func (e *Executor) RunReal(route TestRoute, amountUSD float64) []*ExecutionResult {
	var results []*ExecutionResult

	log.Printf("💸 [REAL] Executing %s with $%.0f", route.Name, amountUSD)

	// Safety checks
	if e.txExecutor == nil {
		log.Printf("❌ TxExecutor not initialized - cannot execute")
		return results
	}

	if !e.txExecutor.CanExecute() {
		log.Printf("❌ Cannot execute - missing private keys or in dry-run mode")
		return results
	}

	// Check daily spending limit
	if spent := e.DailySpent(); spent >= e.config.MaxDailySpendUSD {
		msg := fmt.Sprintf("Daily spending limit reached ($%.2f / $%.2f)", spent, e.config.MaxDailySpendUSD)
		log.Printf("⚠️  %s", msg)
		if e.slack != nil {
			_ = e.slack.NotifyScheduledSkip(route.Name, route.FromChain, route.FromToken, amountUSD, msg)
		}
		return results
	}

	// Check balances
	balances, err := e.balanceCheck.GetAllBalances()
	if err != nil {
		log.Printf("❌ Balance check failed: %v", err)
		if e.slack != nil {
			_ = e.slack.NotifyScheduledSkip(route.Name, route.FromChain, route.FromToken, amountUSD,
				fmt.Sprintf("Balance check failed: %v", err))
		}
		return results
	}

	// 3 bridges run sequentially per route, each pulling `amountUSD` from the source
	// leg. Need 3×amount × 1.05 (fee buffer) at route start — pre-flight already
	// simulated the cycle, this is the per-route safety net.
	requiredAmount := 3 * amountUSD * 1.05
	available := getAvailableBalance(balances, route)

	if available < requiredAmount {
		msg := fmt.Sprintf("Insufficient funds: need $%.2f, have $%.2f", requiredAmount, available)
		log.Printf("⚠️  %s on %s %s", msg, route.FromChain, route.FromToken)
		if e.slack != nil {
			_ = e.slack.NotifyScheduledSkip(route.Name, route.FromChain, route.FromToken, amountUSD, msg)
		}
		return results
	}

	// Calculate raw units - for USDC/USDT amount equals USD, for TRUMP convert
	amount := amountUSD
	if route.Name == "TRUMP_SOL_BRETT_BASE" {
		amount = amountUSD / TokenPriceUSD("TRUMP", 2.55) // live TRUMP price (5min cache)
	}
	rawUnits := toRawUnits(amount)

	// Execute on each bridge (except Debridge - too expensive)
	bridges := []string{"mobula", "relay", "lifi"}

	for _, bridge := range bridges {
		result := e.executeOnBridge(bridge, route, amount, amountUSD, rawUnits)
		if result != nil {
			results = append(results, result)

			// Record metrics
			e.recordExecutionMetrics(result)

			// Send Slack notification
			if e.slack != nil {
				log.Printf("    📤 Sending Slack notification...")
				if err := e.slack.NotifyBridgeExecution(result); err != nil {
					log.Printf("    ⚠️  Slack notification failed: %v", err)
				} else {
					log.Printf("    ✅ Slack notification sent")
				}
			}

			// Update daily spending (realized fee on success, flat gas
			// estimate on a broadcast that never confirmed).
			e.accountSpend(result)
		}

		// Wait between bridges to avoid rate limiting
		time.Sleep(2 * time.Second)
	}

	return results
}

// RunBridgeOnRoute executes ONE bridge on ONE route, records metrics, and fires Slack.
// Called by the sequential per-bridge orchestration in main.go so each bridge does its
// own full R1→R2→R3 triangle before the next bridge starts (lower peak capital need
// per leg, cleaner per-bridge round-trip cost).
func (e *Executor) RunBridgeOnRoute(bridge string, route TestRoute, amountUSD float64) *ExecutionResult {
	if e.txExecutor == nil || !e.txExecutor.CanExecute() {
		return nil
	}
	if spent := e.DailySpent(); spent >= e.config.MaxDailySpendUSD {
		log.Printf("⚠️  Daily spending limit reached ($%.2f / $%.2f)", spent, e.config.MaxDailySpendUSD)
		return nil
	}

	amount := amountUSD
	if route.Name == "TRUMP_SOL_BRETT_BASE" {
		amount = amountUSD / TokenPriceUSD("TRUMP", 2.55) // live TRUMP price (5min cache)
	}
	rawUnits := toRawUnits(amount)

	result := e.executeOnBridge(bridge, route, amount, amountUSD, rawUnits)
	if result == nil {
		return nil
	}

	e.recordExecutionMetrics(result)

	if e.slack != nil {
		if err := e.slack.NotifyBridgeExecution(result); err != nil {
			log.Printf("    ⚠️  Slack notification failed: %v", err)
		}
	}

	e.accountSpend(result)
	return result
}

// executeOnBridge executes a transaction on a specific bridge
func (e *Executor) executeOnBridge(bridge string, route TestRoute, amount, amountUSD float64, rawUnits string) *ExecutionResult {
	result := &ExecutionResult{
		Bridge:    bridge,
		Route:     route,
		AmountUSD: amountUSD,
	}

	log.Printf("  [%s] Executing $%.0f %s...", bridge, amountUSD, route.Name)

	// Capture destination balance BEFORE execution so we can compute realized
	// fill (post-fill - pre-fill) instead of trusting the quote's projected
	// output. The quote can lie (e.g. Mobula returns "expected $50" while
	// minOut is $49.5 — the actual fill is somewhere in between).
	receiver := e.walletManager.EVMAddress
	if route.ToChain == "Solana" {
		receiver = e.walletManager.SolanaAddress
	}
	preBalanceRaw, preBalErr := e.txExecutor.readDestinationBalance(route.ToChain, route.ToToken, receiver)
	if preBalErr != nil {
		log.Printf("    ⚠️  pre-execution balance read failed (%v) — falling back to quote-projected fill", preBalErr)
	}

	// PHASE 1: Get quote with TX data
	quoteStart := time.Now()
	var txHash string
	var err error

	switch bridge {
	case "mobula":
		result, txHash, err = e.executeMobula(route, amount, quoteStart)
	case "relay":
		result, txHash, err = e.executeRelay(route, rawUnits, quoteStart)
	case "lifi":
		result, txHash, err = e.executeLiFi(route, rawUnits, quoteStart)
	}

	// Populate route fields for Slack (do this before error check so failed results have route info)
	result.FromChain = route.FromChain
	result.ToChain = route.ToChain
	result.FromToken = route.FromToken
	result.ToToken = route.ToToken
	result.AmountUSD = amountUSD

	// Keep the TxHash even when the attempt errored out: callers use it to
	// tell a pre-broadcast failure (safe to retry) from a broadcast whose
	// final status is unknown (terminal, funds may still be in flight) and
	// to account the gas a failed TX still burned.
	result.TxHash = txHash

	if err != nil {
		log.Printf("    ❌ Execution failed: %v", err)
		result.Error = err
		return result
	}
	// If the sub-function flagged a refund/revert, keep Success=false so Slack and
	// Prometheus correctly classify it (Reverted takes precedence over Success).
	result.Success = !result.Reverted

	// Read the destination balance again to compute the REALIZED fill on-chain.
	// Bridge status "filled" sometimes precedes the destination credit by 1-3
	// blocks; pollRealizedFill waits up to 30s for the delta to materialise.
	if result.Success && preBalErr == nil {
		postBalanceRaw, pollErr := e.txExecutor.pollRealizedFill(route.ToChain, route.ToToken, receiver, preBalanceRaw, 30*time.Second)
		if pollErr != nil {
			log.Printf("    ⚠️  realized fill not visible within 30s (%v) — keeping quote-projected output", pollErr)
		} else if postBalanceRaw != nil {
			deltaRaw := rawDelta(postBalanceRaw, preBalanceRaw)
			realizedToken := rawToFloat(deltaRaw, destinationTokenDecimals(route))
			realizedUSD := realizedToken * destinationUSDPerToken(route)
			log.Printf("    💰 Realized fill on-chain: %.6f tokens = $%.4f (quote projected $%.4f)", realizedToken, realizedUSD, result.OutputUSD)
			result.OutputUSD = realizedUSD
			// Recompute fees from realized: amount sent - amount received
			realFees := amountUSD - realizedUSD
			if realFees < 0 {
				realFees = 0
			}
			result.ActualFeeUSD = realFees
		}
	}

	result.FeesUSD = result.ActualFeeUSD
	if amountUSD > 0 {
		result.FeesPercent = (result.ActualFeeUSD / amountUSD) * 100
	}
	result.CostUSD = result.ActualFeeUSD

	status := "✅ Success"
	if result.Reverted {
		status = "🔄 Reverted"
	}
	log.Printf("    %s! TX: %s | Quote: %dms | Exec: %dms | E2E: %dms | Fee: $%.4f",
		status,
		txHash[:16]+"...",
		result.QuoteLatencyMs,
		result.ExecutionLatencyMs,
		result.E2ELatencyMs,
		result.ActualFeeUSD,
	)

	return result
}

// executeMobula handles Mobula bridge execution
func (e *Executor) executeMobula(route TestRoute, amount float64, quoteStart time.Time) (*ExecutionResult, string, error) {
	result := &ExecutionResult{Bridge: "mobula", Route: route, AmountUSD: amount}

	// Determine sender address based on source chain
	senderAddress := e.walletManager.EVMAddress
	receiverAddress := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		senderAddress = e.walletManager.SolanaAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = e.walletManager.SolanaAddress
	}

	log.Printf("    [mobula] Getting quote: %s → %s, amount: %.4f, sender: %s", route.FromChain, route.ToChain, amount, senderAddress[:8]+"...")

	// Two-step quote: for EVM origins the first response's deposit is a
	// placeholder; only the signed re-quote's deposit is executable. See
	// mobula_bridge.go GetSignedQuote for the flow.
	var evmKey *ecdsa.PrivateKey
	if e.txExecutor != nil {
		evmKey = e.txExecutor.EVMPrivateKey()
	}
	quote, _, err := e.mobula.GetSignedQuote(
		route.FromChainAPI, route.FromToken,
		route.ToChainAPI, route.ToToken,
		senderAddress, receiverAddress,
		amount, evmKey,
	)
	if err != nil {
		log.Printf("    [mobula] ❌ Quote error: %v", err)
		return result, "", fmt.Errorf("quote failed: %w", err)
	}

	result.QuoteLatencyMs = time.Since(quoteStart).Milliseconds()
	bridgeFeeUSD, _ := strconv.ParseFloat(quote.Data.Fees.TotalFeeUsd, 64)
	gasFeeUSD, _ := strconv.ParseFloat(quote.Data.Fees.GasFeeUsd, 64)
	result.QuoteFeeUSD = bridgeFeeUSD + gasFeeUSD
	if outUsd, err := strconv.ParseFloat(quote.Data.EstimatedAmountOutUsd, 64); err == nil {
		result.OutputUSD = outUsd
	}

	// Check for approval step in steps array
	var approveStepIdx = -1
	for i, step := range quote.Data.Steps {
		if step.Type == "approve" {
			approveStepIdx = i
			break
		}
	}
	hasApprove := approveStepIdx >= 0

	log.Printf("    [mobula] ✅ Quote received: fee=$%.4f, outputUSD=$%.2f, hasDepositSolana=%v, hasDepositEVM=%v, hasApprove=%v, stepsCount=%d",
		result.QuoteFeeUSD,
		func() float64 { v, _ := strconv.ParseFloat(quote.Data.EstimatedAmountOutUsd, 64); return v }(),
		quote.Data.Deposit.Solana.SerializedTx != "",
		quote.Data.Deposit.EVM.To != "",
		hasApprove,
		len(quote.Data.Steps),
	)

	// Step 1: Send approval TX if required (for ERC-20 tokens on EVM)
	if hasApprove {
		approveStep := quote.Data.Steps[approveStepIdx]
		log.Printf("    [mobula] 📝 Sending ERC-20 approval to=%s", approveStep.Tx.To)
		approvalHash, err := e.txExecutor.ExecuteEVMTransaction(route.FromChain, approveStep.Tx.To, approveStep.Tx.Data, approveStep.Tx.Value)
		if err != nil {
			log.Printf("    [mobula] ❌ Approval TX failed: %v", err)
			return result, "", fmt.Errorf("approval failed: %w", err)
		}
		log.Printf("    [mobula] ✅ Approval TX sent: %s", approvalHash)

		// Wait for approval to confirm
		log.Printf("    [mobula] ⏳ Waiting for approval confirmation...")
		time.Sleep(5 * time.Second)

		// Verify approval confirmed
		success, err := e.txExecutor.CheckEVMTxStatus(route.FromChain, approvalHash)
		if err != nil || !success {
			log.Printf("    [mobula] ❌ Approval TX failed to confirm")
			return result, approvalHash, fmt.Errorf("approval not confirmed")
		}
		log.Printf("    [mobula] ✅ Approval confirmed")
	}

	// Step 2: Execute deposit transaction
	execStart := time.Now()
	var txHash string

	if quote.Data.Deposit.Solana.SerializedTx != "" {
		// Solana source - use deposit.solana.serializedTx
		log.Printf("    [mobula] 📤 Broadcasting Solana TX (type=%s, len=%d)", quote.Data.Deposit.Solana.Type, len(quote.Data.Deposit.Solana.SerializedTx))
		txHash, err = e.txExecutor.ExecuteSolanaTransaction(quote.Data.Deposit.Solana.SerializedTx)
	} else if quote.Data.Deposit.EVM.To != "" {
		// EVM source - use deposit.evm
		log.Printf("    [mobula] 📤 Broadcasting EVM TX to=%s, value=%s", quote.Data.Deposit.EVM.To, quote.Data.Deposit.EVM.Value)
		txHash, err = e.txExecutor.ExecuteEVMTransaction(route.FromChain, quote.Data.Deposit.EVM.To, quote.Data.Deposit.EVM.Data, quote.Data.Deposit.EVM.Value)
	} else if len(quote.Data.Steps) > 0 {
		// Use steps array - approval already handled above, find bridgeToken step
		for _, step := range quote.Data.Steps {
			if step.Type == "bridgeToken" || step.Type != "approve" {
				log.Printf("    [mobula] 📤 Broadcasting EVM TX (steps) to=%s, value=%s", step.Tx.To, step.Tx.Value)
				txHash, err = e.txExecutor.ExecuteEVMTransaction(route.FromChain, step.Tx.To, step.Tx.Data, step.Tx.Value)
				break
			}
		}
	} else {
		log.Printf("    [mobula] ❌ No TX data in quote response (deposit.solana=%v, deposit.evm=%v, steps=%d)",
			quote.Data.Deposit.Solana.SerializedTx != "", quote.Data.Deposit.EVM.To != "", len(quote.Data.Steps))
		return result, "", fmt.Errorf("no transaction data in quote")
	}

	if err != nil {
		log.Printf("    [mobula] ❌ Broadcast error: %v", err)
		return result, "", fmt.Errorf("broadcast failed: %w", err)
	}

	log.Printf("    [mobula] ✅ TX broadcast: %s", txHash)
	log.Printf("    [mobula] ⏳ Polling status (timeout: 5min)...")

	// Mobula can take 2-5min to settle an intent even on EVM sources (solver backlog,
	// indexer lag, etc.). Use 5min for both Solana and EVM so we don't bail before
	// Mobula has a chance to fill or refund. The EVM receipt check below is still
	// useful if our TX itself reverted on-chain.
	pollTimeout := 5 * time.Minute

	status, err := e.txExecutor.PollMobulaStatus(txHash, pollTimeout)
	execEnd := time.Now()

	// For EVM source: if still pending/timeout, check TX receipt directly
	if route.FromChain != "Solana" && (err != nil || status == nil || status.Status == "pending") {
		log.Printf("    [mobula] 🔍 Checking EVM TX receipt...")
		success, receiptErr := e.txExecutor.CheckEVMTxStatus(route.FromChain, txHash)
		if receiptErr == nil {
			if !success {
				log.Printf("    [mobula] ❌ EVM TX reverted!")
				result.Reverted = true
				result.ExecutionLatencyMs = execEnd.Sub(execStart).Milliseconds()
				result.E2ELatencyMs = execEnd.Sub(quoteStart).Milliseconds()
				return result, txHash, fmt.Errorf("transaction reverted on-chain")
			}
			// TX succeeded on-chain but Mobula API not updated yet
			log.Printf("    [mobula] ✅ EVM TX confirmed on-chain, bridge pending...")
		}
	}

	if err != nil {
		log.Printf("    [mobula] ❌ Status poll error: %v", err)
		return result, txHash, fmt.Errorf("status poll failed: %w", err)
	}

	result.ExecutionLatencyMs = execEnd.Sub(execStart).Milliseconds()
	result.E2ELatencyMs = execEnd.Sub(quoteStart).Milliseconds()

	log.Printf("    [mobula] 🏁 Final status: %s (exec: %dms, e2e: %dms)",
		status.Status, result.ExecutionLatencyMs, result.E2ELatencyMs)

	if status.Status == "filled" || status.Status == "settled" {
		result.Success = true
		result.ActualFeeUSD = result.QuoteFeeUSD
	} else if status.Status == "refunded" {
		result.Reverted = true
		log.Printf("    [mobula] ⚠️ Transaction was refunded!")
	}

	return result, txHash, nil
}

// executeRelay handles Relay bridge execution
func (e *Executor) executeRelay(route TestRoute, rawUnits string, quoteStart time.Time) (*ExecutionResult, string, error) {
	result := &ExecutionResult{Bridge: "relay", Route: route}

	// Determine sender address based on source chain
	senderAddress := e.walletManager.EVMAddress
	receiverAddress := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		senderAddress = e.walletManager.SolanaAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = e.walletManager.SolanaAddress
	}

	log.Printf("    [relay] Getting quote: %s → %s, rawUnits: %s, sender: %s", route.FromChain, route.ToChain, rawUnits, senderAddress[:8]+"...")

	// Get quote with TX
	quote, _, err := e.relay.GetQuote(route, rawUnits, senderAddress, receiverAddress)
	if err != nil {
		log.Printf("    [relay] ❌ Quote error: %v", err)
		return result, "", fmt.Errorf("quote failed: %w", err)
	}

	result.QuoteLatencyMs = time.Since(quoteStart).Milliseconds()
	svc, _ := strconv.ParseFloat(quote.Fees.RelayerService.AmountUsd, 64)
	gas, _ := strconv.ParseFloat(quote.Fees.RelayerGas.AmountUsd, 64)
	result.QuoteFeeUSD = svc + gas
	if outUsd, err := strconv.ParseFloat(quote.Details.CurrencyOut.AmountUsd, 64); err == nil {
		result.OutputUSD = outUsd
	}

	// Find approval step (if any) and bridge step (main step)
	// Relay sometimes returns 2 steps: [0]=approve (EVM), [1]=bridge/deposit
	approvalStepIdx := -1
	bridgeStepIdx := -1
	for i, s := range quote.Steps {
		if strings.EqualFold(s.ID, "approve") || strings.EqualFold(s.ID, "approval") {
			approvalStepIdx = i
		} else {
			bridgeStepIdx = i
		}
	}
	// Fallback: if no explicit approve step, use step[0] as bridge
	if bridgeStepIdx == -1 && len(quote.Steps) > 0 {
		bridgeStepIdx = 0
	}
	if bridgeStepIdx == -1 {
		log.Printf("    [relay] ❌ No bridge step in quote")
		return result, "", fmt.Errorf("no bridge step in quote")
	}

	bridgeStep := quote.Steps[bridgeStepIdx]
	hasSolanaInstructions := len(bridgeStep.Items) > 0 && len(bridgeStep.Items[0].Data.Instructions) > 0
	hasEVMTx := len(bridgeStep.Items) > 0 && bridgeStep.Items[0].Data.To != ""

	log.Printf("    [relay] ✅ Quote received: svcFee=$%.4f, gasFee=$%.4f, steps=%d (approve=%d, bridge=%d), hasSolanaInstructions=%v, hasEVMTx=%v, requestID=%s",
		svc, gas, len(quote.Steps), approvalStepIdx, bridgeStepIdx, hasSolanaInstructions, hasEVMTx, bridgeStep.RequestId)

	// Execute approval first if present (EVM only)
	if approvalStepIdx >= 0 {
		approveStep := quote.Steps[approvalStepIdx]
		if len(approveStep.Items) > 0 && approveStep.Items[0].Data.To != "" {
			item := approveStep.Items[0]
			log.Printf("    [relay] 📝 Sending approval TX to=%s", item.Data.To)
			approvalHash, err := e.txExecutor.ExecuteEVMTransaction(route.FromChain, item.Data.To, item.Data.Data, item.Data.Value)
			if err != nil {
				return result, "", fmt.Errorf("approval failed: %w", err)
			}
			log.Printf("    [relay] ✅ Approval TX sent: %s", approvalHash)
			log.Printf("    [relay] ⏳ Waiting for approval confirmation...")
			time.Sleep(5 * time.Second)
			success, err := e.txExecutor.CheckEVMTxStatus(route.FromChain, approvalHash)
			if err != nil || !success {
				return result, approvalHash, fmt.Errorf("approval not confirmed")
			}
			log.Printf("    [relay] ✅ Approval confirmed")
		}
	}

	// Execute bridge transaction
	execStart := time.Now()
	var txHash string

	if hasSolanaInstructions {
		item := bridgeStep.Items[0]
		log.Printf("    [relay] 📤 Building Solana TX from %d instructions", len(item.Data.Instructions))
		txHash, err = e.txExecutor.ExecuteSolanaFromInstructions(item.Data.Instructions, item.Data.AddressLookupTableAddresses)
	} else if hasEVMTx {
		item := bridgeStep.Items[0]
		log.Printf("    [relay] 📤 Broadcasting EVM TX to=%s, value=%s", item.Data.To, item.Data.Value)
		txHash, err = e.txExecutor.ExecuteEVMTransaction(route.FromChain, item.Data.To, item.Data.Data, item.Data.Value)
	} else {
		log.Printf("    [relay] ❌ No TX data in bridge step: steps=%d", len(quote.Steps))
		return result, "", fmt.Errorf("no transaction data in quote")
	}

	if err != nil {
		log.Printf("    [relay] ❌ Broadcast error: %v", err)
		return result, "", fmt.Errorf("broadcast failed: %w", err)
	}

	log.Printf("    [relay] ✅ TX broadcast: %s", txHash)

	// Poll status using request ID from the bridge step
	requestID := bridgeStep.RequestId
	if requestID == "" {
		log.Printf("    [relay] ❌ No requestID in bridge step")
		return result, txHash, fmt.Errorf("no requestID in quote response")
	}

	log.Printf("    [relay] ⏳ Polling status (requestID: %s, timeout: 5min)...", requestID)

	status, err := e.txExecutor.PollRelayStatus(requestID, 5*time.Minute)
	execEnd := time.Now()

	if err != nil {
		log.Printf("    [relay] ❌ Status poll error: %v", err)
		return result, txHash, fmt.Errorf("status poll failed: %w", err)
	}

	result.ExecutionLatencyMs = execEnd.Sub(execStart).Milliseconds()
	result.E2ELatencyMs = execEnd.Sub(quoteStart).Milliseconds()

	log.Printf("    [relay] 🏁 Final status: %s (exec: %dms, e2e: %dms)",
		status.Status, result.ExecutionLatencyMs, result.E2ELatencyMs)

	if status.Status == "filled" || status.Status == "settled" {
		result.Success = true
		result.ActualFeeUSD = result.QuoteFeeUSD
	} else if status.Status == "refunded" {
		result.Reverted = true
		log.Printf("    [relay] ⚠️ Transaction was refunded!")
	}

	return result, txHash, nil
}

// executeLiFi handles Li.Fi bridge execution
func (e *Executor) executeLiFi(route TestRoute, rawUnits string, quoteStart time.Time) (*ExecutionResult, string, error) {
	result := &ExecutionResult{Bridge: "lifi", Route: route}

	// Determine sender address based on source chain
	senderAddress := e.walletManager.EVMAddress
	receiverAddress := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		senderAddress = e.walletManager.SolanaAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = e.walletManager.SolanaAddress
	}

	log.Printf("    [lifi] Getting quote: %s → %s, rawUnits: %s, sender: %s", route.FromChain, route.ToChain, rawUnits, senderAddress[:8]+"...")

	// Get quote with TX
	quote, _, err := e.lifi.GetQuote(route, rawUnits, senderAddress, receiverAddress)
	if err != nil {
		log.Printf("    [lifi] ❌ Quote error: %v", err)
		return result, "", fmt.Errorf("quote failed: %w", err)
	}

	result.QuoteLatencyMs = time.Since(quoteStart).Milliseconds()
	for _, f := range quote.Estimate.FeeCosts {
		v, _ := strconv.ParseFloat(f.AmountUSD, 64)
		result.QuoteFeeUSD += v
	}
	if outUsd, err := strconv.ParseFloat(quote.Estimate.ToAmountUSD, 64); err == nil {
		result.OutputUSD = outUsd
	}

	// For Solana source: TX is base64 in transactionRequest.data, To will be empty
	// For EVM source: TX is in transactionRequest with To, Data, Value
	isSolanaTx := route.FromChain == "Solana" && quote.TransactionRequest.To == "" && quote.TransactionRequest.Data != ""
	isEVMTx := quote.TransactionRequest.To != ""
	needsApproval := quote.Estimate.ApprovalAddress != "" && isEVMTx

	log.Printf("    [lifi] ✅ Quote received: fee=$%.4f, tool=%s, isSolanaTx=%v, isEVMTx=%v, dataLen=%d, needsApproval=%v",
		result.QuoteFeeUSD, quote.Tool,
		isSolanaTx, isEVMTx, len(quote.TransactionRequest.Data), needsApproval,
	)

	// Step 1: Send ERC-20 approval if required
	if needsApproval {
		log.Printf("    [lifi] 📝 Sending ERC-20 approval to spender=%s for token=%s",
			quote.Estimate.ApprovalAddress, quote.Action.FromToken.Address)
		approvalHash, err := e.txExecutor.ApproveERC20(
			route.FromChain,
			quote.Action.FromToken.Address,
			quote.Estimate.ApprovalAddress,
			quote.Action.FromAmount,
		)
		if err != nil {
			log.Printf("    [lifi] ❌ Approval TX failed: %v", err)
			return result, "", fmt.Errorf("approval failed: %w", err)
		}
		log.Printf("    [lifi] ✅ Approval TX sent: %s", approvalHash)

		// Wait for approval to confirm
		log.Printf("    [lifi] ⏳ Waiting for approval confirmation...")
		time.Sleep(3 * time.Second)

		success, err := e.txExecutor.CheckEVMTxStatus(route.FromChain, approvalHash)
		if err != nil || !success {
			log.Printf("    [lifi] ❌ Approval TX failed to confirm")
			return result, approvalHash, fmt.Errorf("approval not confirmed")
		}
		log.Printf("    [lifi] ✅ Approval confirmed")
	}

	// Step 2: Execute bridge transaction
	execStart := time.Now()
	var txHash string

	if isSolanaTx {
		// Solana transaction - data field contains base64 serialized TX
		log.Printf("    [lifi] 📤 Broadcasting Solana TX (len=%d)", len(quote.TransactionRequest.Data))
		txHash, err = e.txExecutor.ExecuteSolanaTransaction(quote.TransactionRequest.Data)
	} else if isEVMTx {
		// EVM transaction
		log.Printf("    [lifi] 📤 Broadcasting EVM TX to=%s, value=%s, chainId=%d",
			quote.TransactionRequest.To, quote.TransactionRequest.Value, quote.TransactionRequest.ChainId)
		txHash, err = e.txExecutor.ExecuteEVMTransaction(
			route.FromChain,
			quote.TransactionRequest.To,
			quote.TransactionRequest.Data,
			quote.TransactionRequest.Value,
		)
	} else {
		log.Printf("    [lifi] ❌ No TX data in quote response (To=%s, DataLen=%d)", quote.TransactionRequest.To, len(quote.TransactionRequest.Data))
		return result, "", fmt.Errorf("no transaction data in quote")
	}

	if err != nil {
		log.Printf("    [lifi] ❌ Broadcast error: %v", err)
		return result, "", fmt.Errorf("broadcast failed: %w", err)
	}

	log.Printf("    [lifi] ✅ TX broadcast: %s", txHash)

	// Poll status
	fromChain := lifiChainID(route.FromChain)
	toChain := lifiChainID(route.ToChain)
	log.Printf("    [lifi] ⏳ Polling status (fromChain: %s, toChain: %s, timeout: 5min)...", fromChain, toChain)

	status, err := e.txExecutor.PollLiFiStatus(txHash, fromChain, toChain, 5*time.Minute)
	execEnd := time.Now()

	if err != nil {
		log.Printf("    [lifi] ❌ Status poll error: %v", err)
		return result, txHash, fmt.Errorf("status poll failed: %w", err)
	}

	result.ExecutionLatencyMs = execEnd.Sub(execStart).Milliseconds()
	result.E2ELatencyMs = execEnd.Sub(quoteStart).Milliseconds()

	log.Printf("    [lifi] 🏁 Final status: %s (exec: %dms, e2e: %dms)",
		status.Status, result.ExecutionLatencyMs, result.E2ELatencyMs)

	if status.Status == "filled" || status.Status == "settled" {
		result.Success = true
		result.ActualFeeUSD = result.QuoteFeeUSD
	} else if status.Status == "refunded" || status.Status == "failed" {
		result.Reverted = true
		log.Printf("    [lifi] ⚠️ Transaction was refunded/failed!")
	}

	return result, txHash, nil
}

// recordExecutionMetrics records the execution results to Prometheus
func (e *Executor) recordExecutionMetrics(result *ExecutionResult) {
	amountStr := strconv.FormatFloat(result.AmountUSD, 'f', 0, 64)
	labels := []string{
		result.Bridge,
		result.Route.FromChain,
		result.Route.ToChain,
		result.Route.FromToken,
		result.Route.ToToken,
		amountStr,
		e.region,
		// chain dimension label, same convention as every quote path
		// (mobula_bridge.go etc). This 8th label was missed when the
		// metrics gained the chain dimension, and because execution was
		// paused in prod the mismatch only surfaced at the first real
		// single-test (panic: inconsistent label cardinality).
		result.Route.ToChain,
	}

	// Record latencies
	bridgeQuoteLatency.WithLabelValues(labels...).Observe(float64(result.QuoteLatencyMs))
	bridgeExecutionLatency.WithLabelValues(labels...).Observe(float64(result.ExecutionLatencyMs))
	bridgeE2ELatency.WithLabelValues(labels...).Observe(float64(result.E2ELatencyMs))

	// Record success/revert + consecutive-failure streak (used for paging alerts).
	if result.Success {
		bridgeSuccess.WithLabelValues(labels...).Inc()
		bridgeConsecutiveFailures.WithLabelValues(result.Bridge, e.region).Set(0)
	}
	if result.Reverted {
		bridgeReverts.WithLabelValues(labels...).Inc()
		bridgeConsecutiveFailures.WithLabelValues(result.Bridge, e.region).Inc()
	}
	if result.Error != nil {
		bridgeErrors.WithLabelValues(append(labels, "execution_failed")...).Inc()
		if !result.Reverted {
			bridgeConsecutiveFailures.WithLabelValues(result.Bridge, e.region).Inc()
		}
	}

	// Record fees
	bridgeFeesUSD.WithLabelValues(labels...).Set(result.ActualFeeUSD)
	if result.AmountUSD > 0 {
		bridgeFeesPercent.WithLabelValues(labels...).Set((result.ActualFeeUSD / result.AmountUSD) * 100)
	}
}

// getSourceTokenName returns the source token name for balance checking (legacy - fallback)
func getSourceTokenName(route TestRoute) string {
	switch route.Name {
	case "TRUMP_SOL_BRETT_BASE":
		return "TRUMP"
	case "USDT_ARB_USDC_SOL":
		return "USDT"
	default:
		return "USDC"
	}
}

// getAvailableBalance looks up balance first by contract address (robust against symbol mismatch
// like USDT vs USDT0), then falls back to symbol name.
func getAvailableBalance(balances map[string]map[string]float64, route TestRoute) float64 {
	chainBalances := balances[route.FromChain]
	if chainBalances == nil {
		return 0
	}
	// Try by contract address first (case-insensitive)
	if bal, ok := chainBalances[strings.ToLower(route.FromToken)]; ok {
		return bal
	}
	// Fallback to symbol-based lookup
	return chainBalances[getSourceTokenName(route)]
}

// testBridgeDryRun simulates a single bridge test
func (e *Executor) testBridgeDryRun(bridge string, route TestRoute, amountUSD float64) {
	log.Printf("    [%s] Simulating $%.0f %s...", bridge, amountUSD, route.Name)

	// Calculate raw units - for USDC/USDT amount equals USD, for TRUMP convert
	amount := amountUSD
	if route.Name == "TRUMP_SOL_BRETT_BASE" {
		amount = amountUSD / TokenPriceUSD("TRUMP", 2.55) // live TRUMP price (5min cache)
	}
	rawUnits := toRawUnits(amount)

	// Determine sender address based on source chain
	senderAddress := e.walletManager.EVMAddress
	receiverAddress := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		senderAddress = e.walletManager.SolanaAddress
	}
	if route.ToChain == "Solana" {
		receiverAddress = e.walletManager.SolanaAddress
	}

	// Get quote
	quoteStart := time.Now()
	var quoteFee float64
	var quoteErr error
	var estimatedTimeMs int64

	switch bridge {
	case "mobula":
		quote, _, err := e.mobula.GetQuote(
			route.FromChainAPI, route.FromToken,
			route.ToChainAPI, route.ToToken,
			senderAddress, receiverAddress,
			amount,
		)
		if err != nil {
			quoteErr = err
		} else {
			quoteFee, _ = strconv.ParseFloat(quote.Data.Fees.TotalFeeUsd, 64)
			estimatedTimeMs = quote.Data.EstimatedTimeMs
		}

	case "relay":
		quote, _, err := e.relay.GetQuote(route, rawUnits, senderAddress, receiverAddress)
		if err != nil {
			quoteErr = err
		} else {
			// Parse relay fees
			svc, _ := strconv.ParseFloat(quote.Fees.RelayerService.AmountUsd, 64)
			gas, _ := strconv.ParseFloat(quote.Fees.RelayerGas.AmountUsd, 64)
			quoteFee = svc + gas
			estimatedTimeMs = int64(quote.Details.TimeEstimate * 1000)
		}

	case "lifi":
		quote, _, err := e.lifi.GetQuote(route, rawUnits, senderAddress, receiverAddress)
		if err != nil {
			quoteErr = err
		} else {
			for _, f := range quote.Estimate.FeeCosts {
				v, _ := strconv.ParseFloat(f.AmountUSD, 64)
				quoteFee += v
			}
			estimatedTimeMs = int64(quote.Estimate.ExecutionDuration * 1000)
		}

	case "debridge":
		quote, _, err := e.debridge.GetQuote(route, rawUnits)
		if err != nil {
			quoteErr = err
		} else {
			quoteFee = debridgeFixFeeUSD(route.FromChain) + quote.ProtocolFeeApproximateUsdValue
			estimatedTimeMs = quote.Order.ApproximateFulfillmentDelay * 1000
		}
	}

	quoteLatency := time.Since(quoteStart)

	if quoteErr != nil {
		log.Printf("      ❌ Quote failed: %v", quoteErr)
		return
	}

	log.Printf("      ✅ Quote: %dms | Fee: $%.4f | Est: %dms", quoteLatency.Milliseconds(), quoteFee, estimatedTimeMs)

	// In dry-run mode, we simulate the execution
	log.Printf("      🔸 [DRY-RUN] Would broadcast TX here")
	log.Printf("      🔸 [DRY-RUN] Would poll status until completion")
	log.Printf("      🔸 [DRY-RUN] Would record execution latency")

	// Simulate expected cost
	expectedCost := quoteFee + 0.10 // Add estimated gas
	log.Printf("      💰 Estimated cost: $%.4f", expectedCost)

	// Update daily spending tracker (even in dry-run for estimation)
	e.AddDailySpend(expectedCost)
	log.Printf("      📈 Daily spend estimate: $%.2f / $%.2f max", e.DailySpent(), e.config.MaxDailySpendUSD)
}

// ValidateSetup checks that everything is configured correctly
func (e *Executor) ValidateSetup() error {
	log.Println("🔍 Validating execution setup...")

	// Check wallet configuration
	if e.walletManager == nil {
		return fmt.Errorf("wallet manager not configured")
	}

	if e.walletManager.EVMAddress == "" {
		return fmt.Errorf("EVM wallet address not configured")
	}
	log.Printf("  ✅ EVM Address: %s", e.walletManager.EVMAddress)

	if e.walletManager.SolanaAddress == "" {
		return fmt.Errorf("Solana wallet address not configured")
	}
	log.Printf("  ✅ Solana Address: %s", e.walletManager.SolanaAddress)

	// Check balance checker
	if e.balanceCheck == nil {
		return fmt.Errorf("balance checker not configured")
	}

	// Verify we can fetch balances
	balances, err := e.balanceCheck.GetAllBalances()
	if err != nil {
		return fmt.Errorf("cannot fetch balances: %w", err)
	}

	// Log all balances
	totalUSD := 0.0
	for chain, tokens := range balances {
		for token, bal := range tokens {
			log.Printf("  💰 %s/%s: $%.2f", chain, token, bal)
			totalUSD += bal
		}
	}
	log.Printf("  📊 Total portfolio: $%.2f", totalUSD)

	// Check execution config
	log.Printf("  ⚙️  Mode: %s", e.config.Mode)
	log.Printf("  ⚙️  $5 frequency: %v", e.config.Freq5USD)
	log.Printf("  ⚙️  $50 frequency: %v", e.config.Freq50USD)
	log.Printf("  ⚙️  $300 frequency: %v", e.config.Freq300USD)
	log.Printf("  ⚙️  Debridge execution: %v", e.config.EnableDebridge)
	log.Printf("  ⚙️  Max daily spend: $%.2f", e.config.MaxDailySpendUSD)

	log.Println("✅ Setup validation complete")
	return nil
}

// EstimateMonthlyCost calculates expected monthly costs
func (e *Executor) EstimateMonthlyCost() {
	log.Println("💰 Estimating monthly costs...")

	// Costs per execution (from analysis). $300 is the new "large ticket" tier
	// (down from $500 — capital constraint on current wallet, see README).
	costPer5 := 1.55 // M/R/L combined for 3 routes
	costPer50 := 2.85
	costPer300 := 9.02 // ~$3.01/cycle × 3 bridges = 9 TX

	if e.config.EnableDebridge {
		costPer5 += 8.30
		costPer50 += 8.95
		costPer300 += 11.00
	}

	// Calculate monthly executions based on frequency
	daysInMonth := 30.0

	exec5PerMonth := (24 * daysInMonth) / e.config.Freq5USD.Hours()
	exec50PerMonth := (24 * daysInMonth) / e.config.Freq50USD.Hours()
	exec300PerMonth := (24 * daysInMonth) / e.config.Freq300USD.Hours()

	cost5 := exec5PerMonth * costPer5
	cost50 := exec50PerMonth * costPer50
	cost300 := exec300PerMonth * costPer300

	totalMonthly := cost5 + cost50 + cost300

	log.Printf("  $5 tests:   %.0f/month × $%.2f = $%.2f", exec5PerMonth, costPer5, cost5)
	log.Printf("  $50 tests:  %.0f/month × $%.2f = $%.2f", exec50PerMonth, costPer50, cost50)
	log.Printf("  $300 tests: %.0f/month × $%.2f = $%.2f", exec300PerMonth, costPer300, cost300)
	log.Printf("  ─────────────────────────────────")
	log.Printf("  TOTAL:      $%.2f/month", totalMonthly)

	// Estimate duration with current capital
	balances, _ := e.balanceCheck.GetAllBalances()
	totalCapital := 0.0
	for _, tokens := range balances {
		for _, bal := range tokens {
			totalCapital += bal
		}
	}

	if totalMonthly > 0 {
		months := totalCapital / totalMonthly
		log.Printf("  ⏱️  Estimated duration: %.1f months with $%.0f capital", months, totalCapital)
	}
}

// PrintExecutionPlan shows what will be executed
func (e *Executor) PrintExecutionPlan() {
	plan := map[string]interface{}{
		"mode":             e.config.Mode,
		"freq_5_usd":       e.config.Freq5USD.String(),
		"freq_50_usd":      e.config.Freq50USD.String(),
		"freq_300_usd":     e.config.Freq300USD.String(),
		"enable_debridge":  e.config.EnableDebridge,
		"max_daily_spend":  e.config.MaxDailySpendUSD,
		"evm_address":      e.walletManager.EVMAddress,
		"solana_address":   e.walletManager.SolanaAddress,
	}

	planJSON, _ := json.MarshalIndent(plan, "", "  ")
	log.Printf("📋 Execution Plan:\n%s", string(planJSON))
}
