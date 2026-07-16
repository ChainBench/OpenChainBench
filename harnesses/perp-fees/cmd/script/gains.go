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
//   fees(uint256)   -> struct, first uint256 is totalPositionSizeFeeP
//                      (the open fee; matches the backend fees[] array)
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
	// Surface HTTP-level failures (429 from public Base RPC, 5xx) as such
	// instead of a generic JSON parse error, so classifyErr can bucket them.
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(respBody), 120))
	}
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
	// Pair struct slot layout (re-verified against the gains.trade backend
	// /trading-variables on 2026-07-08):
	//   slot 7 → spreadP    (full bid-ask spread, 1e10 precision)
	//   slot 8 → groupIndex
	//   slot 9 → feeIndex   (the fees(N) tier; ETH and BTC use 13, SOL 11)
	// Reading slot 9 + applying half-spread (/2) matches the backend values
	// exactly (ETH/BTC spreadP=1e8, SOL spreadP=0).
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
	gainsPairCache    = map[string]*gainsPair{} // by uppercase asset name
	gainsPairIdxCache = map[string]int{}        // by uppercase asset name
	gainsPairAt       = map[string]time.Time{}  // last on-chain read per asset
	gainsFeeCache     = map[int64]gainsFeeEntry{}
	gainsCacheMu      sync.Mutex
)

// Pair config (spreadP, feeIndex) changes only by governance, but caching it
// forever would freeze the published spread until a process restart. Re-read
// the known pair index every TTL so config changes surface within hours.
const gainsPairTTL = 6 * time.Hour

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
	cached, ok := gainsPairCache[upper]
	fresh := ok && time.Since(gainsPairAt[upper]) < gainsPairTTL
	idx, hasIdx := gainsPairIdxCache[upper]
	gainsCacheMu.Unlock()
	if fresh {
		return cached, nil
	}

	// Known index, stale cache: re-read that single pair instead of a full
	// scan. On failure we return the error so the cycle skips publishing
	// (visible via fetch_errors_total) rather than silently reusing config
	// that may have changed on-chain.
	if ok && hasIdx {
		p, err := gainsReadPair(client, idx)
		if err != nil {
			return nil, fmt.Errorf("refresh pair %d: %w", idx, err)
		}
		if !strings.EqualFold(p.From, asset) || !strings.EqualFold(p.To, "USD") {
			return nil, fmt.Errorf("pair %d is now %s/%s, expected %s/USD", idx, p.From, p.To, asset)
		}
		gainsCacheMu.Lock()
		gainsPairCache[upper] = p
		gainsPairAt[upper] = time.Now()
		gainsCacheMu.Unlock()
		return p, nil
	}

	gainsScanMu.Lock()
	defer gainsScanMu.Unlock()

	// Re-check after acquiring the scan lock — another goroutine may have
	// just populated the cache while we waited.
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok && time.Since(gainsPairAt[upper]) < gainsPairTTL {
		gainsCacheMu.Unlock()
		return p, nil
	}
	gainsCacheMu.Unlock()

	// Gains v8 has grown well past 60 pairs; a narrow scan silently misses
	// USD-quoted pairs (SOL/USD sits past the first crypto majors) and lets
	// a same-symbol non-USD pair win the cache slot. 200 is enough headroom
	// for the current listed universe with the 3-consecutive-errors early
	// exit still handling the tail.
	consecutiveErrors := 0
	for i := 0; i < 200; i++ {
		p, err := gainsReadPair(client, i)
		if err != nil {
			fmt.Printf("[PERP][gains] pair scan idx %d: %v\n", i, err)
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
		// Only cache USD-quoted pairs. Gains lists cross pairs like SOL/BTC
		// alongside SOL/USD, and keying the cache by From alone would let a
		// non-USD pair (with a different feeIndex/spreadP) win the slot for
		// an asset that also has a USD pair. That was the source of the
		// uniform-4.333-bps SOL bug: SOL's non-USD pair pinned the cache to
		// a crypto-major feeIndex before SOL/USD was reached in the scan.
		if !strings.EqualFold(p.To, "USD") {
			continue
		}
		gainsCacheMu.Lock()
		gainsPairCache[strings.ToUpper(p.From)] = p
		gainsPairIdxCache[strings.ToUpper(p.From)] = i
		gainsPairAt[strings.ToUpper(p.From)] = time.Now()
		gainsCacheMu.Unlock()
		if strings.EqualFold(p.From, asset) {
			return p, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	gainsCacheMu.Lock()
	if p, ok := gainsPairCache[upper]; ok && strings.EqualFold(p.To, "USD") {
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
	// feeIndex (ETH and BTC both use feeIndex 13, SOL uses 11).
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
	// Notional tiers: Gains v8 fees are percentages of position size.
	// totalPositionSizeFeeP and spreadP are both flat rates that do not
	// change with notional (the fees(feeIndex) tier is per pair, not per
	// trade size), so the bps figure is identical at $1k, $10k and $100k.
	// Gains does apply dynamic price impact on pairs with spreadP=0 (SOL),
	// but that value is computed inside the protocol at trade time and is
	// not readable from the on-chain config this harness measures, so we
	// publish the flat rate at every tier rather than invent an impact
	// curve.
	applyFlatTiers(&s)
	s.FetchLatencyMs = time.Since(start).Milliseconds()
	return s
}
