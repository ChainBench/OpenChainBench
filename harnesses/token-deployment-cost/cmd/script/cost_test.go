package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestEveryChainHasASamplerAndAUniqueSlug(t *testing.T) {
	seen := map[string]bool{}
	for _, ch := range loadConfig().Chains {
		if _, ok := samplers[ch.Kind]; !ok {
			t.Errorf("%s: no sampler for kind %q", ch.Slug, ch.Kind)
		}
		if seen[ch.Slug] {
			t.Errorf("duplicate slug %s", ch.Slug)
		}
		seen[ch.Slug] = true
		if ch.MobulaSymbol == "" {
			t.Errorf("%s: no price symbol", ch.Slug)
		}
		if (ch.Kind == KindEVM || ch.Kind == KindOPStack) && ch.From == "" {
			t.Errorf("%s: EVM chain without a from address", ch.Slug)
		}
	}
	// Mobula's TON ticker is Tokamak Network, not the chain's coin.
	for _, ch := range loadConfig().Chains {
		if ch.Slug == "gram" && ch.MobulaSymbol != "GRAM" {
			t.Errorf("gram priced with %q, want GRAM", ch.MobulaSymbol)
		}
	}
}

func TestNativeUnits(t *testing.T) {
	cases := []struct {
		unit string
		base float64
		want float64
	}{
		{"microalgo", 101_000, 0.101},
		{"ton-nano", 5_001_810, 0.00500181},
		{"yocto", 2.2334e24, 2.2334},
		{"e8s", 27_239_050, 0.2723905},
		{"wei", 1e18, 1},
	}
	for _, c := range cases {
		if got := nativeFromBase(c.base, c.unit); !near(got, c.want, 1e-12) {
			t.Errorf("%s: %v -> %v, want %v", c.unit, c.base, got, c.want)
		}
	}
}

func TestERC20InitCodeIsTheCompiledArtifact(t *testing.T) {
	code := canonicalERC20Init()
	raw, err := hex.DecodeString(strings.TrimPrefix(code, "0x"))
	if err != nil {
		t.Fatalf("init code is not hex: %v", err)
	}
	// contracts/compile.mjs prints 3096 bytes of init code for Token.sol.
	if len(raw) != 3096 {
		t.Fatalf("init code is %d bytes, want 3096 (recompile contracts/Token.sol?)", len(raw))
	}
	if !strings.HasPrefix(code, "0x60806040") {
		t.Fatalf("init code does not start with the solc prologue: %.20s", code)
	}
	// The old placeholder carried a fake deadbeef metadata hash.
	if strings.Contains(code, "deadbeef") {
		t.Fatal("placeholder bytecode is back")
	}
}

func TestEVMDeployFee(t *testing.T) {
	// Kaia on 2026-11-03: 549,647 gas x 27.5 gwei = 0.0151152925 KAIA.
	fee := evmDeployFeeWei(big.NewInt(549_647), big.NewInt(27_500_000_000))
	f, _ := new(big.Float).SetInt(fee).Float64()
	if got := nativeFromBase(f, "wei"); !near(got, 0.0151152925, 1e-12) {
		t.Fatalf("kaia fee %v KAIA", got)
	}
}

func TestEVMSamplerAgainstStubRPC(t *testing.T) {
	var gotData string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "eth_estimateGas":
			p := req.Params[0].(map[string]any)
			gotData, _ = p["data"].(string)
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":"0x878a9"}`) // 555177
		case "eth_gasPrice":
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":2,"result":"0x3b9aca00"}`) // 1 gwei
		}
	}))
	defer srv.Close()
	s := samplers[KindEVM]
	got, err := s.Sample(ChainConfig{Slug: "x", RPCURL: srv.URL, From: defaultFrom})
	if err != nil {
		t.Fatal(err)
	}
	if gotData != canonicalERC20Init() {
		t.Fatal("eth_estimateGas did not receive the pinned init code")
	}
	if got.CostNative != 555177e9 || got.NativeUnit != "wei" || got.GasUnits != 555177 {
		t.Fatalf("sample %+v", got)
	}
}

func TestAlgorandASACost(t *testing.T) {
	// fee-per-byte 0 (normal): min fee 1000 + 100,000 min balance.
	if got := algorandASACost(1000, 0); got != 101_000 {
		t.Fatalf("normal: %d", got)
	}
	// Congestion: 10 microAlgo/byte x 250 bytes beats the min fee.
	if got := algorandASACost(1000, 10); got != 102_500 {
		t.Fatalf("congested: %d", got)
	}
}

