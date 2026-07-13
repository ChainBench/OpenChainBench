package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// Gas auto-top-up: an execution slot can fail for the dumbest possible reason,
// no native gas to sign the deposit TX. Pre-flight already fetches balances,
// so we check SOL / Base ETH / Arb ETH against a USD floor and, when allowed,
// swap wallet USDC into native gas on that same chain via a LI.FI same-chain
// swap (their /v1/quote accepts fromChain == toChain and returns broadcastable
// calldata, same shape as a bridge quote).
//
// SAFETY GATE: GAS_TOPUP_ENABLED defaults to false. The plumbing below reuses
// the proven LiFi execution path, but the same-chain variant has not been
// exercised with real funds from this harness yet. Until someone runs one
// supervised top-up per chain and flips the env var, low gas only alerts.

// LiFi native-token markers.
const (
	lifiEVMNative    = "0x0000000000000000000000000000000000000000"
	lifiSolanaNative = "11111111111111111111111111111111"
)

type gasChain struct {
	Chain      string
	NativeSym  string
	USDCSource string
}

var gasChains = []gasChain{
	{Chain: "Solana", NativeSym: "SOL", USDCSource: solanaUSDCMint},
	{Chain: "Base", NativeSym: "ETH", USDCSource: baseUSDCAddr},
	{Chain: "Arbitrum", NativeSym: "ETH", USDCSource: arbUSDCAddr},
}

type GasTopper struct {
	executor *Executor
	slack    *SlackNotifier

	enabled  bool
	minUSD   float64
	topupUSD float64

	// Per-chain USD swapped today; resets on UTC day change. Caps a runaway
	// price-feed glitch to one top-up per chain per day.
	spentToday map[string]float64
	day        int
}

func NewGasTopper(executor *Executor, slack *SlackNotifier) *GasTopper {
	if executor == nil {
		return nil
	}
	return &GasTopper{
		executor:   executor,
		slack:      slack,
		enabled:    strings.EqualFold(strings.TrimSpace(os.Getenv("GAS_TOPUP_ENABLED")), "true"),
		minUSD:     parseFloat(os.Getenv("GAS_MIN_USD"), 15),
		topupUSD:   parseFloat(os.Getenv("GAS_TOPUP_USD"), 25),
		spentToday: make(map[string]float64),
		day:        time.Now().UTC().YearDay(),
	}
}

// CheckAndTopUp inspects native gas on each chain and tops up where needed.
// Called from tier pre-flight with balances the caller already validated as
// non-degraded: a phantom zero here would otherwise trigger a pointless swap.
func (g *GasTopper) CheckAndTopUp(balances map[string]map[string]float64) {
	if g == nil {
		return
	}

	if today := time.Now().UTC().YearDay(); today != g.day {
		g.day = today
		g.spentToday = make(map[string]float64)
	}

	for _, gc := range gasChains {
		gasUSD := balances[gc.Chain][gc.NativeSym]
		if gasUSD >= g.minUSD {
			continue
		}
		log.Printf("⛽ Low gas on %s: $%.2f %s (floor $%.2f)", gc.Chain, gasUSD, gc.NativeSym, g.minUSD)

		if !g.enabled {
			bridgeGasTopup.WithLabelValues(gc.Chain, "gated").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "gated", fmt.Sprintf(
				"Native gas is $%.2f, below the $%.2f floor, but GAS_TOPUP_ENABLED is off. Top up manually or enable after a supervised test.",
				gasUSD, g.minUSD))
			continue
		}
		if g.executor.txExecutor == nil || !g.executor.txExecutor.CanExecute() {
			// Dry-run or missing keys: detection is still useful in logs, but
			// there is nothing safe to broadcast.
			continue
		}
		if g.spentToday[gc.Chain] >= g.topupUSD {
			bridgeGasTopup.WithLabelValues(gc.Chain, "capped").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "capped", fmt.Sprintf(
				"Native gas is $%.2f but today's top-up budget ($%.2f) is already spent.", gasUSD, g.topupUSD))
			continue
		}

		amount := g.topupUSD - g.spentToday[gc.Chain]
		if amount > g.topupUSD {
			amount = g.topupUSD
		}
		g.topUpChain(gc, amount, gasUSD)
	}
}

// topUpChain swaps `amountUSD` of USDC into native gas on one chain.
func (g *GasTopper) topUpChain(gc gasChain, amountUSD, gasUSD float64) {
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
		FromToken:    gc.USDCSource,
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
			"LI.FI same-chain swap quote failed (gas $%.2f, wanted $%.2f USDC to %s): %v", gasUSD, amountUSD, gc.NativeSym, err))
		return
	}

	// EVM swaps of ERC-20 input need the router approved first, same as bridges.
	if quote.Estimate.ApprovalAddress != "" && gc.Chain != "Solana" {
		approvalHash, err := g.executor.txExecutor.ApproveERC20(gc.Chain, quote.Action.FromToken.Address, quote.Estimate.ApprovalAddress, quote.Action.FromAmount)
		if err != nil {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf("USDC approval failed: %v", err))
			return
		}
		time.Sleep(5 * time.Second)
		if ok, err := g.executor.txExecutor.CheckEVMTxStatus(gc.Chain, approvalHash); err != nil || !ok {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", "USDC approval not confirmed")
			return
		}
	}

	var txHash string
	if gc.Chain == "Solana" {
		txHash, err = g.executor.txExecutor.ExecuteSolanaTransaction(quote.TransactionRequest.Data)
	} else {
		txHash, err = g.executor.txExecutor.ExecuteEVMTransaction(gc.Chain, quote.TransactionRequest.To, quote.TransactionRequest.Data, quote.TransactionRequest.Value)
	}
	if err != nil {
		bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
		_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf("Broadcast failed: %v", err))
		return
	}

	// Same-chain swaps settle in one TX: a confirmed receipt is a fill, no
	// bridge status polling needed. Solana broadcast acceptance is our signal.
	if gc.Chain != "Solana" {
		time.Sleep(8 * time.Second)
		if ok, err := g.executor.txExecutor.CheckEVMTxStatus(gc.Chain, txHash); err != nil || !ok {
			bridgeGasTopup.WithLabelValues(gc.Chain, "failed").Inc()
			_ = g.slack.NotifyGasTopUp(gc.Chain, "failed", fmt.Sprintf("Swap TX not confirmed or reverted: %s", txHash))
			return
		}
	}

	g.spentToday[gc.Chain] += amountUSD
	fee := 0.0
	for _, f := range quote.Estimate.FeeCosts {
		fee += parseFloatOrZero(f.AmountUSD)
	}
	g.executor.config.DailySpentUSD += fee
	bridgeGasTopup.WithLabelValues(gc.Chain, "succeeded").Inc()
	_ = g.slack.NotifyGasTopUp(gc.Chain, "succeeded", fmt.Sprintf(
		"Swapped $%.2f USDC to %s (was $%.2f, fee $%.4f, tx %s). Daily budget used: $%.2f / $%.2f.",
		amountUSD, gc.NativeSym, gasUSD, fee, txHash, g.spentToday[gc.Chain], g.topupUSD))
}
