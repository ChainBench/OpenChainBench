package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// buildGainsLimitExecuted encodes the 25 data words of a LimitExecuted log
// with the fields the decoder reads. Amounts are in collateral units.
func buildGainsLimitExecuted(pairIdx uint32, leverage1e3 uint32, collateralIdx uint8, collateralAmount uint64, orderType uint8, collateralPriceUsd1e8 uint64) string {
	data := make([]byte, gainsLimitExecutedWords*32)
	put := func(word int, v uint64) { binary.BigEndian.PutUint64(data[word*32+24:word*32+32], v) }
	put(gainsWordPairIndex, uint64(pairIdx))
	put(gainsWordLeverage, uint64(leverage1e3))
	put(gainsWordCollateralIndex, uint64(collateralIdx))
	put(gainsWordCollateralAmount, collateralAmount)
	put(gainsWordOrderType, uint64(orderType))
	put(gainsWordCollateralPriceUS, collateralPriceUsd1e8)
	return "0x" + hex.EncodeToString(data)
}

func makeEthLog(data, blockNum string) ethLog {
	return ethLog{Data: data, BlockNumber: blockNum, TxHash: "0xtxhash", LogIndex: "0x0"}
}

var testDecimals = map[uint64]int{1: 18, 3: 6}

func TestGainsTopicIsLimitExecuted(t *testing.T) {
	// keccak256 of the ABI signature; a wrong signature matched nothing on
	// the diamond for a month, so the topic is pinned here.
	if len(gainsLimitExecutedTopic) != 66 {
		t.Fatalf("bad topic %q", gainsLimitExecutedTopic)
	}
	t.Logf("LimitExecuted topic0 = %s", gainsLimitExecutedTopic)
}

func TestDecodeGainsLimitExecuted_USDCLiquidation(t *testing.T) {
	// 1,000 USDC collateral (6 dp) at 10x, collateral price $1.00 -> $10,000.
	data := buildGainsLimitExecuted(1, 10_000, 3, 1_000_000_000, gainsOrderTypeLiqClose, 100_000_000)
	ev, matched, err := decodeGainsLimitExecuted(makeEthLog(data, "0x64"), 1, 0x100, 0, gainsBlockTimeMs, testDecimals)
	if err != nil {
		t.Fatal(err)
	}
	if !matched {
		t.Fatal("expected a match")
	}
	if ev.NotionalUSD < 9999 || ev.NotionalUSD > 10001 {
		t.Errorf("notional = %v, want ~10000", ev.NotionalUSD)
	}
	if ev.Key != "0xtxhash:0x0" {
		t.Errorf("key = %q", ev.Key)
	}
}

func TestDecodeGainsLimitExecuted_DAICollateralUsesDecimalsAndPrice(t *testing.T) {
	// 2 DAI (18 dp) at 50x, DAI at $0.999 -> 2 * 50 * 0.999 = $99.9.
	data := buildGainsLimitExecuted(0, 50_000, 1, 2_000_000_000_000_000_000, gainsOrderTypeLiqClose, 99_900_000)
	ev, matched, err := decodeGainsLimitExecuted(makeEthLog(data, "0x64"), 0, 0x100, 0, gainsBlockTimeMs, testDecimals)
	if err != nil || !matched {
		t.Fatalf("err=%v matched=%v", err, matched)
	}
	if ev.NotionalUSD < 99.8 || ev.NotionalUSD > 100 {
		t.Errorf("notional = %v, want ~99.9", ev.NotionalUSD)
	}
}

func TestDecodeGainsLimitExecuted_SkipsOtherOrderTypesAndPairs(t *testing.T) {
	tpClose := buildGainsLimitExecuted(1, 10_000, 3, 1_000_000_000, 4, 100_000_000)
	if _, matched, err := decodeGainsLimitExecuted(makeEthLog(tpClose, "0x64"), 1, 0x100, 0, gainsBlockTimeMs, testDecimals); err != nil || matched {
		t.Fatalf("TP_CLOSE must not match: err=%v matched=%v", err, matched)
	}
	otherPair := buildGainsLimitExecuted(7, 10_000, 3, 1_000_000_000, gainsOrderTypeLiqClose, 100_000_000)
	if _, matched, err := decodeGainsLimitExecuted(makeEthLog(otherPair, "0x64"), 1, 0x100, 0, gainsBlockTimeMs, testDecimals); err != nil || matched {
		t.Fatalf("other pair must not match: err=%v matched=%v", err, matched)
	}
}

