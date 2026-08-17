package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// buildGainsData builds a 26-word (or 28-word if leadingWords>0) ABI-encoded
// TradeClosed event data blob for testing decodeGainsTradeClosed.
func buildGainsData(pairIdx uint32, leverage uint16, collateralUsdc uint64, cancelReason byte, leadingWords int) string {
	total := 26 + leadingWords
	data := make([]byte, total*32)
	base := leadingWords * 32 // tupleA starts after any leading words

	// word 1 of tupleA = pairIndex (uint32)
	binary.BigEndian.PutUint32(data[base+1*32+28:base+1*32+32], pairIdx)
	// word 4 of tupleA = leverage (uint16, 1e3 fixed point)
	binary.BigEndian.PutUint16(data[base+4*32+30:base+4*32+32], leverage)
	// word 5 of tupleA = collateral (USDC, 6 dp)
	binary.BigEndian.PutUint64(data[base+5*32+24:base+5*32+32], collateralUsdc)
	// last word = cancelReason
	data[total*32-1] = cancelReason

	return "0x" + hex.EncodeToString(data)
}

func makeEthLog(data, blockNum string) ethLog {
	return ethLog{
		Data:        data,
		BlockNumber: blockNum,
		TxHash:      "0xtxhash",
		LogIndex:    "0x0",
	}
}

func TestDecodeGainsTradeClosed_Liquidation(t *testing.T) {
	// leverage=10000 (10x, 1e3 precision), collateral=1000000000 (1000 USDC at 6dp)
	// notional = 1000000000/1e6 * 10000/1e3 = 1000 * 10 = 10000
	data := buildGainsData(0, 10000, 1000000000, 1, 0)
	lg := makeEthLog(data, "0x100")
	ev, matched, err := decodeGainsTradeClosed(lg, 0, 0x100, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !matched {
		t.Fatal("expected matched=true")
	}
	if ev.NotionalUSD < 9999 || ev.NotionalUSD > 10001 {
		t.Errorf("notional = %v, want ~10000", ev.NotionalUSD)
	}
}

func TestDecodeGainsTradeClosed_NotLiquidation(t *testing.T) {
	data := buildGainsData(0, 10000, 1000000000, 0, 0) // cancelReason=0
	lg := makeEthLog(data, "0x100")
	_, matched, err := decodeGainsTradeClosed(lg, 0, 0x100, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if matched {
		t.Fatal("expected matched=false for cancelReason=0")
	}
}

func TestDecodeGainsTradeClosed_WrongPair(t *testing.T) {
	// pairIndex=1, wantPair=0
	data := buildGainsData(1, 10000, 1000000000, 1, 0)
	lg := makeEthLog(data, "0x100")
	_, matched, err := decodeGainsTradeClosed(lg, 0, 0x100, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if matched {
		t.Fatal("expected matched=false for wrong pair")
	}
}

func TestDecodeGainsTradeClosed_ShortData(t *testing.T) {
	// Only 10 words — less than gainsTailWords (26)
	data := "0x" + hex.EncodeToString(make([]byte, 10*32))
	lg := makeEthLog(data, "0x100")
	_, _, err := decodeGainsTradeClosed(lg, 0, 0x100, 0)
	if err == nil {
		t.Fatal("expected error for short data, got nil")
	}
}

func TestDecodeGainsTradeClosed_28Words(t *testing.T) {
	// 28-word data (leading 2 words for address+uint32 inline, not indexed)
	data := buildGainsData(0, 10000, 1000000000, 1, 2)
	lg := makeEthLog(data, "0x100")
	ev, matched, err := decodeGainsTradeClosed(lg, 0, 0x100, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !matched {
		t.Fatal("expected matched=true for 28-word data")
	}
	if ev.NotionalUSD < 9999 || ev.NotionalUSD > 10001 {
		t.Errorf("notional = %v, want ~10000", ev.NotionalUSD)
	}
}

// mockRPCServer returns a simple JSON-RPC server handling eth_blockNumber and eth_getLogs.
// All eth_getLogs calls return the provided logs slice.
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
		default:
			result = nil
		}
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}
		_ = json.NewEncoder(w).Encode(resp)
	}))
}

func TestGains_FetchLiquidationsSince_HappyPath(t *testing.T) {
	// Build 2 valid liquidation log data blobs for ETH (pair 1 on Base deployment)
	data1 := buildGainsData(1, 10000, 1000000000, 1, 0)
	data2 := buildGainsData(1, 5000, 2000000000, 1, 0)

	logs := []map[string]any{
		{
			"address":          gainsDiamond,
			"topics":           []string{gainsTradeClosedTopic},
			"data":             data1,
			"blockNumber":      "0x64",
			"transactionHash":  "0xtx1",
			"logIndex":         "0x0",
			"removed":          false,
		},
		{
			"address":          gainsDiamond,
			"topics":           []string{gainsTradeClosedTopic},
			"data":             data2,
			"blockNumber":      "0x64",
			"transactionHash":  "0xtx2",
			"logIndex":         "0x1",
			"removed":          false,
		},
	}

	// Use block 100 — small enough that the entire range [1..100] fits in one
	// getLogs call (< gainsMaxLogRangeBlocks=5000), so the server returns the
	// 2 logs exactly once.
	srv := mockRPCServer(t, "0x64", logs) // block 100
	defer srv.Close()

	g := NewGains(srv.URL)
	events, err := g.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
}

