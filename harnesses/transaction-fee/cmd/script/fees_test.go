package main

import (
	"encoding/json"
	"math"
	"testing"
)

func approx(t *testing.T, name string, got, want float64) {
	t.Helper()
	if want == 0 {
		if got != 0 {
			t.Fatalf("%s: got %v, want 0", name, got)
		}
		return
	}
	if math.Abs(got-want)/math.Abs(want) > 1e-9 {
		t.Fatalf("%s: got %v, want %v", name, got, want)
	}
}

func TestAlgorandTransferFee(t *testing.T) {
	// Uncongested: fee per byte 0, the 1000 microAlgo floor applies.
	approx(t, "floor", algorandTransferFee(0, 1000, 250), 1000)
	// Below the floor: 3 * 250 = 750 < 1000.
	approx(t, "below floor", algorandTransferFee(3, 1000, 250), 1000)
	// Congested: 10 * 250 = 2500 > 1000.
	approx(t, "congested", algorandTransferFee(10, 1000, 250), 2500)
	// USD: 1000 microAlgo at $0.0933 = $0.0000933.
	ch := ChainConfig{Kind: KindAlgorand}
	approx(t, "usd", nativeToUSD(ch, 1000, 0.0933), 0.0000933)
}

func TestAptosTierSamples(t *testing.T) {
	var e aptosGasEstimate
	if err := json.Unmarshal([]byte(`{"deprioritized_gas_estimate":100,"gas_estimate":100,"prioritized_gas_estimate":150}`), &e); err != nil {
		t.Fatal(err)
	}
	s, err := aptosTierSamples("aptos", e)
	if err != nil {
		t.Fatal(err)
	}
	if len(s) != 3 || s[0].Tier != "slow" || s[1].Tier != "std" || s[2].Tier != "fast" {
		t.Fatalf("tiers: %+v", s)
	}
	approx(t, "slow", s[0].NativeFee, 6300)
	approx(t, "std", s[1].NativeFee, 6300)
	approx(t, "fast", s[2].NativeFee, 9450)
	// 6300 octas at $0.62 = 0.000063 APT * 0.62.
	approx(t, "usd", nativeToUSD(ChainConfig{Kind: KindAptos}, 6300, 0.62), 0.000063*0.62)

	// Only gas_estimate present: every tier takes it.
	s, err = aptosTierSamples("aptos", aptosGasEstimate{Standard: 120})
	if err != nil {
		t.Fatal(err)
	}
	approx(t, "fallback slow", s[0].NativeFee, 120*63)
	approx(t, "fallback fast", s[2].NativeFee, 120*63)

	if _, err := aptosTierSamples("aptos", aptosGasEstimate{}); err == nil {
		t.Fatal("want an error without gas_estimate")
	}
}

func TestNearTransferGas(t *testing.T) {
	// Protocol 86 runtime config, as returned by EXPERIMENTAL_protocol_config.
	receipt := nearFee{Execution: 108059500000, SendNotSir: 108059500000}
	transfer := nearFee{Execution: 115123062500, SendNotSir: 115123062500}
	gas := nearTransferGas(receipt, transfer)
	approx(t, "gas", gas, 446365125000)
	// At 1e8 yocto per gas this is the 44_636_512_500_000_000_000 yocto
	// every named-to-named transfer burnt on mainnet on 2026-11-03.
	approx(t, "yocto", gas*1e8, 44636512500000000000)
	// 0.0000446365 NEAR at $3.88.
	approx(t, "usd", nativeToUSD(ChainConfig{Kind: KindNear}, gas*1e8, 3.88), 0.0000446365125*3.88)
}

func TestICPFee(t *testing.T) {
	var r rosettaMetadataResp
	if err := json.Unmarshal([]byte(`{"metadata":{},"suggested_fee":[{"value":"10000","currency":{"symbol":"ICP","decimals":8}}]}`), &r); err != nil {
		t.Fatal(err)
	}
	e8s, err := icpFeeE8s(r)
	if err != nil {
		t.Fatal(err)
	}
	approx(t, "e8s", e8s, 10000)
	// 0.0001 ICP at $2.49.
	approx(t, "usd", nativeToUSD(ChainConfig{Kind: KindICP}, e8s, 2.49), 0.000249)

	bad := rosettaMetadataResp{}
	if err := json.Unmarshal([]byte(`{"suggested_fee":[{"value":"10000","currency":{"symbol":"ICP","decimals":6}}]}`), &bad); err != nil {
		t.Fatal(err)
	}
	if _, err := icpFeeE8s(bad); err == nil {
		t.Fatal("want an error on unexpected decimals")
	}
	if _, err := icpFeeE8s(rosettaMetadataResp{}); err == nil {
		t.Fatal("want an error on an empty answer")
	}
}