func TestDecodeGainsLimitExecuted_RejectsWrongLengthAndUnknownCollateral(t *testing.T) {
	short := "0x" + hex.EncodeToString(make([]byte, 10*32))
	if _, _, err := decodeGainsLimitExecuted(makeEthLog(short, "0x64"), 1, 0x100, 0, gainsBlockTimeMs, testDecimals); err == nil {
		t.Fatal("expected an error for a 10-word log")
	}
	unknown := buildGainsLimitExecuted(1, 10_000, 9, 1_000_000_000, gainsOrderTypeLiqClose, 100_000_000)
	if _, _, err := decodeGainsLimitExecuted(makeEthLog(unknown, "0x64"), 1, 0x100, 0, gainsBlockTimeMs, testDecimals); err == nil {
		t.Fatal("expected an error for an unknown collateral index")
	}
}

func TestDecodeGainsLimitExecuted_TimestampFromBlockDistance(t *testing.T) {
	data := buildGainsLimitExecuted(1, 10_000, 3, 1_000_000_000, gainsOrderTypeLiqClose, 100_000_000)
	now := int64(1_000_000_000_000)
	ev, _, err := decodeGainsLimitExecuted(makeEthLog(data, "0x60"), 1, 0x64, now, 250, testDecimals)
	if err != nil {
		t.Fatal(err)
	}
	if ev.TimestampMs != now-4*250 {
		t.Errorf("timestamp = %d, want %d", ev.TimestampMs, now-4*250)
	}
}

// --- mock servers ---

func tradingVarsBody(pairs []map[string]any, collaterals []map[string]any) map[string]any {
	return map[string]any{"pairs": pairs, "collaterals": collaterals}
}

func gainsCollateral(idx int, symbol string, decimals int, priceUsd float64, pairOis []map[string]any) map[string]any {
	return map[string]any{
		"collateralIndex":  idx,
		"symbol":           symbol,
		"prices":           map[string]any{"collateralPriceUsd": priceUsd},
		"collateralConfig": map[string]any{"decimals": decimals},
		"pairOis":          pairOis,
	}
}

func gainsPairOI(oiLong, oiShort string) map[string]any {
	return map[string]any{"collateral": map[string]any{"oiLongCollateral": oiLong, "oiShortCollateral": oiShort}}
}

func tvServer(t *testing.T, body map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(body)
	}))
}

// mockRPCServer answers eth_blockNumber and eth_getLogs (every getLogs call
// returns the same logs).
func mockRPCServer(t *testing.T, blockHex string, logs []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var result any
		switch req.Method {
		case "eth_blockNumber":
			result = blockHex
		case "eth_getLogs":
			result = logs
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}))
}

func testGains(rpcURL, tvURL string) *Gains {
	g := NewGains(rpcURL)
	g.tradingVarsURL = tvURL
	return g
}

var usdcOnly = []map[string]any{
	gainsCollateral(3, "USDC", 6, 1.0, []map[string]any{gainsPairOI("1", "1"), gainsPairOI("1", "1")}),
}
var btcEthPairs = []map[string]any{{"from": "BTC"}, {"from": "ETH"}}

