package main

import (
	"os"
	"testing"
	"time"
)

// The lane exists to answer one question faster than the capability pass can:
// does the work term separate providers at all?
//
// Measured from a laptop on 2026-10-30, eleven keyed cells, three repeats:
//
//	alchemy     ethereum/base/arbitrum/bnb/polygon/hyperliquid/robinhood  +44..+66 ms
//	quicknode   robinhood                                                 +39 ms
//	chainstack  ethereum/robinhood                                        +56..+60 ms
//	chainstack  arc                                                       +18 ms
//
// A 48 ms spread between providers, against 109 ms of dispersion inside the
// measuring instrument itself. So from that vantage the answer is no, and the
// deltas are nevertheless suggestive: Arc, a young low-traffic chain, costs a
// fifth of what Ethereum costs for the same fifty state reads. Whether the
// spread survives from a datacentre with hundreds of samples is the question,
// and sample count is the only variable this lane controls.
//
// The guards below are about cost, because the instruction that came with this
// was to watch the plans.

func TestHeavyLaneDefaultCadenceIsAffordable(t *testing.T) {
	os.Unsetenv("RPC_KEYED_HEAVY_LANE_SECONDS")
	got := heavyLaneInterval()
	if got != time.Hour {
		t.Fatalf("default cadence %s, want 1h", got)
	}
	// Two probes, one region, a provider with eight EVM cells.
	perMonth := int(2 * (30 * 24 * time.Hour / got) * 8)
	// Infura has the tightest budget that actually carries EVM cells
	// (370,000 per region per month) and the tip probe already spends about
	// 173,000 of it.
	if perMonth > 20_000 {
		t.Fatalf("%d requests a month for one provider's eight cells: that is no longer a rounding error against a 370k budget", perMonth)
	}
}

func TestHeavyLaneRefusesALoadTestCadence(t *testing.T) {
	// The env override exists so the cadence can be tuned from Railway
	// without a rebuild. Below five minutes this stops measuring the provider
	// and starts measuring what happens when we hammer it, which is both
	// dishonest and a good way to lose a key.
	for _, v := range []string{"1", "30", "299", "-60", "0", "abc"} {
		os.Setenv("RPC_KEYED_HEAVY_LANE_SECONDS", v)
		if got := heavyLaneInterval(); got < 5*time.Minute {
			t.Fatalf("env %q produced %s, which is below the floor", v, got)
		}
	}
	os.Setenv("RPC_KEYED_HEAVY_LANE_SECONDS", "900")
	if got := heavyLaneInterval(); got != 15*time.Minute {
		t.Fatalf("env 900 produced %s, want 15m", got)
	}
	os.Unsetenv("RPC_KEYED_HEAVY_LANE_SECONDS")
}

func TestHeavyLaneProbesAreTheSameTwoAsTheCapabilityPass(t *testing.T) {
	// The lane builds its probes through ethCallProbe, the same constructor
	// the capability pass uses, so the verdict rule and the latency rule
	// cannot drift between the two cadences. If they did, the delta would be
	// computed across two different definitions of "served".
	light := ethCallProbe("eth_call_light", lightCallSubCalls)
	heavy := ethCallProbe("eth_call_heavy", heavyCallSubCalls)
	var laneLight, laneHeavy bool
	for _, pr := range coverageProbes {
		switch pr.API {
		case light.API:
			laneLight = true
		case heavy.API:
			laneHeavy = true
		}
	}
	if !laneLight || !laneHeavy {
		t.Fatal("the lane's api labels must match the capability pass's, or the two cadences write different series")
	}
	lp, _ := light.body(0)
	hp, _ := heavy.body(0)
	if lp == hp {
		t.Fatal("both legs send the same payload: there is no work term to measure")
	}
}
