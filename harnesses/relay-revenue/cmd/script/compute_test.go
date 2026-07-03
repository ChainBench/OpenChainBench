package main

import (
	"context"
	"math"
	"testing"
)

// compute_test.go — offline coverage of ComputeMargin. No network
// calls; we drive everything through staticPricer fixtures.
//
// Cases:
//   happy path        — known ETH/SOL swap with known prices → known margin
//   empty appFees     — 0 added to fees, ok=true
//   multi-currency appFees — different stable + native legs sum
//   missing prices    — unknown asset → priced=false, no panic
//   multi-tx gas      — two inTxs + two outTxs all sum
//   bridged stables   — USDC.E on Polygon prices as $1 (key drop fix)
//   ERC-20 lookup     — non-native, non-stable token resolved via PriceTokenUSD
//   Relay USD hint    — amountUsd populated short-circuits the pricer
//
// Pricer fixture: ETH=$3,000  SOL=$150  BTC=$70,000  BNB=$600
// Stables ($1) handled by the stablePegs symbol short-circuit.

const float64Eps = 0.0001

func newTestPricer() *staticPricer {
	return newStaticPricer(map[string]float64{
		"ethereum":      3_000,
		"solana":        150,
		"bitcoin":       70_000,
		"binancecoin":   600,
		"ronin":         2,
		"matic-network": 0.5,
	})
}

func approxEq(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > float64Eps*math.Max(1, math.Abs(want)) {
		t.Errorf("%s: got %.6f want %.6f", name, got, want)
	}
}

