package main

import (
	"fmt"
	"log"
	"strings"
	"time"
)

// Auto-rebalancer: when the pre-flight cycle simulation says a tier cannot run
// because one leg is short, move the shortfall from the leg holding excess
// inventory instead of waiting for a human. Reuses the executor's quote and
// broadcast plumbing so a rebalance transfer is measured and notified exactly
// like a benchmark execution. cmd/rebalance stays as the manual fallback.

const (
	// Two corrective transfers per SCHEDULER SLOT, shared across every rung
	// of the downgrade ladder. One transfer plus one retry covers transient
	// pre-broadcast failures without letting a broken bridge drain the daily
	// budget. Before this was per rung, a single $300 slot could broadcast
	// up to six transfers back to back.
	maxCorrectiveTransfersPerSlot = 2

	// Move 10 percent more than the computed shortfall so bridge fees and
	// slippage on the transfer itself do not leave the leg short again.
	rebalanceBufferFactor = 1.10
)

// slotBudget caps corrective transfers for one scheduler slot. A single
// instance is created per slot and threaded through every ladder rung.
type slotBudget struct {
	remaining int
	// inFlight marks that a corrective transfer broadcast a TX whose bridge
	// status never resolved. The funds are most likely still moving (legit
	// fills can take 2-5 minutes, longer than our status polling), so any
	// rung that needs the same destination leg must stand down for the rest
	// of the slot instead of double-sending.
	inFlight      bool
	inFlightChain string
}

func newSlotBudget() *slotBudget {
	return &slotBudget{remaining: maxCorrectiveTransfersPerSlot}
}

// blockedByInFlight reports whether a rung needing refillChain must stand
// down because an earlier transfer to that leg is still unresolved.
func (b *slotBudget) blockedByInFlight(refillChain string) bool {
	return b != nil && b.inFlight && strings.EqualFold(b.inFlightChain, refillChain)
}

// correctiveOutcome classifies a corrective transfer attempt for retry logic.
type correctiveOutcome int

const (
	// outcomePreBroadcast: nothing left the wallet (quote failed, approval
	// failed to broadcast, insufficient funds). Safe to consume another
	// attempt from the slot budget.
	outcomePreBroadcast correctiveOutcome = iota
	// outcomeInFlight: a TX was broadcast but the attempt did not confirm as
	// a success. The deposit may well have confirmed with the bridge fill
	// still pending, so the funds must be assumed to be in flight. TERMINAL
	// for the slot: retrying here is exactly how a double-send happens.
	outcomeInFlight
	// outcomeSuccess: the transfer confirmed end to end.
	outcomeSuccess
)

// classifyCorrectiveResult decides whether a corrective transfer attempt may
// be retried. Anything that produced a TxHash moved, or may have moved, real
// funds and is terminal. Only failures that provably never broadcast are
// safe to retry.
func classifyCorrectiveResult(result *ExecutionResult) correctiveOutcome {
	if result == nil {
		return outcomePreBroadcast
	}
	if result.Success {
		return outcomeSuccess
	}
	if result.TxHash != "" {
		return outcomeInFlight
	}
	return outcomePreBroadcast
}

// legSpec describes one home leg of the USDC triangle.
type legSpec struct {
	Chain     string
	ChainAPI  string
	Token     string
	TokenAddr string
}

// The triangle's expected inventory distribution. Order matches R1, R2, R3.
var triangleLegs = []legSpec{
	{Chain: "Solana", ChainAPI: "solana:solana", Token: "USDC", TokenAddr: solanaUSDCMint},
	{Chain: "Base", ChainAPI: "evm:8453", Token: "USDC", TokenAddr: baseUSDCAddr},
	{Chain: "Arbitrum", ChainAPI: "evm:42161", Token: "USDT", TokenAddr: arbUSDTAddr},
}

func findLeg(chain string) (legSpec, bool) {
	for _, leg := range triangleLegs {
		if strings.EqualFold(leg.Chain, chain) {
			return leg, true
		}
	}
	return legSpec{}, false
}

