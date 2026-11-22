package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func abiWord(n int64) string {
	v := big.NewInt(n)
	if n < 0 {
		v.Add(v, twoPow256)
	}
	return "0x" + abiUint(v)
}

const (
	headlineShortCall = 1
	millionShortCall  = 7
	gainsTakerBps     = 3.5
)

var gmxTestFees = gmxFeeFactors{PositiveBps: 4, NegativeBps: 6}

func gmxTestPrices() gmxMarketPrices {
	r := func(lo, hi int64) gmxPriceRange {
		return gmxPriceRange{Min: big.NewInt(lo), Max: big.NewInt(hi)}
	}
	return gmxMarketPrices{Index: r(1999, 2001), Long: r(20, 22), Short: r(30, 32)}
}

func TestGainsImpactProbe(t *testing.T) {
	probe := gainsImpactProbe(1, 0.5, gainsTakerBps)

	calls := probe.CallsFor(10000)
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(calls))
	}
	wantCumulLong := "0x6901d442" + strings.Repeat("0", 64) +
		abiUint64(1) + abiUint64(1) +
		"00000000000000000000000000000000000000000000021e19e0c9bab2400000" +
		abiUint64(0) + abiUint64(1) + abiUint64(0)
	if calls[0].Data != wantCumulLong {
		t.Errorf("cumul long calldata\n got %s\nwant %s", calls[0].Data, wantCumulLong)
	}

	if _, err := probe.CostFrom([]string{"0x01", abiWord(0)}); err == nil {
		t.Error("short impact reply accepted")
	}
}

func TestGMXImpactProbe(t *testing.T) {
	probe := gmxImpactProbe(gmxMarkets["ETH"], gmxTestPrices(), gmxTestFees)

	calls := probe.CallsFor(1e6)
	want := "0x689031a2" +
		"000000000000000000000000fd70de6b91282d8017aa4e741e9ae325cab992d8" +
		"00000000000000000000000070d95587d40a2caf56bd97485ab3eec10bee6336" +
		abiUint64(1999) + abiUint64(2001) + abiUint64(20) + abiUint64(22) +
		abiUint64(30) + abiUint64(32) + abiUint64(0) + abiUint64(0) +
		strings.Repeat("0", 34) + "c097ce7bc90715b34b9f1000000000" +
		abiUint64(0) + abiUint64(1)
	if len(calls) != 2 || calls[0].To != gmxReader || calls[0].Data != want {
		t.Fatalf("long call\n got %+v\nwant %s", calls[0], want)
	}

	exec := func(px int64) string { return abiWord(0) + abiUint64(uint64(px)) + abiBool(false) }
	if _, err := probe.CostFrom([]string{exec(0), exec(1998)}); err == nil {
		t.Error("zero execution price accepted")
	}
	short := abiWord(0) + abiUint64(2001)
	if _, err := probe.CostFrom([]string{short, exec(1998)}); err == nil {
		t.Error("reply without balanceWasImproved accepted")
	}
}

type rpcAnswer func(id int, data string) map[string]any

func fakeRPC(t *testing.T, answer rpcAnswer) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var calls []struct {
			ID     int   `json:"id"`
			Params []any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&calls); err != nil {
			t.Errorf("decode batch: %v", err)
			return
		}
		out := make([]map[string]any, 0, len(calls))
		for i := len(calls) - 1; i >= 0; i-- {
			data := calls[i].Params[0].(map[string]any)["data"].(string)
			reply := answer(calls[i].ID, data)
			reply["id"] = calls[i].ID
			out = append(out, reply)
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
}

func argWord(data string, i int) string {
	return data[len("0x")+8+i*abiWordHexLen : len("0x")+8+(i+1)*abiWordHexLen]
}

func gmxSizeStep(data string) int64 {
	size, _ := new(big.Int).SetString(argWord(data, 10), 16)
	usd := new(big.Int).Quo(size, usdScaled(1, gmxUSDDecimals))
	return int64(len(usd.String()) - 3)
}

func gmxAnswer(broken map[int]map[string]any) rpcAnswer {
	return func(id int, data string) map[string]any {
		if reply, ok := broken[id]; ok {
			return reply
		}
		k := gmxSizeStep(data)
		long := strings.HasSuffix(data, abiBool(true))
		px := 2000 - 2*k
		if long {
			px = 2000 + k
		}
		improved := long && k == 1
		return map[string]any{"result": abiWord(0) + abiUint64(uint64(px)) + abiBool(improved)}
	}
}

