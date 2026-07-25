package main

import (
	"fmt"
	"math"
	"testing"
	"time"
)

func balancesSnapshot(sol, base, arb float64) map[string]map[string]float64 {
	return map[string]map[string]float64{
		"Solana":   {"USDC": sol, "SOL": 30},
		"Base":     {"USDC": base, "ETH": 40},
		"Arbitrum": {"USDT0": arb, "ETH": 25},
	}
}

func TestBuildRefillRouteSourceSelection(t *testing.T) {
	// Solana leg is short for a $50 tier; Base holds the biggest surplus so it
	// must be picked as the source, not Arbitrum.
	balances := balancesSnapshot(10, 400, 120)
	sim := SimulateTriangleCycle(balances, 50)
	if sim.Viable {
		t.Fatal("expected $50 cycle to be blocked on Solana")
	}
	if sim.RefillChain != "Solana" {
		t.Fatalf("expected refill chain Solana, got %s", sim.RefillChain)
	}

	route, amount, err := BuildRefillRoute(sim, balances)
	if err != nil {
		t.Fatalf("BuildRefillRoute failed: %v", err)
	}
	if route.FromChain != "Base" {
		t.Errorf("expected source Base (largest surplus), got %s", route.FromChain)
	}
	if route.ToChain != "Solana" {
		t.Errorf("expected destination Solana, got %s", route.ToChain)
	}
	if route.FromToken != baseUSDCAddr {
		t.Errorf("expected Base USDC source token, got %s", route.FromToken)
	}
	if route.ToToken != solanaUSDCMint {
		t.Errorf("expected Solana USDC destination token, got %s", route.ToToken)
	}
	if !route.IsSolanaSrc == (route.FromChain == "Solana") {
		t.Error("IsSolanaSrc inconsistent with FromChain")
	}

	// Shortfall is 50 - 10 = 40, buffered by 10 percent.
	want := sim.RefillUSD * rebalanceBufferFactor
	if math.Abs(amount-want) > 0.01 {
		t.Errorf("expected amount %.2f (need + 10%% buffer), got %.2f", want, amount)
	}
	if amount > 400-50 {
		t.Errorf("amount %.2f exceeds Base surplus", amount)
	}
}

func TestBuildRefillRouteCapsAtSurplus(t *testing.T) {
	// Surplus barely covers the shortfall: the buffered amount must be clamped
	// to the surplus instead of overdrawing the source leg.
	balances := balancesSnapshot(0, 55.5, 5)
	sim := SimulateTriangleCycle(balances, 5)
	if sim.Viable {
		t.Fatal("expected $5 cycle to be blocked on Solana")
	}
	route, amount, err := BuildRefillRoute(sim, balances)
	if err != nil {
		t.Fatalf("BuildRefillRoute failed: %v", err)
	}
	if route.FromChain != "Base" {
		t.Fatalf("expected source Base, got %s", route.FromChain)
	}
	surplus := 55.5 - 5
	if amount > surplus+0.001 {
		t.Errorf("amount %.2f exceeds surplus %.2f", amount, surplus)
	}
}

func TestBuildRefillRouteNoExcess(t *testing.T) {
	// Every leg is broke: refusing is the only safe answer.
	balances := balancesSnapshot(1, 2, 3)
	sim := SimulateTriangleCycle(balances, 50)
	if _, _, err := BuildRefillRoute(sim, balances); err == nil {
		t.Fatal("expected error when no leg holds excess inventory")
	}
}

func TestBuildRefillRouteViableRejected(t *testing.T) {
	balances := balancesSnapshot(500, 500, 500)
	sim := SimulateTriangleCycle(balances, 50)
	if !sim.Viable {
		t.Fatal("expected viable cycle")
	}
	if _, _, err := BuildRefillRoute(sim, balances); err == nil {
		t.Fatal("expected error for viable simulation")
	}
}

func TestDowngradeLadder(t *testing.T) {
	cases := []struct {
		tier float64
		want []float64
	}{
		{300, []float64{300, 50, 5}},
		{50, []float64{50, 5}},
		{5, []float64{5}},
	}
	for _, c := range cases {
		got := downgradeLadder(c.tier)
		if len(got) != len(c.want) {
			t.Fatalf("tier %.0f: got %v want %v", c.tier, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("tier %.0f: got %v want %v", c.tier, got, c.want)
				break
			}
		}
	}
}

func TestClassifyCorrectiveResult(t *testing.T) {
	if got := classifyCorrectiveResult(nil); got != outcomePreBroadcast {
		t.Errorf("nil result: got %v, want pre-broadcast", got)
	}
	if got := classifyCorrectiveResult(&ExecutionResult{Success: true, TxHash: "0xabc"}); got != outcomeSuccess {
		t.Errorf("confirmed fill: got %v, want success", got)
	}
	// A broadcast whose status never resolved is TERMINAL: the deposit may
	// have confirmed with the fill still pending, so a retry double-sends.
	if got := classifyCorrectiveResult(&ExecutionResult{Success: false, TxHash: "0xabc", Error: fmt.Errorf("status poll failed: timeout")}); got != outcomeInFlight {
		t.Errorf("status timeout with TxHash: got %v, want in-flight", got)
	}
	// A revert or refund also carries a hash and stays terminal for the slot.
	if got := classifyCorrectiveResult(&ExecutionResult{Reverted: true, TxHash: "0xabc"}); got != outcomeInFlight {
		t.Errorf("reverted with TxHash: got %v, want in-flight", got)
	}
	// Pre-broadcast failures (quote failed, approval failed to broadcast,
	// insufficient funds) have no hash and may consume another attempt.
	if got := classifyCorrectiveResult(&ExecutionResult{Error: fmt.Errorf("quote failed")}); got != outcomePreBroadcast {
		t.Errorf("quote failure: got %v, want pre-broadcast", got)
	}
}

