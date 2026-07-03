package main

import "fmt"

// CycleSimulation is the verdict on whether a full triangle cycle at a given tier
// can complete, given current wallet balances. If not viable, it tells you which
// leg is the bottleneck and how much it's short, and where to send a refill.
type CycleSimulation struct {
	Viable    bool
	Tier      float64
	BlockLeg  string  // e.g. "R1 Sol USDC"
	Needed    float64 // USD required at that point in the cycle
	Available float64 // USD actually available (incl. upstream route inflow)
	Reason    string  // one-line human-readable summary

	// Refill target — what the operator needs to send to unblock. Empty when Viable.
	RefillChain string // "Solana" | "Base" | "Arbitrum"
	RefillToken string // "USDC" | "USDT"
	RefillUSD   float64
}

// SimulateTriangleCycle walks the triangle R1→R2→R3 for the SEQUENTIAL PER-BRIDGE
// orchestration: each bridge does its own full Sol→Base→Arb→Sol triangle before
// the next bridge starts. Consequence: each leg only needs 1×tier at peak (not 3×),
// because the preceding route settled ~1×tier onto it before it has to source.
//
// Conservative fee buffer: 2% cumulative per bridge's 3-hop round-trip (0.98 factor).
func SimulateTriangleCycle(balances map[string]map[string]float64, tier float64) CycleSimulation {
	const netFactor = 0.98

	solUSDC := balances["Solana"]["USDC"]
	baseUSDC := balances["Base"]["USDC"]
	arbUSDT := balances["Arbitrum"]["USDT0"]

	// Per-bridge leg requirement is 1×tier (not 3×): one TX at a time, settlement
	// replenishes the next leg before it has to source.
	need := tier

	sim := CycleSimulation{Tier: tier}

	// R1: Sol USDC → Base USDC. No preceding inflow on first bridge's iteration.
	if solUSDC < need {
		sim.BlockLeg = "R1 Sol USDC"
		sim.Needed = need
		sim.Available = solUSDC
		sim.Reason = fmt.Sprintf("R1 Sol→Base blocked: need $%.2f USDC on Solana, have $%.2f", need, solUSDC)
		sim.RefillChain, sim.RefillToken, sim.RefillUSD = "Solana", "USDC", need-solUSDC
		return sim
	}

	// R2: Base USDC → Arb USDT. R1 of current bridge deposited ~tier × 0.98 on Base.
	baseEff := baseUSDC + need*netFactor
	if baseEff < need {
		sim.BlockLeg = "R2 Base USDC"
		sim.Needed = need
		sim.Available = baseEff
		sim.Reason = fmt.Sprintf("R2 Base→Arb blocked: need $%.2f USDC on Base (incl. R1 inflow ≈$%.2f), effective $%.2f",
			need, need*netFactor, baseEff)
		sim.RefillChain, sim.RefillToken, sim.RefillUSD = "Base", "USDC", need-baseEff
		return sim
	}

	// R3: Arb USDT → Sol USDC. R2 of current bridge deposited ~tier × 0.98 on Arb.
	arbEff := arbUSDT + need*netFactor
	if arbEff < need {
		sim.BlockLeg = "R3 Arb USDT"
		sim.Needed = need
		sim.Available = arbEff
		sim.Reason = fmt.Sprintf("R3 Arb→Sol blocked: need $%.2f USDT on Arbitrum (incl. R2 inflow ≈$%.2f), effective $%.2f",
			need, need*netFactor, arbEff)
		sim.RefillChain, sim.RefillToken, sim.RefillUSD = "Arbitrum", "USDT", need-arbEff
		return sim
	}

	sim.Viable = true
	return sim
}
