package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// Gas auto-top-up: before each execution slot, check native gas (SOL / Base ETH /
// Arb ETH) against a USD floor. When below, swap on-chain stablecoins into native
// gas via LI.FI same-chain swap (fromChain == toChain, same calldata shape as a
// bridge quote). Enabled by default; the tier guard is the safety mechanism.

const (
	lifiEVMNative    = "0x0000000000000000000000000000000000000000"
	lifiSolanaNative = "11111111111111111111111111111111"
)

// gasTierSafeBuffer: keep 20 % above tier after gas swap so the triangle is
// never starved by a top-up (covers swap slippage + next leg's fee buffer).
const gasTierSafeBuffer = 1.20

// gasMinMeaningfulUSD: minimum swap amount; below this the LI.FI fee + approval
// gas consume the benefit.
const gasMinMeaningfulUSD = 5.0

type gasChain struct {
	Chain string
	NativeSym string
	// PrimaryStable is the stablecoin sold first for gas (contract address).
	PrimaryStable string
	// FallbackStable is used when Primary has no balance (e.g. Arb USDC = $0
	// on this wallet but Arb USDT = $74; tier guard still applies).
	FallbackStable string
	FallbackSymbol string
}

var gasChains = []gasChain{
	{Chain: "Solana", NativeSym: "SOL", PrimaryStable: solanaUSDCMint},
	{Chain: "Base", NativeSym: "ETH", PrimaryStable: baseUSDCAddr},
	// Arb USDC may be $0 on this wallet; fall back to USDT so an ETH shortage
	// still has a funding source. The tier guard prevents over-draw.
	{Chain: "Arbitrum", NativeSym: "ETH", PrimaryStable: arbUSDCAddr,
		FallbackStable: arbUSDTAddr, FallbackSymbol: "USDT"},
}

// GasTopper checks and replenishes native gas before each execution slot.
type GasTopper struct {
	executor *Executor
	slack    *SlackNotifier

	enabled  bool
	minUSD   float64 // alert + topup when gas falls below this
	topupUSD float64 // target gas value to restore per chain

	// Per-chain USD swapped today; resets on UTC day change. Caps a runaway
	// price-feed glitch to one top-up per chain per day.
	spentToday map[string]float64
	day        int
}

// NewGasTopper creates a GasTopper. Enabled by default — the tier guard (not an
// env flag) is the principled safety mechanism. Set GAS_TOPUP_ENABLED=false to
// force alert-only mode (manual control or audit).
func NewGasTopper(executor *Executor, slack *SlackNotifier) *GasTopper {
	if executor == nil {
		return nil
	}
	enabled := true
	if v := strings.TrimSpace(os.Getenv("GAS_TOPUP_ENABLED")); v != "" {
		enabled = strings.EqualFold(v, "true")
	}
	return &GasTopper{
		executor:   executor,
		slack:      slack,
		enabled:    enabled,
		minUSD:     parseFloat(os.Getenv("GAS_MIN_USD"), 15),
		topupUSD:   parseFloat(os.Getenv("GAS_TOPUP_USD"), 25),
		spentToday: make(map[string]float64),
		day:        time.Now().UTC().YearDay(),
	}
}

// stableForTopup selects the stablecoin contract address and USD balance to sell
// for gas. Tries the primary address first, falls back to the secondary when
// primary has no balance (e.g. Arb USDC = $0 but Arb USDT = $74).
func stableForTopup(balances map[string]map[string]float64, gc gasChain) (addr string, usd float64) {
	chain := balances[gc.Chain]
	if chain == nil {
		return "", 0
	}
	if v := chain[gc.PrimaryStable]; v > 0 {
		return gc.PrimaryStable, v
	}
	if gc.FallbackStable != "" {
		if v := chain[gc.FallbackStable]; v > 0 {
			return gc.FallbackStable, v
		}
	}
	return "", 0
}

