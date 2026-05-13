package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Gains Network v8 on Base. We read fees and spread directly from the
// PairsStorage facet on the Diamond contract via Base public RPC. No
// hardcoded fee schedule — everything comes from on-chain.
//
// Diamond:    0x6cd5ac19a07518a8092eeffda4f1174c72704eeb (Base mainnet)
// Functions:
//   pairs(uint256)  -> struct, contains spreadP and feeIndex
//   fees(uint256)   -> struct, openFeeP is the first uint256
//
// Asset → pairIndex mapping is read from on-chain pair name strings
// so we don't hardcode it either.

const gainsDiamond = "0x6cd5ac19a07518a8092eeffda4f1174c72704eeb"
// Base RPC. Configurable via RPC_BASE env var to point at a dedicated
// provider (Alchemy, QuickNode, etc.) when public throttling becomes
// an issue. Default mainnet.base.org caps around 10 req/s.
func gainsBaseRPC() string {
	if v := os.Getenv("RPC_BASE"); v != "" {
		return v
	}
	return "https://mainnet.base.org"
}

const selPairs = "0xb91ac788"      // pairs(uint256)
const selFees = "0x4acc79ed"       // fees(uint256)
const selPairsCount = "0x88c64eb8" // pairsCount()

type rpcCall struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResp struct {
	Result string `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func ethCall(client *http.Client, to, data string) (string, error) {
	body, _ := json.Marshal(rpcCall{
		JSONRPC: "2.0", ID: 1, Method: "eth_call",
		Params: []any{map[string]string{"to": to, "data": data}, "latest"},
	})
	req, _ := http.NewRequest("POST", gainsBaseRPC(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var r rpcResp
	if err := json.Unmarshal(respBody, &r); err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return "", fmt.Errorf("rpc: %s", r.Error.Message)
	}
	return r.Result, nil
}

func uint256ArgAt(result string, slotIdx int) *big.Int {
	hexStr := strings.TrimPrefix(result, "0x")
	start := slotIdx * 64
	if start+64 > len(hexStr) {
		return big.NewInt(0)
	}
	n := new(big.Int)
	n.SetString(hexStr[start:start+64], 16)
	return n
}

// extractAsciiString reads a dynamic string at byte offset `byteOffset`
// (relative to the start of the result data, after the leading 0x20).
func extractAsciiString(result string, byteOffset int64) string {
	hexStr := strings.TrimPrefix(result, "0x")
	hdrStart := int(byteOffset) * 2
	if hdrStart+64 > len(hexStr) {
		return ""
	}
	strLen := new(big.Int)
	strLen.SetString(hexStr[hdrStart:hdrStart+64], 16)
	dataStart := hdrStart + 64
	dataEnd := dataStart + int(strLen.Int64())*2
	if dataEnd > len(hexStr) {
		return ""
	}
	bs, err := hex.DecodeString(hexStr[dataStart:dataEnd])
	if err != nil {
		return ""
	}
	return string(bs)
}

type gainsPair struct {
	From     string
	To       string
	SpreadP  *big.Int
	FeeIndex int64
}

func gainsReadPair(client *http.Client, pairIndex int) (*gainsPair, error) {
	idx := fmt.Sprintf("%064x", pairIndex)
	res, err := ethCall(client, gainsDiamond, selPairs+idx)
	if err != nil {
		return nil, err
	}
	fromOff := uint256ArgAt(res, 1).Int64()
	toOff := uint256ArgAt(res, 2).Int64()
	// First slot of result is 0x20 pointing past it; offsets are relative
	// to the start of the struct content.
	from := extractAsciiString(res, fromOff+32)
	to := extractAsciiString(res, toOff+32)
	// Pair struct slot layout (verified against gains.trade UI 2026-05-07):
	//   slot 7  → spreadP   (full bid-ask spread, 1e10 precision)
	//   slot 9  → feeIndex  (the fees(N) tier — was wrongly read at 10 before)
	//   slot 10 → groupIndex
	// Reading slot 9 + applying half-spread (/2) gives the same numbers
	// the gains.trade frontend displays for ETH and BTC.
	return &gainsPair{
		From:     from,
		To:       to,
		SpreadP:  uint256ArgAt(res, 7),
		FeeIndex: uint256ArgAt(res, 9).Int64(),
	}, nil
}

func gainsReadFeeOpenP(client *http.Client, feeIndex int64) (*big.Int, error) {
	idx := fmt.Sprintf("%064x", feeIndex)
	res, err := ethCall(client, gainsDiamond, selFees+idx)
	if err != nil {
		return nil, err
	}
	return uint256ArgAt(res, 0), nil
}

var (
	gainsPairCache     = map[string]*gainsPair{} // by uppercase asset name
	gainsPairIdxCache  = map[string]int{}        // by uppercase asset name
	gainsFeeCache      = map[int64]gainsFeeEntry{}
	gainsCacheMu       sync.Mutex
)

type gainsFeeEntry struct {
	openFeeP *big.Int
	at       time.Time
}

// findGainsPair scans pair indices for a (asset, USD) match. Caches the
// full Pair object — every pair seen during the scan gets cached, so
// running the scan once populates BTC, ETH, LTC, etc. all at once and
// future calls hit the cache directly.
func findGainsPair(client *http.Client, asset string) (*gainsPair, error) {
	upper := strings.ToUpper(asset)

	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()

	gainsScanMu.Lock()
	defer gainsScanMu.Unlock()

	// Re-check after acquiring the scan lock — another goroutine may have
	// just populated the cache while we waited.
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()

	consecutiveErrors := 0
	for i := 0; i < 60; i++ {
		p, err := gainsReadPair(client, i)
		if err != nil {
			consecutiveErrors++
			if consecutiveErrors >= 3 && i > 5 {
				break
			}
			continue
		}
		consecutiveErrors = 0
		if p.From == "" {
			continue
		}
		gainsCacheMu.Lock()
		gainsPairCache[strings.ToUpper(p.From)] = p
		gainsPairIdxCache[strings.ToUpper(p.From)] = i
		gainsCacheMu.Unlock()
		if strings.EqualFold(p.From, asset) && strings.EqualFold(p.To, "USD") {
			return p, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()
	return nil, fmt.Errorf("no pair for %s/USD", asset)
}

var gainsScanMu sync.Mutex

func fetchGains(v VenueConfig, _ string) PerpSample {
	s := PerpSample{Venue: v.Slug, Asset: v.Asset, At: time.Now().UTC().Format(time.RFC3339)}
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}

	pair, err := findGainsPair(client, v.Asset)
	if err != nil {
		s.Err = fmt.Sprintf("find_pair: %v", err)
		s.FetchLatencyMs = time.Since(start).Milliseconds()
		return s
	}

	// Cache the openFeeP for 1h. Gains fee tiers change rarely (governance
	// vote) so polling more often just burns RPC quota. Holding the mutex
	// across the RPC call deduplicates concurrent fetches that share a
	// feeIndex (ETH and BTC both use feeIndex 3).
	gainsCacheMu.Lock()
	cached, ok := gainsFeeCache[pair.FeeIndex]
	var openFeeP *big.Int
	if ok && time.Since(cached.at) < time.Hour {
		openFeeP = cached.openFeeP
		gainsCacheMu.Unlock()
	} else {
		openFeeP, err = gainsReadFeeOpenP(client, pair.FeeIndex)
		if err != nil {
			gainsCacheMu.Unlock()
			s.Err = fmt.Sprintf("read_fee: %v", err)
			s.FetchLatencyMs = time.Since(start).Milliseconds()
			return s
		}
		gainsFeeCache[pair.FeeIndex] = gainsFeeEntry{openFeeP: openFeeP, at: time.Now()}
		gainsCacheMu.Unlock()
	}

	// Gains v8 stores fee values as a percentage with 1e10 precision.
	// 350_000_000 means 0.035% = 3.5 bps. bps = raw / 1e8.
	openFeeF, _ := new(big.Float).Quo(new(big.Float).SetInt(openFeeP), big.NewFloat(1e8)).Float64()
	// spreadP is the FULL bid-ask spread; the taker only crosses half of
	// it, so half-spread = spreadP / (2 × 1e8). gains.trade UI displays
	// this same half-spread (e.g. spreadP=1e8 → 0.005% = 0.5 bps).
	spreadF, _ := new(big.Float).Quo(new(big.Float).SetInt(pair.SpreadP), big.NewFloat(2e8)).Float64()

	s.TakerFeeBps = openFeeF
	s.SpreadBps = spreadF
	s.AllInBps = openFeeF + spreadF
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}