func quoteGMX(t *testing.T, broken map[int]map[string]any) *PerpSample {
	t.Helper()
	srv := fakeRPC(t, gmxAnswer(broken))
	defer srv.Close()
	probe := gmxImpactProbe(gmxMarkets["ETH"], gmxTestPrices(), gmxTestFees)
	quotes, err := quoteOracle(srv.Client(), srv.URL, oracleNotionals(1000), probe)
	if err != nil {
		t.Fatal(err)
	}
	s := &PerpSample{Venue: "gmx", Asset: "ETH"}
	applyOracleQuotes(s, 1000, quotes)
	return s
}

func TestOracleTiers_GMXPublishesEachSize(t *testing.T) {
	s := quoteGMX(t, nil)

	if s.Err != "" || s.TakerFeeBps != 5 || abs(s.SpreadBps-7.5) > 1e-9 ||
		abs(s.AllInBps-12.5) > 1e-9 {
		t.Fatalf("headline = %+v, want fee 5 (long 4, short 6) spread 7.5 all-in 12.5", s)
	}
	if len(s.Tiers) != len(tierNotionals) {
		t.Fatalf("tiers = %+v", s.Tiers)
	}
	for i, tier := range s.Tiers {
		spread := 7.5 * float64(i+1)
		fee := gmxTestFees.NegativeBps
		if i == 0 {
			fee = 5
		}
		if tier.Notional != notionalLabel(tierNotionals[i]) ||
			abs(tier.SpreadBps-spread) > 1e-9 || abs(tier.AllInBps-fee-spread) > 1e-9 {
			t.Errorf("tier %d = %+v, want spread %v fee %v", i, tier, spread, fee)
		}
	}
}

func TestOracleTiers_AnyFailedCallIsAnError(t *testing.T) {
	reverted := map[string]any{"error": map[string]string{"message": "execution reverted"}}
	offOracle := map[string]any{"result": abiWord(0) + abiUint64(1000) + abiBool(false)}
	cases := map[string]map[int]map[string]any{
		"headline reverted":  {headlineShortCall: reverted},
		"$1M reverted":       {millionShortCall: reverted},
		"$1M off the oracle": {millionShortCall: offOracle},
	}
	for name, broken := range cases {
		s := quoteGMX(t, broken)

		if s.Err == "" || len(s.Tiers) != 0 || s.SpreadBps != 0 || s.AllInBps != 0 {
			t.Errorf("%s: published %+v", name, s)
		}
	}
}

func TestOracleTiers_GainsPairsEachImpactWithItsSide(t *testing.T) {
	bps := map[bool]int64{true: 2e8, false: -3e8}
	srv := fakeRPC(t, func(_ int, data string) map[string]any {
		long := argWord(data, 2) == abiBool(true)
		return map[string]any{"result": abiWord(bps[long])}
	})
	defer srv.Close()
	probe := gainsImpactProbe(1, 0.5, gainsTakerBps)

	quotes, err := quoteOracle(srv.Client(), srv.URL, oracleNotionals(1000), probe)
	if err != nil {
		t.Fatal(err)
	}
	s := &PerpSample{Venue: "gains", Asset: "ETH"}
	applyOracleQuotes(s, 1000, quotes)

	if s.Err != "" || abs(s.SpreadBps-3) > 1e-9 || abs(s.AllInBps-6.5) > 1e-9 {
		t.Errorf("headline = %+v, want long 2.5 and short 3.5 averaged to 3", s)
	}
}