// CheckAndTopUp inspects native gas on every triangle chain and tops up where
// needed, subject to the tier guard.
//
// The tier guard ensures a gas swap never reduces the source leg's stablecoin
// balance below (tier x gasTierSafeBuffer), so the triangle can always run at
// the current tier even after a top-up.
//
// Call this at every rung of the downgrade ladder: the guard uses the rung's
// amount, so a rung blocked at $300 may have enough headroom at $50 or $5.
//
// Returns true when every chain has gas at or above the floor. Returns false
// when at least one chain is gas-blocked and could not be resolved.
func (g *GasTopper) CheckAndTopUp(balances map[string]map[string]float64, tier float64) bool {
	if g == nil {
		return true
	}

	if today := time.Now().UTC().YearDay(); today != g.day {
		g.day = today
		g.spentToday = make(map[string]float64)
	}

	allOK := true

	for _, gc := range gasChains {
		gasUSD := balances[gc.Chain][gc.NativeSym]
		if gasUSD >= g.minUSD {
			continue
		}

		log.Printf("⛽ Low gas on %s: $%.2f %s (floor $%.2f)", gc.Chain, gasUSD, gc.NativeSym, g.minUSD)

		stableAddr, stableUSD := stableForTopup(balances, gc)
		if stableAddr == "" {
			allOK = false
			bridgeGasTopup.WithLabelValues(gc.Chain, "gated").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "gated", fmt.Sprintf(
				"Gas $%.2f on %s — no stablecoin balance found to swap. Top up %s manually.",
				gasUSD, gc.Chain, gc.NativeSym))
			continue
		}

		// Tier guard: never reduce stablecoins below (tier x buffer).
		mustKeep := tier * gasTierSafeBuffer
		canDivert := stableUSD - mustKeep
		if canDivert < gasMinMeaningfulUSD {
			allOK = false
			bridgeGasTopup.WithLabelValues(gc.Chain, "gated").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "gated", fmt.Sprintf(
				"Gas $%.2f on %s, stable $%.2f — must keep $%.2f (tier $%.0f x %.0f%% buffer). "+
					"Only $%.2f divertible, below $%.2f minimum. Top up %s manually.",
				gasUSD, gc.Chain, stableUSD, mustKeep, tier, gasTierSafeBuffer*100,
				canDivert, gasMinMeaningfulUSD, gc.NativeSym))
			continue
		}

		if !g.enabled {
			allOK = false
			bridgeGasTopup.WithLabelValues(gc.Chain, "gated").Inc()
			swapAmt := g.topupUSD
			if canDivert < swapAmt {
				swapAmt = canDivert
			}
			_ = g.slack.NotifyGasTopUp(gc.Chain, "gated", fmt.Sprintf(
				"Gas $%.2f on %s — would swap $%.2f -> %s but GAS_TOPUP_ENABLED=false.",
				gasUSD, gc.Chain, swapAmt, gc.NativeSym))
			continue
		}

		if g.executor.txExecutor == nil || !g.executor.txExecutor.CanExecute() {
			continue
		}

		if g.spentToday[gc.Chain] >= g.topupUSD {
			allOK = false
			bridgeGasTopup.WithLabelValues(gc.Chain, "capped").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "capped", fmt.Sprintf(
				"Gas $%.2f on %s — today's top-up cap ($%.2f) is fully spent.",
				gasUSD, gc.Chain, g.topupUSD))
			continue
		}

		if spent := g.executor.DailySpent(); spent >= g.executor.config.MaxDailySpendUSD {
			allOK = false
			bridgeGasTopup.WithLabelValues(gc.Chain, "capped").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "capped", fmt.Sprintf(
				"Gas $%.2f on %s — daily spend limit reached ($%.2f / $%.2f).",
				gasUSD, gc.Chain, spent, g.executor.config.MaxDailySpendUSD))
			continue
		}

		remaining := g.topupUSD - g.spentToday[gc.Chain]
		amount := canDivert
		if remaining < amount {
			amount = remaining
		}

		if !g.topUpChain(gc, stableAddr, amount, gasUSD) {
			allOK = false
		}
	}

	return allOK
}

