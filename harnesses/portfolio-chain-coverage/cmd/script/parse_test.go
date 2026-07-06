package main

import (
	"sort"
	"testing"
)

// ─── CoinStats ──────────────────────────────────────────────────────

func TestParseCoinStatsBlockchains(t *testing.T) {
	fixture := `[
		{"name":"Ethereum","connectionId":"ethereum","chain":"ethereum"},
		{"name":"Solana","connectionId":"solana","chain":"solana"},
		{"name":"Bitcoin","connectionId":"bitcoin","chain":"bitcoin"},
		{"name":"Broken row"}
	]`
	n, chainOf, err := parseCoinStatsBlockchains([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 3 {
		t.Fatalf("listed = %d, want 3 (row without connectionId must not count)", n)
	}
	if chainOf["solana"] != "solana" {
		t.Fatalf("chainOf[solana] = %q, want solana", chainOf["solana"])
	}
}

func TestParseCoinStatsBlockchainsBadShape(t *testing.T) {
	if _, _, err := parseCoinStatsBlockchains([]byte(`{"error":"nope"}`)); err == nil {
		t.Fatal("expected error on non-array shape")
	}
}

func TestCountDeduped(t *testing.T) {
	sweep := map[string]bool{"celo": true, "arbitrum-one": true}
	probes := map[string]bool{
		"celo-wallet":    true, // chain key already in sweep -> no double count
		"solana":         true, // distinct chain
		"terra-wallet":   true, // shares chain key with terra-wallet-2 but
		"terra-wallet-2": true, // distinct networks -> both count
		"mystery-wallet": true, // unknown connectionId -> counts as-is
	}
	chainOf := map[string]string{
		"celo-wallet":    "celo",
		"solana":         "solana",
		"terra-wallet":   "terra",
		"terra-wallet-2": "terra",
	}
	if got := countDeduped(sweep, probes, chainOf); got != 6 {
		t.Fatalf("countDeduped = %d, want 6 (2 sweep + 4 probes, celo deduped)", got)
	}
}

func TestParseCoinStatsMultiBalances(t *testing.T) {
	fixture := `[
		{"blockchain":"ethereum","balances":[
			{"coinId":"ethereum","amount":1.5,"price":3000},
			{"coinId":"dust","amount":0.000001,"price":0.01}
		]},
		{"blockchain":"polygon","balances":[
			{"coinId":"spam-token","amount":9999,"price":0.00001}
		]},
		{"blockchain":"nopriced","balances":[
			{"coinId":"weird","amount":42}
		]},
		{"blockchain":"empty","balances":[]}
	]`
	chains, err := parseCoinStatsMultiBalances([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sort.Strings(chains)
	// ethereum: $4500 > $1 -> verified.
	// polygon: $0.09 -> not verified.
	// nopriced: no USD anywhere but amount > 0 -> verified.
	// empty: nothing -> not verified.
	want := []string{"ethereum", "nopriced"}
	if len(chains) != len(want) {
		t.Fatalf("chains = %v, want %v", chains, want)
	}
	for i := range want {
		if chains[i] != want[i] {
			t.Fatalf("chains = %v, want %v", chains, want)
		}
	}
}

func TestParseCoinStatsSingleBalance(t *testing.T) {
	verified, err := parseCoinStatsSingleBalance([]byte(
		`[{"coinId":"bitcoin","amount":248000,"price":100000}]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !verified {
		t.Fatal("high-value balance should verify")
	}

	verified, err = parseCoinStatsSingleBalance([]byte(
		`[{"coinId":"bitcoin","amount":0.0000001,"price":100000}]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verified {
		t.Fatal("$0.01 of dust must not verify")
	}

	verified, err = parseCoinStatsSingleBalance([]byte(`[]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if verified {
		t.Fatal("empty balance list must not verify")
	}
}

// ─── Zerion ─────────────────────────────────────────────────────────

func TestParseZerionChains(t *testing.T) {
	fixture := `{"links":{"self":"https://api.zerion.io/v1/chains/"},"data":[
		{"type":"chains","id":"ethereum","attributes":{"name":"Ethereum"}},
		{"type":"chains","id":"base","attributes":{"name":"Base"}},
		{"type":"chains","id":"arbitrum","attributes":{"name":"Arbitrum"}}
	]}`
	n, ids, err := parseZerionChains([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ids["ethereum"] {
		t.Fatal("normalized id set must contain ethereum")
	}
	if n != 3 {
		t.Fatalf("listed = %d, want 3", n)
	}
}

func TestParseZerionPortfolio(t *testing.T) {
	fixture := `{"data":{"type":"portfolio","id":"perf","attributes":{
		"positions_distribution_by_type":{"wallet":123.0},
		"positions_distribution_by_chain":{
			"ethereum":1250000.55,
			"base":42.0,
			"polygon":0.20,
			"scroll":0
		}
	}}}`
	chains, err := parseZerionPortfolio([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// ethereum + base clear $1; polygon (=$0.20) and scroll (=$0) do not.
	if len(chains) != 2 {
		t.Fatalf("verified = %v, want [base ethereum]", chains)
	}
	sort.Strings(chains)
	if chains[0] != "base" || chains[1] != "ethereum" {
		t.Fatalf("chains = %v, want [base ethereum]", chains)
	}
}

// ─── Zapper ─────────────────────────────────────────────────────────

func TestParseZapperPortfolio(t *testing.T) {
	fixture := `{"data":{"portfolioV2":{"tokenBalances":{"byNetwork":{"edges":[
		{"node":{"network":{"name":"Ethereum","slug":"ethereum","chainId":1},"balanceUSD":345678.12}},
		{"node":{"network":{"name":"Base","slug":"base","chainId":8453},"balanceUSD":12.5}},
		{"node":{"network":{"name":"Degen","slug":"degen","chainId":666666666},"balanceUSD":0.03}},
		{"node":{"network":{"name":"Base","slug":"base","chainId":8453},"balanceUSD":99.0}}
	]}}}}}`
	listed, verified, err := parseZapperPortfolio([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 3 distinct networks visible (base deduped), 2 above $1.
	if listed != 3 {
		t.Fatalf("listed = %d, want 3", listed)
	}
	if verified != 2 {
		t.Fatalf("verified = %d, want 2", verified)
	}
}

func TestParseZapperPortfolioGraphQLError(t *testing.T) {
	fixture := `{"errors":[{"message":"Cannot query field \"bogus\" on type \"PortfolioV2\""}],"data":null}`
	if _, _, err := parseZapperPortfolio([]byte(fixture)); err == nil {
		t.Fatal("expected error when GraphQL returns an errors array")
	}
}

// ─── Mobula ─────────────────────────────────────────────────────────

func TestParseMobulaBlockchainsWrapped(t *testing.T) {
	fixture := `{"data":[{"name":"Ethereum"},{"name":"Base"},{"name":"Solana"},{"name":"Bitcoin"}]}`
	n, _, err := parseMobulaBlockchains([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 4 {
		t.Fatalf("listed = %d, want 4", n)
	}
}

func TestParseMobulaBlockchainsBareArray(t *testing.T) {
	fixture := `[{"name":"Ethereum"},{"name":"Base"}]`
	n, _, err := parseMobulaBlockchains([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Fatalf("listed = %d, want 2", n)
	}
}

func TestParseMobulaBlockchainsBadShape(t *testing.T) {
	if _, _, err := parseMobulaBlockchains([]byte(`"nope"`)); err == nil {
		t.Fatal("expected error on unexpected shape")
	}
}

func TestParseMobulaPortfolio(t *testing.T) {
	fixture := `{"data":{"total_wallet_balance":123456.78,"assets":[
		{"asset":{"symbol":"ETH"},"price":3000,
		 "cross_chain_balances":{
			"Ethereum":{"balance":10.5,"chainId":"evm:1"},
			"Base":{"balance":0.0001,"chainId":"evm:8453"},
			"Arbitrum":{"balance":2.0,"balanceUSD":6000,"chainId":"evm:42161"}
		 }},
		{"asset":{"symbol":"OBSCURE"},"price":0,
		 "cross_chain_balances":{
			"WeirdChain":{"balance":5.0}
		 }},
		{"asset":{"symbol":"USDC"},"price":1,
		 "cross_chain_balances":{
			"Base":{"balance":250.0,"chainId":"evm:8453"}
		 }}
	]}}`
	chains, err := parseMobulaPortfolio([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sort.Strings(chains)
	// Ethereum: 10.5*3000 > $1. Base: dust on ETH but $250 USDC on the
	// later asset -> verified. Arbitrum: explicit balanceUSD. WeirdChain:
	// no pricing anywhere + amount > 0 -> verified via native fallback.
	want := []string{"Arbitrum", "Base", "Ethereum", "WeirdChain"}
	if len(chains) != len(want) {
		t.Fatalf("chains = %v, want %v", chains, want)
	}
	for i := range want {
		if chains[i] != want[i] {
			t.Fatalf("chains = %v, want %v", chains, want)
		}
	}
}

// ─── Moralis ────────────────────────────────────────────────────────

func TestParseMoralisNetWorth(t *testing.T) {
	fixture := `{"total_networth_usd":"4507.10","chains":[
		{"chain":"eth","networth_usd":"4500.00"},
		{"chain":"polygon","networth_usd":"0.09"},
		{"chain":"base","networth_usd":"7.01"},
		{"chain":"eth","networth_usd":"4500.00"},
		{"chain":"cronos","networth_usd":"not-a-number"}
	],"unsupported_chain_ids":["0xdead"],"unavailable_chains":[]}`
	listed, verified, err := parseMoralisNetWorth([]byte(fixture))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// eth deduped; unsupported candidates never echo back into chains.
	if listed != 4 {
		t.Fatalf("listed = %d, want 4", listed)
	}
	// eth + base clear $1; polygon is dust; cronos value unparseable.
	if verified != 2 {
		t.Fatalf("verified = %d, want 2", verified)
	}
}

func TestParseMoralisNetWorthBadShape(t *testing.T) {
	if _, _, err := parseMoralisNetWorth([]byte(`{"message":"invalid key"}`)); err == nil {
		t.Fatal("expected error on missing chains array")
	}
}

func TestParseMoralisSolPortfolio(t *testing.T) {
	ok, err := parseMoralisSolPortfolio([]byte(
		`{"nativeBalance":{"solana":"12.5","lamports":"12500000000"},"tokens":[]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("native amount > 0 should verify")
	}

	ok, err = parseMoralisSolPortfolio([]byte(
		`{"nativeBalance":{"solana":"0"},"tokens":[{"amount":"250.0"}]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("token amount > 0 should verify")
	}

	ok, err = parseMoralisSolPortfolio([]byte(
		`{"nativeBalance":{"solana":"0"},"tokens":[]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("empty portfolio must not verify")
	}
}

func TestParseMoralisNativeBalance(t *testing.T) {
	ok, err := parseMoralisNativeBalance([]byte(`{"balance":"141326813691128959308262"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("positive wei balance should verify")
	}

	ok, err = parseMoralisNativeBalance([]byte(`{"balance":"0"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("zero balance must not verify")
	}

	if _, err := parseMoralisNativeBalance([]byte(`{"message":"nope"}`)); err == nil {
		t.Fatal("expected error on missing balance field")
	}
}