func TestEthCallBatch_RejectsMalformedReplies(t *testing.T) {
	cases := map[string]string{
		"missing id":  `[{"jsonrpc":"2.0","result":"0x01"},{"id":1,"result":"0x01"}]`,
		"repeated id": `[{"id":0,"result":"0x01"},{"id":0,"result":"0x01"}]`,
	}
	for name, body := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		_, err := ethCallBatch(srv.Client(), srv.URL, make([]ethCallMsg, 2))
		srv.Close()
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestOracleNotionals_AddsOffTierHeadline(t *testing.T) {
	got := oracleNotionals(2500)
	if len(got) != len(tierNotionals)+1 || got[len(got)-1] != 2500 {
		t.Errorf("oracleNotionals(2500) = %v", got)
	}
	if len(oracleNotionals(1000)) != len(tierNotionals) {
		t.Error("on-tier headline duplicated")
	}
}

func TestEthCallBatch_FailsCallsWithoutResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"id":0,"result":"0x"}]`))
	}))
	defer srv.Close()

	out, err := ethCallBatch(srv.Client(), srv.URL, make([]ethCallMsg, 2))
	if err != nil {
		t.Fatal(err)
	}
	for i, o := range out {
		if o.Err == nil {
			t.Errorf("call %d without a result accepted: %+v", i, o)
		}
	}
}

func singleRPC(t *testing.T, result string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func abiString(s string) string {
	data := []byte(s)
	padded := make([]byte, (len(data)+31)/32*32)
	copy(padded, data)
	return abiUint64(uint64(len(data))) + fmt.Sprintf("%x", padded)
}

func gainsPairReply(from string, spreadP, feeIndex uint64) string {
	words := []uint64{0x20, 320, 384, 0, 0, 0, 0, spreadP, 0, feeIndex, 0}
	reply := "0x"
	for _, w := range words {
		reply += abiUint64(w)
	}
	return reply + abiString(from) + abiString("USD")
}

func TestGainsReadPair_DecodesTheRequestedPair(t *testing.T) {
	srv := singleRPC(t, gainsPairReply("SOL", 1e8, 11))

	p, err := gainsReadPair(srv.Client(), srv.URL, 7)
	if err != nil {
		t.Fatal(err)
	}
	if p.Index != 7 || p.From != "SOL" || p.To != "USD" ||
		p.SpreadP.Int64() != 1e8 || p.FeeIndex != 11 {
		t.Errorf("pair = %+v", p)
	}
}

func TestGainsReadPrice_ReadsTheAnswerWord(t *testing.T) {
	srv := singleRPC(t, "0x"+abiUint64(99)+abiUint64(2000e8)+abiUint64(0)+abiUint64(0)+abiUint64(99))

	price, err := gainsReadPrice(srv.Client(), srv.URL, "ETH")
	if err != nil || price.Int64() != 2000e8 {
		t.Errorf("price = %v, %v; want 2000e8", price, err)
	}
}

func gainsChain(t *testing.T) *httptest.Server {
	t.Helper()
	cumul := map[bool]int64{true: 1e8, false: -1e8}
	reverted := map[string]string{"message": "execution reverted"}
	single := map[string]string{
		selPairs:           gainsPairReply("SOL", 2e8, 77),
		selFees:            "0x" + abiUint64(5e8),
		selLatestRoundData: "0x" + abiUint64(1) + abiUint64(150e8) + abiUint64(0) + abiUint64(0) + abiUint64(1),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
			var call rpcCall
			_ = json.Unmarshal(body, &call)
			data := call.Params[0].(map[string]any)["data"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 1, "result": single[data[:10]]})
			return
		}
		var calls []rpcCall
		_ = json.Unmarshal(body, &calls)
		out := make([]map[string]any, len(calls))
		for i, c := range calls {
			data := c.Params[0].(map[string]any)["data"].(string)
			if data[:10] != selCumulVolImpactP {
				out[i] = map[string]any{"id": c.ID, "error": reverted}
				continue
			}
			long := argWord(data, 2) == abiBool(true)
			out[i] = map[string]any{"id": c.ID, "result": abiWord(cumul[long])}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchGains_FeeHalfSpreadAndImpact(t *testing.T) {
	srv := gainsChain(t)

	s := fetchGains(VenueConfig{Slug: "gains", Asset: "SOL", NotionalUSD: 1000}, srv.URL)

	if s.Err != "" || s.TakerFeeBps != 5 || abs(s.SpreadBps-2) > 1e-9 ||
		abs(s.AllInBps-7) > 1e-9 || s.MidPrice != 150 || len(s.Tiers) != len(tierNotionals) {
		t.Errorf("sample = %+v, want fee 5, spread 1 + 1 = 2, all-in 7", s)
	}
}

func TestGMXFeeFactorsFrom_KeepsEachBranch(t *testing.T) {
	body := `{"data":{"marketInfos":[{"id":"m",` +
		`"positionFeeFactorForPositiveImpact":"400000000000000000000000000",` +
		`"positionFeeFactorForNegativeImpact":"600000000000000000000000000"}]}}`

	fees, err := gmxFeeFactorsFrom([]byte(body))
	if err != nil || fees.PositiveBps != 4 || fees.NegativeBps != 6 {
		t.Errorf("fees = %+v, %v; want positive 4 negative 6", fees, err)
	}
}

func TestPostJSON_ErrorHidesTheURLPath(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	endpoint := srv.URL + "/v2/secret-key"
	srv.Close()

	_, err := postJSON(srv.Client(), endpoint, map[string]string{})
	if err == nil || strings.Contains(err.Error(), "secret-key") {
		t.Errorf("err = %v, want an error without the URL path", err)
	}
}