// topUpChain swaps amountUSD of stableAddr into native gas on one chain.
// Returns true on confirmed success.
func (g *GasTopper) topUpChain(gc gasChain, stableAddr string, amountUSD, gasUSD float64) bool {
	bridgeGasTopup.WithLabelValues(gc.Chain, "attempted").Inc()

	toToken := lifiEVMNative
	sender := g.executor.walletManager.EVMAddress
	if gc.Chain == "Solana" {
		toToken = lifiSolanaNative
		sender = g.executor.walletManager.SolanaAddress
	}

	route := TestRoute{
		Name:         fmt.Sprintf("GAS_TOPUP_%s", strings.ToUpper(gc.Chain)),
		FromChain:    gc.Chain,
		FromChainAPI: chainAPIFor(gc.Chain),
		FromToken:    stableAddr,
		ToChain:      gc.Chain,
		ToChainAPI:   chainAPIFor(gc.Chain),
		ToToken:      toToken,
		IsSolanaSrc:  gc.Chain == "Solana",
	}
	rawUnits := toRawUnits(amountUSD)

	quote, _, err := g.executor.lifi.GetQuote(route, rawUnits, sender, sender)
	if err != nil {
		bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
		_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf(
			"LI.FI same-chain quote failed (gas $%.2f, wanted $%.2f -> %s): %v",
			gasUSD, amountUSD, gc.NativeSym, err))
		return false
	}

	// EVM ERC-20 inputs need router approval first.
	if quote.Estimate.ApprovalAddress != "" && gc.Chain != "Solana" {
		approvalHash, err := g.executor.txExecutor.ApproveERC20(
			gc.Chain, quote.Action.FromToken.Address, quote.Estimate.ApprovalAddress, quote.Action.FromAmount)
		if err != nil {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf("Approval failed: %v", err))
			return false
		}
		time.Sleep(5 * time.Second)
		if ok, err := g.executor.txExecutor.CheckEVMTxStatus(gc.Chain, approvalHash); err != nil || !ok {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			g.executor.AddDailySpend(failedTxFeeEstimateUSD())
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", "Approval TX not confirmed")
			return false
		}
	}

	var txHash string
	if gc.Chain == "Solana" {
		txHash, err = g.executor.txExecutor.ExecuteSolanaTransaction(quote.TransactionRequest.Data)
	} else {
		txHash, err = g.executor.txExecutor.ExecuteEVMTransaction(
			gc.Chain, quote.TransactionRequest.To, quote.TransactionRequest.Data, quote.TransactionRequest.Value)
	}
	if err != nil {
		bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
		_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf("Broadcast failed: %v", err))
		return false
	}

	// Same-chain swaps settle in one TX: confirmed receipt = done.
	// Solana: broadcast acceptance is the signal.
	if gc.Chain != "Solana" {
		time.Sleep(8 * time.Second)
		if ok, err := g.executor.txExecutor.CheckEVMTxStatus(gc.Chain, txHash); err != nil || !ok {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			g.executor.AddDailySpend(failedTxFeeEstimateUSD())
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf(
				"Swap TX unconfirmed or reverted: %s", txHash))
			return false
		}
	}

	g.spentToday[gc.Chain] += amountUSD
	fee := 0.0
	for _, f := range quote.Estimate.FeeCosts {
		fee += parseFloatOrZero(f.AmountUSD)
	}
	g.executor.AddDailySpend(fee)
	bridgeGasTopup.WithLabelValues(gc.Chain, "succeeded").Inc()
	_ = g.slack.NotifyGasTopUp(gc.Chain, "succeeded", fmt.Sprintf(
		"Swapped $%.2f -> %s on %s (was $%.2f gas, fee $%.4f, tx %s). Day: $%.2f / $%.2f.",
		amountUSD, gc.NativeSym, gc.Chain, gasUSD, fee, txHash,
		g.spentToday[gc.Chain], g.topupUSD))
	return true
}
