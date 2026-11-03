package main

import (
	"math"
	"math/big"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.6f, want %.6f (±%g)", name, got, want, tol)
	}
}

// Live values captured 2026-11-03 are used as fixtures so each test
// also documents the sanity figure quoted in the source comments.

func TestAptosRate(t *testing.T) {
	r, err := aptosPerEpochRate(true, "109501220528869", "15981", "1000000000")
	if err != nil {
		t.Fatal(err)
	}
	gross, net, up := aptosNetBps(r, 7200, 190, 0, 1000)
	near(t, "aptos gross bps", gross, 260.2, 0.5) // 2.60% after the 2026 cut
	near(t, "aptos net bps", net, 234.2, 0.5)     // 10% operator commission
	near(t, "aptos uptime", up, 100, 0)

	legacy, _ := aptosPerEpochRate(false, "", "15981", "1000000000")
	g2, _, _ := aptosNetBps(legacy, 7200, 1, 0, 0)
	near(t, "aptos legacy gross bps", g2, 700.4, 0.5)

	_, n3, u3 := aptosNetBps(r, 7200, 0, 12, 0)
	if n3 != 0 || u3 != 0 {
		t.Errorf("a validator failing every proposal must earn 0, got net %.2f uptime %.2f", n3, u3)
	}
	_, _, u4 := aptosNetBps(r, 7200, 0, 0, 0)
	near(t, "aptos no-proposal-yet uptime", u4, 100, 0)
}

func TestNearMath(t *testing.T) {
	apr := nearNetworkAPR(1310729419.5, 593372642.8, 1.0/40, 0)
	near(t, "near gross", apr, 0.05522, 0.00002)
	near(t, "near factor below min", nearRewardFactor(0.89, 0.9, 0.99), 0, 0)
	near(t, "near factor at max", nearRewardFactor(0.995, 0.9, 0.99), 1, 0)
	near(t, "near factor mid", nearRewardFactor(0.945, 0.9, 0.99), 0.5, 1e-9)
	v := nearValidator{NumExpectedBlocks: 57, NumProducedBlocks: 57, NumExpectedChunks: 375, NumProducedChunks: 375,
		NumExpectedEndorsements: 12391, NumProducedEndorsements: 12381}
	near(t, "near online ratio", nearOnlineRatio(v), (1+1+12381.0/12391)/3, 1e-12)
	near(t, "near online ratio no duty", nearOnlineRatio(nearValidator{}), 1, 0)
	near(t, "yocto", yoctoToNear("33270925619217119134459443495696"), 33270925.619, 0.01)
}

func TestKaiaMath(t *testing.T) {
	stakers, _ := new(big.Int).SetString("3839999999999999987", 10)
	apr := kaiaGrossAPR(stakers, 1.0, 2953266000)
	near(t, "kaia gross", apr, 0.04103, 0.0001)
	if kaiaGrossAPR(nil, 1, 1) != 0 || kaiaGrossAPR(stakers, 0, 1) != 0 {
		t.Error("kaia guard clauses")
	}
	near(t, "hex", hexToFloat("0x00000000000000000000000000000000000000000000000000000000000001f4"), 500, 0)
}

func TestAlgorandMath(t *testing.T) {
	payouts := []int64{8187062, 0, 8179062, 8193000, 0}
	apr, n := algorandAPR(2.7797, payouts, 2011205945814960)
	if n != 3 {
		t.Fatalf("eligible blocks = %d, want 3 (zero payouts are ineligible proposers)", n)
	}
	near(t, "algorand apr", apr, 0.04621, 0.0002)
	if a, _ := algorandAPR(2.78, []int64{0, 0}, 1); a != 0 {
		t.Error("no eligible block must give 0, not a division by zero")
	}
}

func TestICPMath(t *testing.T) {
	apr := icpNeuronAPR(5316624852793, 1, 58314266017838968, icpMaxDissolveBonus)
	near(t, "icp 2y neuron apr", apr, 0.0999, 0.0002)
	// A pool that rolled over a missed day is split across the days.
	near(t, "icp rollover", icpNeuronAPR(2*5316624852793, 2, 58314266017838968, 3), apr, 1e-12)
}

func TestGramMath(t *testing.T) {
	apr := apyToAPR(0.12552465, 131072)
	near(t, "gram apr from apy", apr, 0.1183, 0.0005)
	if apr >= 0.12552465 {
		t.Error("de-compounding must lower the figure")
	}
	pools := gramCohort([]tonapiPool{
		{Name: "Whales", Verified: true, TotalAmount: 1, Implementation: "whales"},
		{Name: "Tonstakers", Verified: true, TotalAmount: 1, Implementation: "liquidTF"},
		{Name: "solo", Verified: false, TotalAmount: 1, Implementation: "tf"},
		{Name: "empty", Verified: true, TotalAmount: 0, Implementation: "whales"},
	})
	if len(pools) != 1 || pools[0].Name != "Whales" {
		t.Errorf("cohort = %+v, want only the funded verified non-liquid pool", pools)
	}
}