// legBalanceUSD looks up a leg's balance by contract address first (robust
// against symbol drift like USDT vs USDT0 in Mobula's DB), then by symbol.
func legBalanceUSD(balances map[string]map[string]float64, leg legSpec) float64 {
	chain := balances[leg.Chain]
	if chain == nil {
		return 0
	}
	if v, ok := chain[strings.ToLower(leg.TokenAddr)]; ok {
		return v
	}
	if v, ok := chain[leg.Token]; ok {
		return v
	}
	if leg.Token == "USDT" {
		if v, ok := chain["USDT0"]; ok {
			return v
		}
	}
	return 0
}

// BuildRefillRoute turns a failed CycleSimulation into a corrective TestRoute.
// The source leg is the triangle leg holding the largest surplus above its own
// 1x tier requirement: taking from anywhere else would just move the blockage.
// The amount is the shortfall plus the fee buffer, never more, so a rebalance
// cannot silently drain a healthy leg. Pure function, unit-tested.
func BuildRefillRoute(sim CycleSimulation, balances map[string]map[string]float64) (TestRoute, float64, error) {
	if sim.Viable {
		return TestRoute{}, 0, fmt.Errorf("cycle already viable, nothing to rebalance")
	}
	if sim.RefillUSD <= 0 {
		return TestRoute{}, 0, fmt.Errorf("simulation has no refill amount")
	}
	dest, ok := findLeg(sim.RefillChain)
	if !ok {
		return TestRoute{}, 0, fmt.Errorf("unknown refill chain %q", sim.RefillChain)
	}

	var source legSpec
	bestSurplus := 0.0
	for _, leg := range triangleLegs {
		if leg.Chain == dest.Chain {
			continue
		}
		surplus := legBalanceUSD(balances, leg) - sim.Tier
		if surplus > bestSurplus {
			source = leg
			bestSurplus = surplus
		}
	}
	if bestSurplus <= 0 {
		return TestRoute{}, 0, fmt.Errorf("no leg holds excess inventory above its own $%.0f tier need", sim.Tier)
	}
	if bestSurplus < sim.RefillUSD {
		return TestRoute{}, 0, fmt.Errorf("no leg holds enough excess: need $%.2f, best surplus is $%.2f on %s",
			sim.RefillUSD, bestSurplus, source.Chain)
	}

	amount := sim.RefillUSD * rebalanceBufferFactor
	if amount > bestSurplus {
		amount = bestSurplus
	}

	route := TestRoute{
		Name:         fmt.Sprintf("REBALANCE_%s_%s", strings.ToUpper(source.Chain), strings.ToUpper(dest.Chain)),
		FromChain:    source.Chain,
		FromChainAPI: source.ChainAPI,
		FromToken:    source.TokenAddr,
		ToChain:      dest.Chain,
		ToChainAPI:   dest.ChainAPI,
		ToToken:      dest.TokenAddr,
		IsSolanaSrc:  source.Chain == "Solana",
	}
	return route, amount, nil
}

// Rebalancer executes corrective transfers via the cheapest live bridge quote.
type Rebalancer struct {
	executor *Executor
	slack    *SlackNotifier
}

func NewRebalancer(executor *Executor, slack *SlackNotifier) *Rebalancer {
	if executor == nil {
		return nil
	}
	return &Rebalancer{executor: executor, slack: slack}
}

// canAct verifies keys exist and we are in a mode allowed to broadcast. Keeps
// the rebalancer inert in dry-run and while the benchmark is paused.
func (r *Rebalancer) canAct() bool {
	return r != nil && r.executor != nil && r.executor.txExecutor != nil && r.executor.txExecutor.CanExecute()
}