func TestMedianRewards(t *testing.T) {
	// Kaia eth_feeHistory, 2026-11-03: one block's p90 tip was 23046 gwei.
	rows := [][]string{
		{"0x9502f900", "0x9502f900", "0x9502f900"},
		{"0x9502f900", "0x9502f900", "0x1dcd65000"},
		{"0x9502f900", "0x107d0d7d56", "0x14f695d0a8ed"},
		{"0x1e08ffca00", "0x1e08ffca00", "0x2d2b4d1400"},
	}
	got := medianRewards(rows)
	if len(got) != 3 {
		t.Fatalf("cols: %d", len(got))
	}
	// p25: sorted 2.5, 2.5, 2.5, 129 gwei -> median 2.5 gwei.
	if got[0].Int64() != 2_500_000_000 {
		t.Fatalf("p25 median %v", got[0])
	}
	// p90: sorted 2.5, 8, 194, 23046 gwei -> (8 + 194) / 2 = 101 gwei,
	// where the mean would have been about 5813 gwei.
	if got[2].Int64() != (8_000_000_000+194_000_000_000)/2 {
		t.Fatalf("p90 median %v", got[2])
	}
	// Odd count.
	if v := medianRewards([][]string{{"0x1"}, {"0x9"}, {"0x3"}}); v[0].Int64() != 3 {
		t.Fatalf("odd median %v", v[0])
	}
	if medianRewards(nil) != nil {
		t.Fatal("empty input must return nil")
	}
}

func TestSuiTransferFee(t *testing.T) {
	// Reference price 100 MIST: 100_000 computation + 988_000 new coin
	// + 99 net on the gas coin = 1_088_099 MIST, the mainnet gasSummary
	// of a SplitCoins + TransferObjects on 2026-11-03.
	approx(t, "rgp 100", suiTransferFeeMist(100), 1_088_099)
	// Doubling the reference price only moves the computation part.
	approx(t, "rgp 200", suiTransferFeeMist(200), 1_188_099)
	// 0.001088099 SUI at $0.89.
	approx(t, "usd", nativeToUSD(ChainConfig{Kind: KindSui}, 1_088_099, 0.89), 0.001088099*0.89)
}

func TestEVMTransferUSD(t *testing.T) {
	// Somnia at 6 gwei base, no tip, SOMI $0.163: 6e9 * 21000 wei.
	wei := 6e9 * evmGasNativeTransfer
	approx(t, "somnia", nativeToUSD(ChainConfig{Kind: KindEVM}, wei, 0.163), 0.000126*0.163)
}

func TestSplitMobulaKeys(t *testing.T) {
	slugs, ids := splitMobulaKeys([]string{"ethereum", "100011700", "mantle", "4313", ""})
	if len(slugs) != 3 || slugs[0] != "ethereum" || slugs[1] != "mantle" {
		t.Fatalf("slugs %v", slugs)
	}
	if len(ids) != 2 || ids[0] != "100011700" || ids[1] != "4313" {
		t.Fatalf("ids %v", ids)
	}
}

func TestEveryChainHasFetcherAndDecimals(t *testing.T) {
	seen := map[string]bool{}
	for _, ch := range loadConfig().Chains {
		if seen[ch.Slug] {
			t.Fatalf("duplicate slug %s", ch.Slug)
		}
		seen[ch.Slug] = true
		if getFetcher(ch) == nil {
			t.Fatalf("%s: no fetcher for kind %s", ch.Slug, ch.Kind)
		}
		if ch.MobulaSlug == "" {
			t.Fatalf("%s: no Mobula key", ch.Slug)
		}
		if ch.Layer != "l1" && ch.Layer != "l2" {
			t.Fatalf("%s: layer %q", ch.Slug, ch.Layer)
		}
	}
}