func TestGains_FetchLiquidationsSince_RPCError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	g := NewGains(srv.URL)
	_, err := g.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error from RPC failure, got nil")
	}
}

func TestGains_FetchLiquidationsSince_LastBlockAdvances(t *testing.T) {
	srv := mockRPCServer(t, "0x100", []map[string]any{})
	defer srv.Close()

	g := NewGains(srv.URL)
	_, err := g.FetchLiquidationsSince("ETH", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	g.mu.Lock()
	lb := g.lastBlock["ETH"]
	g.mu.Unlock()
	if lb == 0 {
		t.Error("lastBlock should advance after successful fetch")
	}
}

func buildGainsTVResponse(pairs []map[string]any, collaterals []map[string]any) map[string]any {
	return map[string]any{"pairs": pairs, "collaterals": collaterals}
}

func gainsUSDCCollateral(pairOis []map[string]any) map[string]any {
	return map[string]any{"symbol": "USDC", "pairOis": pairOis}
}

func gainsPairOI(oiLong, oiShort string) map[string]any {
	return map[string]any{"collateral": map[string]any{
		"oiLongCollateral":  oiLong,
		"oiShortCollateral": oiShort,
	}}
}

func TestGains_FetchOI_HappyPath(t *testing.T) {
	// pairs: BTC=0, ETH=1 (matches live API ordering)
	// ETH USDC OI: long=28438439935, short=27484847710 → (55923287645)/1e6 ≈ 55923.29 USD
	pairs := []map[string]any{{"from": "BTC"}, {"from": "ETH"}}
	pairOis := []map[string]any{
		gainsPairOI("74229636084", "86846986430"), // BTC
		gainsPairOI("28438439935", "27484847710"), // ETH
	}
	collaterals := []map[string]any{gainsUSDCCollateral(pairOis)}
	body := buildGainsTVResponse(pairs, collaterals)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	g := &Gains{rpcURL: "unused", tradingVarsURL: srv.URL, lastBlock: make(map[string]uint64)}
	oi, err := g.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// (28438439935 + 27484847710) / 1e6 = 55923.287645
	if oi < 55923 || oi > 55924 {
		t.Errorf("OI = %v, want ~55923", oi)
	}
}

func TestGains_FetchOI_AssetCaseInsensitive(t *testing.T) {
	pairs := []map[string]any{{"from": "eth"}}
	pairOis := []map[string]any{gainsPairOI("10000000", "5000000")} // 15 USD
	collaterals := []map[string]any{gainsUSDCCollateral(pairOis)}
	body := buildGainsTVResponse(pairs, collaterals)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	g := &Gains{rpcURL: "unused", tradingVarsURL: srv.URL, lastBlock: make(map[string]uint64)}
	oi, err := g.FetchOI("ETH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// (10000000 + 5000000) / 1e6 = 15
	if oi < 14.9 || oi > 15.1 {
		t.Errorf("OI = %v, want ~15", oi)
	}
}

func TestGains_FetchOI_UnknownAsset(t *testing.T) {
	pairs := []map[string]any{{"from": "BTC"}}
	pairOis := []map[string]any{gainsPairOI("1000000", "1000000")}
	collaterals := []map[string]any{gainsUSDCCollateral(pairOis)}
	body := buildGainsTVResponse(pairs, collaterals)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	g := &Gains{rpcURL: "unused", tradingVarsURL: srv.URL, lastBlock: make(map[string]uint64)}
	_, err := g.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error for unknown asset, got nil")
	}
}

func TestGains_FetchOI_SkipsNonUSDCCollateral(t *testing.T) {
	pairs := []map[string]any{{"from": "ETH"}}
	// Only a non-USDC collateral — should return error (no USDC OI found)
	pairOis := []map[string]any{gainsPairOI("5000000", "3000000")}
	collaterals := []map[string]any{{"symbol": "BtcUSD", "pairOis": pairOis}}
	body := buildGainsTVResponse(pairs, collaterals)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()

	g := &Gains{rpcURL: "unused", tradingVarsURL: srv.URL, lastBlock: make(map[string]uint64)}
	_, err := g.FetchOI("ETH")
	if err == nil {
		t.Fatal("expected error when no USDC collateral found")
	}
}

func TestGains_FetchLiquidationsSince_LastBlockNoAdvanceOnError(t *testing.T) {
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		callCount++
		if req.Method == "eth_blockNumber" {
			resp := map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": "0x100"}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		// eth_getLogs fails
		resp := map[string]any{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"error":   map[string]any{"code": -32000, "message": "getLogs error"},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	g := NewGains(srv.URL)
	_, err := g.FetchLiquidationsSince("ETH", 0)
	if err == nil {
		t.Fatal("expected error from getLogs failure")
	}
	g.mu.Lock()
	lb := g.lastBlock["ETH"]
	g.mu.Unlock()
	if lb != 0 {
		t.Errorf("lastBlock should not advance on error, got %d", lb)
	}
}

func TestGains_FetchLiquidationsSince_UnknownAsset(t *testing.T) {
	g := NewGains("http://unused")
	_, err := g.FetchLiquidationsSince("DOGE", 0)
	if err == nil {
		t.Fatal("expected error for unsupported asset")
	}
}

func init() {
	// Suppress log output in tests
	_ = fmt.Sprintf // keep fmt imported
}