// TryUnblockTier attempts corrective transfers to make the given failed
// simulation viable, consuming from the slot-wide budget shared across all
// ladder rungs. Returns the latest simulation and whether the tier can now
// run. Callers must only pass non-degraded balances: rebalancing on
// unreadable balances could move real funds based on phantom zeros.
func (r *Rebalancer) TryUnblockTier(sim CycleSimulation, balances map[string]map[string]float64, tierLabel string, budget *slotBudget) (CycleSimulation, bool) {
	if !r.canAct() {
		return sim, false
	}
	if budget == nil {
		budget = newSlotBudget()
	}

	for {
		if budget.blockedByInFlight(sim.RefillChain) {
			log.Printf("🔧 Tier $%.0f needs %s but a corrective transfer to that leg is already in flight, standing down for this slot",
				sim.Tier, sim.RefillChain)
			return sim, false
		}
		if budget.remaining <= 0 {
			bridgeRebalanceAttempts.WithLabelValues("capped").Inc()
			_ = r.slack.NotifyRebalance("capped", fmt.Sprintf(
				"Tier $%.0f (%s) still blocked (%s) but this slot's corrective transfer budget (%d) is spent. Standing down until next slot.",
				sim.Tier, tierLabel, sim.Reason, maxCorrectiveTransfersPerSlot))
			return sim, false
		}
		if spent := r.executor.DailySpent(); spent >= r.executor.config.MaxDailySpendUSD {
			bridgeRebalanceAttempts.WithLabelValues("capped").Inc()
			_ = r.slack.NotifyRebalance("capped", fmt.Sprintf(
				"Tier $%.0f (%s) blocked (%s) but daily spend limit is reached ($%.2f / $%.2f). No rebalance attempted.",
				sim.Tier, tierLabel, sim.Reason, spent, r.executor.config.MaxDailySpendUSD))
			return sim, false
		}

		route, amountUSD, err := BuildRefillRoute(sim, balances)
		if err != nil {
			bridgeRebalanceAttempts.WithLabelValues("failed").Inc()
			log.Printf("🔧 Rebalance not possible for tier $%.0f: %v", sim.Tier, err)
			_ = r.slack.NotifyRebalance("failed", fmt.Sprintf(
				"Tier $%.0f (%s) blocked (%s) and no corrective route could be built: %v",
				sim.Tier, tierLabel, sim.Reason, err))
			return sim, false
		}

		budget.remaining--
		attempt := maxCorrectiveTransfersPerSlot - budget.remaining
		bridgeRebalanceAttempts.WithLabelValues("attempted").Inc()
		log.Printf("🔧 Rebalance attempt %d/%d (slot budget): $%.2f %s -> %s (unblocks tier $%.0f)",
			attempt, maxCorrectiveTransfersPerSlot, amountUSD, route.FromChain, route.ToChain, sim.Tier)
		_ = r.slack.NotifyRebalance("attempted", fmt.Sprintf(
			"Tier $%.0f (%s) blocked: %s\nMoving $%.2f from %s %s to %s %s (slot attempt %d/%d).",
			sim.Tier, tierLabel, sim.Reason, amountUSD, route.FromChain, sourceSymbol(route), route.ToChain, sim.RefillToken,
			attempt, maxCorrectiveTransfersPerSlot))

		result := r.ExecuteCheapest(route, amountUSD)
		switch classifyCorrectiveResult(result) {
		case outcomeInFlight:
			// The deposit TX exists on-chain but the bridge status never
			// resolved. Funds are most likely still moving toward the short
			// leg: any further transfer to that leg this slot would be a
			// double send. Terminal for the whole scheduler slot.
			budget.inFlight = true
			budget.inFlightChain = sim.RefillChain
			bridgeRebalanceAttempts.WithLabelValues("in_flight").Inc()
			_ = r.slack.NotifyRebalance("in_flight", fmt.Sprintf(
				"Corrective transfer for tier $%.0f broadcast (tx %s) but its bridge status did not resolve. Funds are likely still in flight: standing down until next slot to avoid a double send.",
				sim.Tier, result.TxHash))
			return sim, false

		case outcomePreBroadcast:
			bridgeRebalanceAttempts.WithLabelValues("failed").Inc()
			detail := "no bridge produced a usable quote"
			if result != nil && result.Error != nil {
				detail = result.Error.Error()
			}
			_ = r.slack.NotifyRebalance("failed", fmt.Sprintf(
				"Rebalance transfer for tier $%.0f failed before broadcast: %s", sim.Tier, detail))
			// Nothing left the wallet, so another attempt is safe if the
			// slot budget still allows one.
			continue

		case outcomeSuccess:
			bridgeRebalanceAttempts.WithLabelValues("succeeded").Inc()
			_ = r.slack.NotifyRebalance("succeeded", fmt.Sprintf(
				"Moved $%.2f from %s to %s via %s (fee $%.4f, tx %s). Re-checking tier $%.0f viability.",
				amountUSD, route.FromChain, route.ToChain, result.Bridge, result.ActualFeeUSD, result.TxHash, sim.Tier))
		}

		// Give the destination credit a moment to be indexed by the portfolio
		// API before re-simulating, otherwise we would re-read the old state.
		time.Sleep(15 * time.Second)

		fresh, degraded, err := r.executor.balanceCheck.GetAllBalancesDetailed()
		if err != nil || degraded {
			log.Printf("🔧 Post-rebalance balances unreadable (degraded=%v err=%v), stopping", degraded, err)
			return sim, false
		}
		balances = fresh
		sim = SimulateTriangleCycle(balances, sim.Tier)
		if sim.Viable {
			return sim, true
		}
	}
}