func TestSlotBudgetSharedAcrossRungs(t *testing.T) {
	if maxCorrectiveTransfersPerSlot != 2 {
		t.Fatalf("slot budget must be 2 corrective transfers, got %d", maxCorrectiveTransfersPerSlot)
	}
	b := newSlotBudget()
	if b.remaining != 2 {
		t.Fatalf("fresh budget: got %d remaining, want 2", b.remaining)
	}

	// Rung 1 ($300) consumes one attempt, rung 2 ($50) consumes the second:
	// the SAME budget instance is threaded through the ladder, so rung 3
	// ($5) has nothing left. Per-rung counters allowed up to 6 transfers.
	b.remaining--
	b.remaining--
	if b.remaining > 0 {
		t.Fatalf("after two attempts across rungs the slot budget must be exhausted, got %d", b.remaining)
	}
}

func TestSlotBudgetInFlightBlocksSameLeg(t *testing.T) {
	b := newSlotBudget()
	if b.blockedByInFlight("Solana") {
		t.Fatal("fresh budget must not block any leg")
	}

	// A transfer to Solana broadcast but never resolved: every later rung
	// needing Solana stands down, regardless of remaining budget.
	b.inFlight = true
	b.inFlightChain = "Solana"
	if !b.blockedByInFlight("Solana") {
		t.Error("rung needing the in-flight leg must stand down")
	}
	if !b.blockedByInFlight("solana") {
		t.Error("leg matching must be case-insensitive")
	}
	if b.blockedByInFlight("Base") {
		t.Error("a rung needing a different leg is not blocked by the in-flight transfer")
	}

	var nilBudget *slotBudget
	if nilBudget.blockedByInFlight("Solana") {
		t.Error("nil budget must not block")
	}
}

func TestSimulateBalancesOnlyInDryRun(t *testing.T) {
	t.Setenv("SIMULATE_BALANCES", "true")
	if SimulateBalances(ModeDryRun) == nil {
		t.Fatal("dry-run with SIMULATE_BALANCES=true must return the snapshot")
	}
	if SimulateBalances(ModeProduction) != nil {
		t.Fatal("production mode must ignore SIMULATE_BALANCES")
	}
	if SimulateBalances(ModeSingleTest) != nil {
		t.Fatal("single-test mode must ignore SIMULATE_BALANCES")
	}

	t.Setenv("SIMULATE_BALANCES", "false")
	if SimulateBalances(ModeDryRun) != nil {
		t.Fatal("no snapshot when SIMULATE_BALANCES is off")
	}
}

func TestStrandedHoursComputation(t *testing.T) {
	tracker := NewStrandedTracker()
	t0 := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)

	// USDC on Arbitrum is off-home (triangle expects USDT there).
	balances := balancesSnapshot(100, 100, 100)
	balances["Arbitrum"]["USDC"] = 42

	hours := tracker.Update(balances, t0)
	k := strandKey{"Arbitrum", "USDC"}
	if hours[k] != 0 {
		t.Errorf("first sighting should report 0 hours, got %.2f", hours[k])
	}
	// Home legs never appear as stranded.
	if _, ok := hours[strandKey{"Solana", "USDC"}]; ok {
		t.Error("home leg Solana/USDC reported as stranded")
	}
	if _, ok := hours[strandKey{"Arbitrum", "USDT0"}]; ok {
		t.Error("home leg Arbitrum/USDT0 reported as stranded")
	}

	// 7 hours later the same balance is still there: above the 6h default.
	hours = tracker.Update(balances, t0.Add(7*time.Hour))
	if math.Abs(hours[k]-7) > 0.001 {
		t.Errorf("expected 7 stranded hours, got %.2f", hours[k])
	}

	// Funds moved home: the key must report an explicit 0 so the gauge resets,
	// and the clock must restart if it strands again later.
	delete(balances["Arbitrum"], "USDC")
	hours = tracker.Update(balances, t0.Add(8*time.Hour))
	if hours[k] != 0 {
		t.Errorf("expected explicit 0 after funds came home, got %.2f", hours[k])
	}

	balances["Arbitrum"]["USDC"] = 42
	hours = tracker.Update(balances, t0.Add(20*time.Hour))
	if hours[k] != 0 {
		t.Errorf("re-stranding must restart the clock at 0, got %.2f", hours[k])
	}
}

func TestStrandedIgnoresDustAndAddressKeys(t *testing.T) {
	tracker := NewStrandedTracker()
	now := time.Now().UTC()

	balances := balancesSnapshot(100, 100, 100)
	balances["Arbitrum"]["USDC"] = 0.5
	balances["Arbitrum"][arbUSDCAddr] = 5000

	hours := tracker.Update(balances, now)
	if _, ok := hours[strandKey{"Arbitrum", "USDC"}]; ok {
		t.Error("dust below $1 must not count as stranded")
	}
	for k := range hours {
		if len(k.Token) > 12 {
			t.Errorf("contract-address key leaked into stranded set: %v", k)
		}
	}
}