func TestCosmosMath(t *testing.T) {
	// Cosmos Hub 2026-11-03: provisions 53.98M ATOM, bonded 340.8M, tax 2%.
	near(t, "hub gross uncorrected", cosmosGrossAPR(53978478944686.8, 0.02, 340779175035391), 0.15523, 0.0001)
	// x/mint with a 7.2 s param and 6 s real blocks mints 20% more.
	near(t, "mint correction", mintAnnualIssuance(100, secondsPerYear/7.2, 6), 120, 1e-9)
	near(t, "mint no correction", mintAnnualIssuance(100, 0, 6), 100, 0)
	// Sei: 165M SEI over the 2026-08-15..2027-08-14 release period.
	v, err := seiAnnualIssuance(165000000000000, "2026-08-15", "2027-08-14")
	if err != nil {
		t.Fatal(err)
	}
	near(t, "sei annual issuance", v/1e6, 165e6, 1e6)
	near(t, "sei gross", cosmosGrossAPR(v, 0, 4088127360054053), 0.0404, 0.0003)
	if _, err := seiAnnualIssuance(1, "2027-01-01", "2026-01-01"); err == nil {
		t.Error("reversed period must error")
	}
}

func TestSuiMath(t *testing.T) {
	rNow := 9393348687697438.0 / 8572942964138532.0
	rThen := 1.094574305617325
	apr := suiNetAPR(rNow, rThen, 30*86400)
	near(t, "sui net apr", apr, 0.01248, 0.0005)
	if suiNetAPR(0, 1, 1) != 0 || suiNetAPR(1, 1, 0) != 0 {
		t.Error("sui guard clauses")
	}
}

func TestCardanoMath(t *testing.T) {
	s := func(v string) *string { return &v }
	apr, e := cardanoGrossAPR([]koiosEpochInfo{
		{EpochNo: 665, ActiveStake: s("21540456674380057")},
		{EpochNo: 662, ActiveStake: s("21391921928368480"), TotalRewards: s("6146980326691")},
		{EpochNo: 663, ActiveStake: s("21496414657189389"), TotalRewards: s("6232905845770")},
	})
	if e != 663 {
		t.Errorf("picked epoch %d, want the latest with rewards (663)", e)
	}
	near(t, "cardano gross", apr, 0.02118, 0.0001)
}

func TestAvalancheMath(t *testing.T) {
	// NodeID-CciiJQ… 2026-11-03: 2000 AVAX, 29.0 day period, 8.0657 AVAX.
	apr := avalancheGrossAPR(8065727717, 2000000000000, 1791208985, 1793718000)
	near(t, "avalanche gross", apr, 0.0507, 0.0005)
	if avalancheGrossAPR(1, 0, 0, 1) != 0 || avalancheGrossAPR(1, 1, 5, 5) != 0 {
		t.Error("avalanche guard clauses")
	}
}

func TestStakewizCommissionUnit(t *testing.T) {
	bps := []stakewizValidator{{Commission: 0}, {Commission: 500}, {Commission: 10000}}
	if !stakewizCommissionIsBps(bps) {
		t.Fatal("values above 100 must be read as bps")
	}
	near(t, "5% in bps", stakewizCommissionBps(500, true), 500, 0)
	near(t, "100% in bps", stakewizCommissionBps(10000, true), 10000, 0)
	if stakewizCommissionIsBps([]stakewizValidator{{Commission: 7}, {Commission: 100}}) {
		t.Fatal("an all-percent response must stay percent")
	}
	near(t, "7% legacy percent", stakewizCommissionBps(7, false), 700, 0)
}

func TestPublishRowsDeletesLeavers(t *testing.T) {
	const chain = "test-chain"
	publishRows(chain, []valRow{
		{ID: "a", Name: "A", NetBps: 100, CommissionBps: 0, UptimePct: 100},
		{ID: "b", Name: "B", NetBps: 300, CommissionBps: -1, UptimePct: 100},
	}, 0)
	if got := testutil.ToFloat64(chainMedianNetYieldBps.WithLabelValues(chain)); got != 200 {
		t.Errorf("median = %v, want 200", got)
	}
	med := publishRows(chain, []valRow{{ID: "a", Name: "A", NetBps: 100, UptimePct: 100}}, 0)
	if med != 100 {
		t.Errorf("median after leaver = %v, want 100", med)
	}
	if n := testutil.CollectAndCount(validatorNetYieldBps); n != 1 {
		t.Errorf("net yield series = %d, want 1 (validator b must be deleted)", n)
	}
}