// ExecuteCheapest quotes all three executing bridges and broadcasts through
// the cheapest one that returned a live quote. Shared by the tier rebalancer
// and the stuck-fund reaper so both follow the same cost discipline.
func (r *Rebalancer) ExecuteCheapest(route TestRoute, amountUSD float64) *ExecutionResult {
	bridge, fee, err := r.quoteCheapest(route, amountUSD)
	if err != nil {
		log.Printf("🔧 Cheapest-quote selection failed for %s: %v", route.Name, err)
		return nil
	}
	log.Printf("🔧 Cheapest bridge for %s: %s (quoted fee $%.4f)", route.Name, bridge, fee)

	rawUnits := toRawUnits(amountUSD)
	result := r.executor.executeOnBridge(bridge, route, amountUSD, amountUSD, rawUnits)
	// Book the cost here so both callers (tier rebalancer and reaper) share
	// the same accounting, including the flat estimate for broadcasts that
	// never confirmed.
	r.executor.accountSpend(result)
	return result
}

// quoteCheapest fetches quotes from Mobula, Relay and LI.FI and returns the
// bridge with the lowest total quoted fee among those that answered.
func (r *Rebalancer) quoteCheapest(route TestRoute, amountUSD float64) (string, float64, error) {
	e := r.executor
	sender := e.walletManager.EVMAddress
	receiver := e.walletManager.EVMAddress
	if route.FromChain == "Solana" {
		sender = e.walletManager.SolanaAddress
	}
	if route.ToChain == "Solana" {
		receiver = e.walletManager.SolanaAddress
	}
	rawUnits := toRawUnits(amountUSD)

	bestBridge := ""
	bestFee := 0.0

	consider := func(bridge string, fee float64, err error) {
		if err != nil {
			log.Printf("🔧 [%s] rebalance quote failed: %v", bridge, err)
			return
		}
		if bestBridge == "" || fee < bestFee {
			bestBridge, bestFee = bridge, fee
		}
	}

	if e.mobula != nil {
		quote, _, err := e.mobula.GetQuote(route.FromChainAPI, route.FromToken, route.ToChainAPI, route.ToToken, sender, receiver, amountUSD)
		if err != nil {
			consider("mobula", 0, err)
		} else {
			consider("mobula", parseFloatOrZero(quote.Data.Fees.TotalFeeUsd)+parseFloatOrZero(quote.Data.Fees.GasFeeUsd), nil)
		}
	}

	if quote, _, err := e.relay.GetQuote(route, rawUnits, sender, receiver); err != nil {
		consider("relay", 0, err)
	} else {
		consider("relay", parseFloatOrZero(quote.Fees.RelayerService.AmountUsd)+parseFloatOrZero(quote.Fees.RelayerGas.AmountUsd), nil)
	}

	if quote, _, err := e.lifi.GetQuote(route, rawUnits, sender, receiver); err != nil {
		consider("lifi", 0, err)
	} else {
		fee := 0.0
		for _, f := range quote.Estimate.FeeCosts {
			fee += parseFloatOrZero(f.AmountUSD)
		}
		consider("lifi", fee, nil)
	}

	if bestBridge == "" {
		return "", 0, fmt.Errorf("all bridges failed to quote %s", route.Name)
	}
	return bestBridge, bestFee, nil
}

func parseFloatOrZero(s string) float64 {
	return parseFloat(s, 0)
}

// sourceSymbol maps the route's source token address back to a human symbol
// for Slack messages.
func sourceSymbol(route TestRoute) string {
	for _, leg := range triangleLegs {
		if strings.EqualFold(leg.TokenAddr, route.FromToken) {
			return leg.Token
		}
	}
	return route.FromToken
}