func TestComputeMargin_HappyPath(t *testing.T) {
	// User swaps 1 ETH on Ethereum → 19.5 SOL on Solana. Relay pays
	// 0.01 ETH gas in, 0.001 SOL gas out, no app fees.
	//   usd_in   = 1     * 3000 = 3000
	//   usd_out  = 19.5  * 150  = 2925
	//   gas_in   = 0.01  * 3000 = 30
	//   gas_out  = 0.001 * 150  = 0.15
	//   margin   = 3000 - 2925 - 30.15 - 0 = 44.85
	req := RelayRequest{
		ID:        "swap-1",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn:  RelayAmount{Currency: RelayCurrency{ChainID: 1, Symbol: "ETH", Address: "", Decimals: 18}, Amount: "1000000000000000000"},
				CurrencyOut: RelayAmount{Currency: RelayCurrency{ChainID: 792703809, Symbol: "SOL", Address: "", Decimals: 9}, Amount: "19500000000"},
			},
			InTxs:  []RelayTx{{Hash: "0xin", ChainID: 1, Fee: "10000000000000000"}},
			OutTxs: []RelayTx{{Hash: "solout", ChainID: 792703809, Fee: "1000000"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("expected priced=true, got false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 3000)
	approxEq(t, "gas", sw.GasUSD, 30.15)
	approxEq(t, "appfees", sw.AppFeesUSD, 0)
	approxEq(t, "margin", sw.MarginUSD, 44.85)
}

func TestComputeMargin_EmptyAppFees(t *testing.T) {
	// Same shape as happy path but with explicit empty AppFees slice.
	// Empty appFees is observed in 29% of real swaps — must not flip
	// priced to false.
	req := RelayRequest{
		ID:        "swap-2",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn:  RelayAmount{Currency: RelayCurrency{ChainID: 8453, Symbol: "ETH", Decimals: 18}, Amount: "500000000000000000"},
				CurrencyOut: RelayAmount{Currency: RelayCurrency{ChainID: 42161, Symbol: "ETH", Decimals: 18}, Amount: "498000000000000000"},
			},
			InTxs:   []RelayTx{{Hash: "0xa", ChainID: 8453, Fee: "1000000000000000"}},
			OutTxs:  []RelayTx{{Hash: "0xb", ChainID: 42161, Fee: "500000000000000"}},
			AppFees: nil,
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("expected priced=true, got false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 1500)
	approxEq(t, "appfees", sw.AppFeesUSD, 0)
}

func TestComputeMargin_MultiCurrencyAppFees(t *testing.T) {
	// Two appFees: USDC ($1 each) + ETH (native at $3000). Both must
	// price correctly and add to the total.
	req := RelayRequest{
		ID:        "swap-3",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn:  RelayAmount{Currency: RelayCurrency{ChainID: 1, Symbol: "ETH", Decimals: 18}, Amount: "1000000000000000000"},
				CurrencyOut: RelayAmount{Currency: RelayCurrency{ChainID: 8453, Symbol: "ETH", Decimals: 18}, Amount: "990000000000000000"},
			},
			InTxs:  []RelayTx{{Hash: "0xa", ChainID: 1, Fee: "0"}},
			OutTxs: []RelayTx{{Hash: "0xb", ChainID: 8453, Fee: "0"}},
			AppFees: []RelayAppFee{
				{Recipient: "0xrec1", Amount: "5000000", Currency: RelayCurrency{ChainID: 8453, Symbol: "USDC", Decimals: 6}},
				{Recipient: "0xrec2", Amount: "1000000000000000", Currency: RelayCurrency{ChainID: 1, Symbol: "ETH", Decimals: 18}},
			},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("expected priced=true, got false")
	}
	// 5 USDC + 0.001 ETH ($3) = $8
	approxEq(t, "appfees", sw.AppFeesUSD, 8)
}

func TestComputeMargin_MissingPriceMarksUnpriced(t *testing.T) {
	// Output is on a chain we don't know about. ComputeMargin should
	// not panic; it should return priced=false but still produce a row.
	req := RelayRequest{
		ID:        "swap-4",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn:  RelayAmount{Currency: RelayCurrency{ChainID: 1, Symbol: "ETH", Decimals: 18}, Amount: "1000000000000000000"},
				CurrencyOut: RelayAmount{Currency: RelayCurrency{ChainID: 99999999, Symbol: "ZZZ", Decimals: 18}, Amount: "1000000000000000000"},
			},
			InTxs:  []RelayTx{{Hash: "0xa", ChainID: 1, Fee: "0"}},
			OutTxs: []RelayTx{{Hash: "0xb", ChainID: 99999999, Fee: "1000000000000000"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin returned error on unknown chain: %v", err)
	}
	if sw.Priced {
		t.Fatalf("expected priced=false for unknown asset, got true")
	}
	if sw.MarginUSD != 0 {
		t.Errorf("unpriced swap should have margin=0, got %.6f", sw.MarginUSD)
	}
}

func TestComputeMargin_MultiTxGas(t *testing.T) {
	// Two inTxs + two outTxs, all priced, must sum.
	req := RelayRequest{
		ID:        "swap-5",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn:  RelayAmount{Currency: RelayCurrency{ChainID: 1, Symbol: "ETH", Decimals: 18}, Amount: "1000000000000000000"},
				CurrencyOut: RelayAmount{Currency: RelayCurrency{ChainID: 792703809, Symbol: "SOL", Decimals: 9}, Amount: "19000000000"},
			},
			InTxs: []RelayTx{
				{ChainID: 1, Fee: "1000000000000000"},
				{ChainID: 1, Fee: "2000000000000000"},
			},
			OutTxs: []RelayTx{
				{ChainID: 792703809, Fee: "10000000"},
				{ChainID: 792703809, Fee: "20000000"},
			},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("expected priced=true, got false")
	}
	approxEq(t, "gas", sw.GasUSD, 13.5)
}

// TestComputeMargin_USDCBridgedVariant covers the highest-impact drop
// cause discovered in the audit: USDC.E (Polygon bridged USDC) accounts
// for ~27 % of all dropped swaps because the original stablePegs list
// only matched exact "USDC". A swap with USDC.E on one leg must now
// price cleanly at $1.
func TestComputeMargin_USDCBridgedVariant(t *testing.T) {
	req := RelayRequest{
		ID:        "swap-usdce",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn: RelayAmount{
					Currency: RelayCurrency{ChainID: 137, Symbol: "USDC.E", Address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", Decimals: 6},
					Amount:   "100000000", // 100 USDC.E
				},
				CurrencyOut: RelayAmount{
					Currency: RelayCurrency{ChainID: 8453, Symbol: "USDC", Address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", Decimals: 6},
					Amount:   "99500000", // 99.5 USDC
				},
			},
			InTxs:  []RelayTx{{ChainID: 137, Fee: "0"}},
			OutTxs: []RelayTx{{ChainID: 8453, Fee: "0"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("USDC.E must price as stable peg, got priced=false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 100)
	approxEq(t, "margin", sw.MarginUSD, 0.5)
}

// TestComputeMargin_ERC20ViaTokenLookup covers the new PriceTokenUSD
// path: a non-native, non-stable ERC-20 (UNI on Ethereum) is resolved
// by (chainId, contract address) rather than dropping silently.
func TestComputeMargin_ERC20ViaTokenLookup(t *testing.T) {
	pricer := newTestPricer()
	pricer.addToken(1, "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 8.0) // UNI = $8
	pricer.addToken(8453, "0x912ce59144191c1204e64559fe8253a0e49e6548", 1.2) // ARB-on-Base placeholder

	req := RelayRequest{
		ID:        "swap-erc20",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn: RelayAmount{
					Currency: RelayCurrency{ChainID: 1, Symbol: "UNI", Address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", Decimals: 18},
					Amount:   "10000000000000000000", // 10 UNI = $80
				},
				CurrencyOut: RelayAmount{
					Currency: RelayCurrency{ChainID: 8453, Symbol: "ARB", Address: "0x912ce59144191c1204e64559fe8253a0e49e6548", Decimals: 18},
					Amount:   "65000000000000000000", // 65 tokens × $1.2 = $78
				},
			},
			InTxs:  []RelayTx{{ChainID: 1, Fee: "0"}},
			OutTxs: []RelayTx{{ChainID: 8453, Fee: "0"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, pricer)
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("ERC-20 via PriceTokenUSD must price, got priced=false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 80)
	approxEq(t, "margin", sw.MarginUSD, 2)
}

// TestComputeMargin_RelayUSDHintShortCircuits proves that when Relay
// populates amountUsd on a leg, we use it verbatim and DON'T burn a
// pricer call. The pricer is intentionally empty so any pricer touch
// would flip priced=false.
func TestComputeMargin_RelayUSDHintShortCircuits(t *testing.T) {
	emptyPricer := newStaticPricer(nil) // knows literally nothing

	req := RelayRequest{
		ID:        "swap-hint",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn: RelayAmount{
					Currency:  RelayCurrency{ChainID: 1, Symbol: "PEPE", Address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", Decimals: 18},
					Amount:    "1000000000000000000000000",
					AmountUSD: "152.34", // ← Relay's own swap-time USD
				},
				CurrencyOut: RelayAmount{
					Currency:  RelayCurrency{ChainID: 8453, Symbol: "USDC", Decimals: 6},
					Amount:    "150000000",
					AmountUSD: "150.00",
				},
			},
			InTxs:  []RelayTx{{ChainID: 1, Fee: "0"}},
			OutTxs: []RelayTx{{ChainID: 8453, Fee: "0"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, emptyPricer)
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("amountUsd hint must short-circuit, got priced=false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 152.34)
	approxEq(t, "margin", sw.MarginUSD, 2.34)
}

// TestComputeMargin_RelayUSDHintFallback covers the case where Relay
// returns amountUsd="0" or empty: we must fall back to our pricer, not
// silently treat the leg as $0.
func TestComputeMargin_RelayUSDHintFallback(t *testing.T) {
	req := RelayRequest{
		ID:        "swap-no-hint",
		Status:    "success",
		CreatedAt: "2026-05-23T12:00:00Z",
		Data: RelayReqData{
			Metadata: RelayMetadata{
				CurrencyIn: RelayAmount{
					Currency:  RelayCurrency{ChainID: 1, Symbol: "ETH", Decimals: 18},
					Amount:    "1000000000000000000",
					AmountUSD: "", // empty hint → fall through
				},
				CurrencyOut: RelayAmount{
					Currency:  RelayCurrency{ChainID: 8453, Symbol: "ETH", Decimals: 18},
					Amount:    "990000000000000000",
					AmountUSD: "0", // zero hint → also falls through
				},
			},
			InTxs:  []RelayTx{{ChainID: 1, Fee: "0"}},
			OutTxs: []RelayTx{{ChainID: 8453, Fee: "0"}},
		},
	}
	sw, err := ComputeMargin(context.Background(), req, newTestPricer())
	if err != nil {
		t.Fatalf("ComputeMargin: %v", err)
	}
	if !sw.Priced {
		t.Fatalf("ETH legs must price via fallback, got priced=false")
	}
	approxEq(t, "volume", sw.VolumeUSD, 3000)
	approxEq(t, "margin", sw.MarginUSD, 30) // 3000 - 2970 - 0 - 0
}

func TestScaleAmount_Precision(t *testing.T) {
	v, ok := scaleAmount("1000000000000000000", 18)
	if !ok {
		t.Fatalf("scaleAmount returned ok=false")
	}
	approxEq(t, "1eth", v, 1.0)
	v, ok = scaleAmount("500000000", 9)
	if !ok {
		t.Fatalf("scaleAmount returned ok=false")
	}
	approxEq(t, "half-sol", v, 0.5)
	if _, ok := scaleAmount("not-a-number", 18); ok {
		t.Errorf("expected scaleAmount to fail on garbage input")
	}
}

func TestParseRelayUSDHint(t *testing.T) {
	cases := []struct {
		in    string
		wantV float64
		wantOK bool
	}{
		{"", 0, false},
		{"  ", 0, false},
		{"0", 0, false},
		{"-1.5", 0, false},
		{"not a number", 0, false},
		{"1.23", 1.23, true},
		{"  150.50  ", 150.50, true},
		{"0.0000001", 0.0000001, true},
	}
	for _, c := range cases {
		v, ok := parseRelayUSDHint(c.in)
		if ok != c.wantOK {
			t.Errorf("parseRelayUSDHint(%q): ok=%v want %v", c.in, ok, c.wantOK)
		}
		if ok && math.Abs(v-c.wantV) > 1e-9 {
			t.Errorf("parseRelayUSDHint(%q): v=%v want %v", c.in, v, c.wantV)
		}
	}
}