func TestAlgorandSamplerRejectsMissingParams(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"last-round":1}`)
	}))
	defer srv.Close()
	if _, err := samplers[KindAlgorand].Sample(ChainConfig{RPCURL: srv.URL}); err == nil {
		t.Fatal("params without min-fee must be an error, not a 0.1 ALGO deploy")
	}
}

// The basechain config in force on 2026-05-08 (and still on 2026-11-03).
var tonRefGas = tonGasPrices{FlatGasLimit: 100, FlatGasPrice: 6667, GasPrice: 4369067}
var tonRefMsg = tonMsgPrices{LumpPrice: 66667, BitPrice: 4369067, CellPrice: 436906667}

func TestTONReproducesTheReferenceTrace(t *testing.T) {
	// Per-transaction gas fees recorded in trace acce6cf1...b382.
	wantGas := []uint64{329268, 443734, 668268, 51868, 51868}
	for i, g := range tonJettonGas {
		if got := tonGasFee(tonRefGas, g); got != wantGas[i] {
			t.Errorf("gas fee tx %d: %d, want %d", i, got, wantGas[i])
		}
	}
	// Forward fees recorded in the action phases.
	if got := tonFwdFee(tonRefMsg, tonJettonIntMsgs[0]); got != 1300134 {
		t.Errorf("deploy message fwd fee %d, want 1300134", got)
	}
	if got := tonFwdFee(tonRefMsg, tonJettonIntMsgs[1]); got != 664934 {
		t.Errorf("jetton wallet message fwd fee %d, want 664934", got)
	}
	if got := tonFwdFee(tonRefMsg, tonJettonIntMsgs[2]) + tonFwdFee(tonRefMsg, tonJettonIntMsgs[3]); got != 151135 {
		t.Errorf("notify+excess fwd fees %d, want 151135", got)
	}
	total, gas := tonJettonDeployNanoton(tonRefGas, tonRefMsg)
	// The trace burned 5,001,838 nanoton (total_fees + imported fwd fees).
	if d := int64(total) - 5_001_838; d < -100 || d > 100 {
		t.Fatalf("model %d nanoton vs trace 5001838 (diff %d)", total, d)
	}
	if gas != 23175 {
		t.Fatalf("gas %d", gas)
	}
}

func TestTONScalesWithConfig(t *testing.T) {
	// The 2024 basechain prices were exactly 6x today's: the model must
	// follow the config, not a constant.
	old := tonGasPrices{FlatGasLimit: 100, FlatGasPrice: 40000, GasPrice: 26214400}
	oldMsg := tonMsgPrices{LumpPrice: 400000, BitPrice: 26214400, CellPrice: 2621440000}
	now, _ := tonJettonDeployNanoton(tonRefGas, tonRefMsg)
	then, _ := tonJettonDeployNanoton(old, oldMsg)
	if r := float64(then) / float64(now); !near(r, 6, 0.01) {
		t.Fatalf("ratio %v, want 6", r)
	}
}

func TestTONSamplerParsesTonapiConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/blockchain/config" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"21":{"gas_limits_prices":{"flat_gas_limit":100,"flat_gas_price":6667,"gas_price":4369067}},
		"25":{"msg_forward_prices":{"lump_price":66667,"bit_price":4369067,"cell_price":436906667}}}`)
	}))
	defer srv.Close()
	got, err := samplers[KindTON].Sample(ChainConfig{RPCURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	want, _ := tonJettonDeployNanoton(tonRefGas, tonRefMsg)
	if got.CostNative != float64(want) || got.NativeUnit != "ton-nano" {
		t.Fatalf("sample %+v", got)
	}
}

func TestNearDepositParseAndCost(t *testing.T) {
	// "2233430000000000000000000" as call_function bytes.
	s := `"2233430000000000000000000"`
	nums := make([]string, len(s))
	for i := range s {
		nums[i] = fmt.Sprint(int(s[i]))
	}
	res := json.RawMessage(`{"result":[` + strings.Join(nums, ",") + `],"logs":[]}`)
	dep, err := parseNearRequiredDeposit(res)
	if err != nil {
		t.Fatal(err)
	}
	total := nearTokenCostYocto(dep, 100_000_000)
	f, _ := new(big.Float).SetInt(total).Float64()
	// 2.23343 NEAR stake + 106 Tgas x 1e8 = 0.0106 NEAR.
	if got := nativeFromBase(f, "yocto"); !near(got, 2.24403, 1e-9) {
		t.Fatalf("near cost %v NEAR", got)
	}
	if _, err := parseNearRequiredDeposit(json.RawMessage(`{"result":[],"error":"wasm execution failed"}`)); err == nil {
		t.Fatal("a panicking view call must be an error")
	}
}

func TestNearSamplerFallsBackToTheNextEndpoint(t *testing.T) {
	limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-429,"message":"Rate limits exceeded"}}`)
	}))
	defer limited.Close()
	dep := `"2233430000000000000000000"`
	nums := make([]string, len(dep))
	for i := range dep {
		nums[i] = fmt.Sprint(int(dep[i]))
	}
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Method == "gas_price" {
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"gas_price":"100000000"}}`)
			return
		}
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"result":[`+strings.Join(nums, ",")+`],"logs":[]}}`)
	}))
	defer ok.Close()
	got, err := samplers[KindNear].Sample(ChainConfig{RPCURL: limited.URL + "," + ok.URL})
	if err != nil {
		t.Fatal(err)
	}
	if v := nativeFromBase(got.CostNative, got.NativeUnit); !near(v, 2.24403, 1e-9) {
		t.Fatalf("near %v", v)
	}
	if _, err := samplers[KindNear].Sample(ChainConfig{RPCURL: limited.URL}); err == nil {
		t.Fatal("every endpoint limited must be an error")
	}
}

func TestPriceCacheExpires(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	p := newPriceCache()
	p.now = func() time.Time { return clock }
	p.setAll(map[string]float64{"SOL": 93})
	if v, ok := p.get("SOL"); !ok || v != 93 {
		t.Fatalf("fresh price: %v %v", v, ok)
	}
	clock = clock.Add(priceMaxAge + time.Minute)
	if _, ok := p.get("SOL"); ok {
		t.Fatal("a price older than priceMaxAge must read as missing")
	}
	if _, ok := p.get("ALGO"); ok {
		t.Fatal("unknown symbol")
	}
}

func TestICPConversion(t *testing.T) {
	// 18356 permyriad = 1.8356 XDR per ICP = 1.8356e12 cycles per ICP.
	e8s := icpCyclesToE8s(icpCanisterCreationCycles, 18356)
	if got := nativeFromBase(e8s, "e8s"); !near(got, 500e9/1.8356e12, 1e-12) {
		t.Fatalf("icp %v", got)
	}
}

func TestICPSamplerRejectsStaleRate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"icp_xdr_conversion_rates":[[1793717240,18356]]}`)
	}))
	defer srv.Close()
	fresh := &icpSampler{http: srv.Client(), now: func() time.Time { return time.Unix(1793717240+600, 0) }}
	got, err := fresh.Sample(ChainConfig{RPCURL: srv.URL})
	if err != nil || !near(got.CostNative, 500e9/18356, 1e-6) {
		t.Fatalf("fresh: %+v %v", got, err)
	}
	stale := &icpSampler{http: srv.Client(), now: func() time.Time { return time.Unix(1793717240+3*86400, 0) }}
	if _, err := stale.Sample(ChainConfig{RPCURL: srv.URL}); err == nil {
		t.Fatal("a 3 day old rate must be an error")
	}
}

func TestSuiGasPriceParse(t *testing.T) {
	if gp, err := parseSuiGasPrice([]byte(`{"data":{"epoch":{"epochId":1300,"referenceGasPrice":"100"}}}`)); err != nil || gp != 100 {
		t.Fatalf("ok case: %d %v", gp, err)
	}
	for _, body := range []string{
		`{"data":{"epoch":{"referenceGasPrice":"0"}}}`,
		`{"errors":[{"message":"boom"}]}`,
		`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Sui JSON-RPC endpoint has been deprecated"}}`,
	} {
		if _, err := parseSuiGasPrice([]byte(body)); err == nil {
			t.Errorf("want error for %s", body)
		}
	}
}

func TestAptosRejectsErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"message":"rate limited"}`)
	}))
	defer srv.Close()
	if _, err := samplers[KindAptos].Sample(ChainConfig{RPCURL: srv.URL}); err == nil {
		t.Fatal("a 429 must be an error, not a free deploy")
	}
}