func TestGains_FetchLiquidationsSince_HappyPath(t *testing.T) {
	tv := tvServer(t, tradingVarsBody(btcEthPairs, usdcOnly))
	defer tv.Close()
	logs := []map[string]any{
		{"address": gainsDiamond, "topics": []string{gainsLimitExecutedTopic}, "data": buildGainsLimitExecuted(1, 10_000, 3, 1_000_000_000, gainsOrderTypeLiqClose, 100_000_000), "blockNumber": "0x64", "transactionHash": "0xtx1", "logIndex": "0x0", "removed": false},
		{"address": gainsDiamond, "topics": []string{gainsLimitExecutedTopic}, "data": buildGainsLimitExecuted(1, 5_000, 3, 2_000_000_000, gainsOrderTypeLiqClose, 100_000_000), "blockNumber": "0x64", "transactionHash": "0xtx2", "logIndex": "0x1", "removed": false},
		{"address": gainsDiamond, "topics": []string{gainsLimitExecutedTopic}, "data": buildGainsLimitExecuted(1, 5_000, 3, 2_000_000_000, 5, 100_000_000), "blockNumber": "0x64", "transactionHash": "0xtx3", "logIndex": "0x0", "removed": false},
	}
	srv := mockRPCServer(t, "0x64", logs) // block 100: one getLogs call
	defer srv.Close()
	events, err := testGains(srv.URL, tv.URL).FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 liquidations (the SL_CLOSE skipped), got %d", len(events))
	}
}

func TestGains_FetchLiquidationsSince_RPCError(t *testing.T) {
	tv := tvServer(t, tradingVarsBody(btcEthPairs, usdcOnly))
	defer tv.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }))
	defer srv.Close()
	if _, err := testGains(srv.URL, tv.URL).FetchLiquidationsSince("ETH", 0); err == nil {
		t.Fatal("expected error from RPC failure, got nil")
	}
}

func TestGains_FetchLiquidationsSince_LastBlockAdvances(t *testing.T) {
	tv := tvServer(t, tradingVarsBody(btcEthPairs, usdcOnly))
	defer tv.Close()
	srv := mockRPCServer(t, "0x100", []map[string]any{})
	defer srv.Close()
	g := testGains(srv.URL, tv.URL)
	if _, err := g.FetchLiquidationsSince("ETH", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	g.mu.Lock()
	lb := g.lastBlock["ETH"]
	g.mu.Unlock()
	if lb == 0 {
		t.Error("lastBlock should advance after successful fetch")
	}
}

func TestGains_FetchOI_SumsCollateralsInUSD(t *testing.T) {
	// ETH: USDC long 28,438.44 + short 27,484.85 = 55,923.29 USD at $1;
	// WETH (18 dp) long 1 + short 1 = 2 WETH at $2,500 = 5,000 USD.
	collaterals := []map[string]any{
		gainsCollateral(3, "USDC", 6, 1.0, []map[string]any{gainsPairOI("74229636084", "86846986430"), gainsPairOI("28438439935", "27484847710")}),
		gainsCollateral(2, "WETH", 18, 2500, []map[string]any{gainsPairOI("0", "0"), gainsPairOI("1000000000000000000", "1000000000000000000")}),
	}
	tv := tvServer(t, tradingVarsBody(btcEthPairs, collaterals))
	defer tv.Close()
	oi, err := testGains("unused", tv.URL).FetchOI("eth")
	if err != nil {
		t.Fatal(err)
	}
	if oi < 60_923 || oi > 60_924 {
		t.Errorf("oi = %v, want ~60923.29", oi)
	}
}

func TestGains_FetchOI_UnknownAsset(t *testing.T) {
	tv := tvServer(t, tradingVarsBody(btcEthPairs, usdcOnly))
	defer tv.Close()
	if _, err := testGains("unused", tv.URL).FetchOI("DOGE"); err == nil {
		t.Fatal("expected error for unknown asset")
	}
}

func TestGainsMulti_SumsChainsAndFailsClosed(t *testing.T) {
	tv := tvServer(t, tradingVarsBody(btcEthPairs, usdcOnly))
	defer tv.Close()
	a := testGains("unused", tv.URL)
	b := testGains("unused", tv.URL)
	m := NewGainsMulti(a, b)
	oi, err := m.FetchOI("ETH")
	if err != nil || oi != 4e-6 {
		t.Fatalf("oi=%v err=%v, want the two chains summed (2 x 2 units / 1e6)", oi, err)
	}
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer broken.Close()
	m2 := NewGainsMulti(a, testGains("unused", broken.URL))
	if _, err := m2.FetchOI("ETH"); err == nil {
		t.Fatal("one deployment failing must fail the venue, not publish a partial OI")
	}
}
